const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const multer = require('multer');
const { generateSamples, SAMPLES_DIR, SIGNATURES } = require('./sample_generator');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1'; // Strictly bound to 127.0.0.1 as required

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.resolve(PROJECT_ROOT, 'bin');
const EXECUTABLE_PATH = path.resolve(BIN_DIR, 'scanner.exe');
const TEMP_UPLOADS_ROOT = path.resolve(PROJECT_ROOT, 'temp_uploads');

// Ensure root directories exist
if (!fs.existsSync(TEMP_UPLOADS_ROOT)) {
  fs.mkdirSync(TEMP_UPLOADS_ROOT, { recursive: true });
}

// Clean up temporary upload directories safely
function cleanupDirectorySync(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[Cleanup Warning] Could not remove ${dirPath}: ${err.message}`);
  }
}

// Startup cleanup of temp_uploads
try {
  const staleDirs = fs.readdirSync(TEMP_UPLOADS_ROOT);
  for (const dir of staleDirs) {
    cleanupDirectorySync(path.join(TEMP_UPLOADS_ROOT, dir));
  }
} catch (e) {}

app.use(express.json());
app.use(express.static(path.resolve(PROJECT_ROOT, 'public')));

// In-memory state for active scan
let activeScan = {
  id: null,
  type: 'samples', // 'samples' or 'upload'
  engine: 'cpp', // 'cpp' or 'defender'
  process: null,
  status: 'idle', // 'idle' | 'running' | 'completed' | 'error' | 'stopped'
  startTime: null,
  endTime: null,
  options: null,
  uploadDir: null,
  metadata: {},
  progress: {
    scanned_files: 0,
    total_files: 0,
    percentage: 0
  },
  workers: {}, // { [workerId]: { id, file, status, count, tasksProcessed, wasActive } }
  results: [], // array of file scan results
  summary: null,
  logs: [],
  error: null
};

// Benchmark state
let activeBenchmark = {
  running: false,
  step: '',
  progress: 0,
  results: null,
  error: null
};

// Multer Storage Engine for per-scan temporary directories supporting multiple files
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.scanId) {
      req.scanId = 'upload_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      req.scanUploadDir = path.join(TEMP_UPLOADS_ROOT, req.scanId);
      try {
        if (!fs.existsSync(req.scanUploadDir)) {
          fs.mkdirSync(req.scanUploadDir, { recursive: true });
        }
      } catch (err) {
        return cb(err);
      }
      req.fileMap = {};
      req.fileIndex = 0;
    }
    cb(null, req.scanUploadDir);
  },
  filename: (req, file, cb) => {
    if (typeof req.fileIndex !== 'number') req.fileIndex = 0;
    const idx = req.fileIndex++;
    // Sanitize extension and assign safe internal filename (never trust client path)
    const rawExt = path.extname(file.originalname || '').slice(0, 16);
    const safeExt = rawExt.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeInternalName = `file_${idx}${safeExt || '.dat'}`;
    if (!req.fileMap) req.fileMap = {};
    req.fileMap[safeInternalName] = file.originalname || `file_${idx}`;
    cb(null, safeInternalName);
  }
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB max per file
    files: 50 // max 50 files per batch
  }
});

// Locate available C++ compiler (cached)
let cachedCompiler = null;
function detectCompiler() {
  if (cachedCompiler) return cachedCompiler;
  const possiblePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'w64devkit', 'bin', 'g++.exe'),
    'C:\\MinGW\\bin\\g++.exe',
    'g++.exe',
    'clang++.exe'
  ];

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        cachedCompiler = { available: true, path: p, type: 'g++' };
        return cachedCompiler;
      }
    } catch (e) {}
  }
  cachedCompiler = { available: false, path: null, type: null };
  return cachedCompiler;
}

// Locate Microsoft Defender CLI (cached)
let cachedDefender = null;
function detectDefender() {
  if (cachedDefender) return cachedDefender;
  const defenderPaths = [
    'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
    'C:\\Program Files (x86)\\Windows Defender\\MpCmdRun.exe'
  ];

  for (const p of defenderPaths) {
    try {
      if (fs.existsSync(p)) {
        cachedDefender = { available: true, path: p, name: 'Microsoft Defender Antivirus CLI' };
        return cachedDefender;
      }
    } catch (e) {}
  }
  cachedDefender = { available: false, path: null, name: null };
  return cachedDefender;
}

// Security: Validate target directory resides strictly inside samples/
function validateTargetDirectory(subDir = '') {
  const normalizedSubDir = path.normalize(subDir || '').replace(/^(\.\.[\/\\])+/, '');
  const targetPath = path.resolve(SAMPLES_DIR, normalizedSubDir);

  // Traversal check
  if (!targetPath.startsWith(SAMPLES_DIR)) {
    throw new Error('Security Error: Target directory must reside strictly within project samples/ directory.');
  }

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target directory does not exist: ${normalizedSubDir}`);
  }

  return targetPath;
}

// -------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------

// System and environment info
app.get('/api/system/info', (req, res) => {
  const compiler = detectCompiler();
  const defender = detectDefender();
  const binaryExists = fs.existsSync(EXECUTABLE_PATH);

  res.json({
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'Generic CPU',
    freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    compiler: {
      detected: compiler.available,
      path: compiler.path,
      type: compiler.type
    },
    defender: {
      available: defender.available,
      path: defender.path,
      name: defender.name
    },
    executable: {
      compiled: binaryExists,
      path: EXECUTABLE_PATH
    },
    samplesDir: SAMPLES_DIR,
    defaultSignatures: Object.values(SIGNATURES),
    maxUploadSizeMb: 25,
    maxBatchSizeMb: 100,
    maxFileCount: 50
  });
});

// Educational harmless test fixture provider
app.get('/api/samples/test-fixture', (req, res) => {
  res.json({
    filename: 'harmless_test_alpha.txt',
    content: '[ThreadShield Test Fixture]\r\nThis is a harmless educational test file.\r\nIt embeds the test pattern: TEST_SIGNATURE_ALPHA\r\nUsed to verify multithreaded signature detection safely without real malware.',
    size: 215,
    type: 'text/plain',
    signature: 'TEST_SIGNATURE_ALPHA',
    description: 'Harmless educational test payload'
  });
});

// Samples directory information
app.get('/api/samples/info', (req, res) => {
  try {
    if (!fs.existsSync(SAMPLES_DIR)) {
      return res.json({ exists: false, totalFiles: 0, totalBytes: 0, files: [] });
    }

    const files = [];
    let totalBytes = 0;

    function walkDir(currentDir, rel = '') {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        const relPath = path.join(rel, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          walkDir(full, relPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(full);
          totalBytes += stats.size;
          files.push({
            name: entry.name,
            path: relPath,
            size: stats.size,
            ext: path.extname(entry.name)
          });
        }
      }
    }

    walkDir(SAMPLES_DIR);
    res.json({
      exists: true,
      totalFiles: files.length,
      totalBytes,
      files: files.slice(0, 100) // preview first 100
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger generation of sample dataset
app.post('/api/samples/generate', (req, res) => {
  try {
    const result = generateSamples();
    res.json({
      success: true,
      message: `Generated ${result.count} test files (${(result.totalBytes / (1024 * 1024)).toFixed(2)} MB)`,
      count: result.count,
      totalBytes: result.totalBytes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start a scan on samples/ directory
app.post('/api/scan/start', (req, res) => {
  if (activeScan.status === 'running') {
    return res.status(409).json({ error: 'A scan is currently running. Stop it before starting a new one.' });
  }

  if (!fs.existsSync(EXECUTABLE_PATH)) {
    return res.status(400).json({
      error: 'Scanner executable (bin/scanner.exe) not found. Please compile the C++ engine first using scripts\\build.bat.'
    });
  }

  const {
    mode = 'parallel',
    workers = 4,
    signatures = Object.values(SIGNATURES),
    extensions = ['.txt', '.log', '.csv'],
    maxSize = 10 * 1024 * 1024,
    dir = ''
  } = req.body;

  let validatedTargetDir;
  try {
    validatedTargetDir = validateTargetDirectory(dir);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const validatedMode = (mode === 'sequential') ? 'sequential' : 'parallel';
  let workerCountNum = 4;
  let workerArg = '4';

  if (workers === 'auto' || workers === '0') {
    workerCountNum = os.cpus().length || 4;
    workerArg = 'auto';
  } else {
    const parsedW = Number(workers);
    workerCountNum = [1, 2, 4, 8].includes(parsedW) ? parsedW : 4;
    workerArg = workerCountNum.toString();
  }

  if (validatedMode === 'sequential') {
    workerCountNum = 1;
    workerArg = '1';
  }

  const validatedMaxSize = Math.max(1024, Number(maxSize) || (10 * 1024 * 1024));

  const args = [
    '--dir', validatedTargetDir,
    '--allowed-root', SAMPLES_DIR,
    '--mode', validatedMode,
    '--workers', workerArg,
    '--signatures', (Array.isArray(signatures) ? signatures.join(',') : signatures),
    '--extensions', (Array.isArray(extensions) ? extensions.join(',') : extensions),
    '--max-size', validatedMaxSize.toString()
  ];

  const scanId = 'scan_samples_' + Date.now();
  initiateScanProcess(scanId, 'samples', 'cpp', args, validatedMode, workerCountNum, {
    mode: validatedMode,
    workers: workerCountNum,
    signatures,
    extensions,
    maxSize: validatedMaxSize,
    dir: validatedTargetDir
  }, null, {}, res);
});

// Secure Upload-and-Scan Endpoint for user-selected local files (supports multiple files)
app.post('/api/scan/upload', (req, res) => {
  if (activeScan.status === 'running') {
    return res.status(409).json({ error: 'A scan is currently running. Please wait or stop the current scan.' });
  }

  // Multer middleware configured for multiple files under 'files' or single 'file'
  const uploadHandler = uploadMiddleware.any();

  uploadHandler(req, res, (err) => {
    if (err) {
      if (req.scanUploadDir) cleanupDirectorySync(req.scanUploadDir);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Upload rejected: Individual file size exceeds the maximum limit of 25 MB.' });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Upload rejected: Batch exceeds maximum limit of 50 files.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }

    const uploadedFiles = req.files || [];
    if (uploadedFiles.length === 0) {
      if (req.scanUploadDir) cleanupDirectorySync(req.scanUploadDir);
      return res.status(400).json({ error: 'No files were provided for scanning. Please select at least one file.' });
    }

    // Check batch total size limit (100 MB)
    const totalBatchBytes = uploadedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBatchBytes > 100 * 1024 * 1024) {
      if (req.scanUploadDir) cleanupDirectorySync(req.scanUploadDir);
      return res.status(400).json({
        error: `Upload rejected: Total batch size (${(totalBatchBytes / (1024 * 1024)).toFixed(2)} MB) exceeds 100 MB limit.`
      });
    }

    const {
      engine = 'cpp', // 'cpp' (Mode A) or 'defender' (Mode B)
      mode = 'parallel',
      workers = 4,
      signatures = Object.values(SIGNATURES),
      maxSize = 25 * 1024 * 1024
    } = req.body;

    // Mode B: Microsoft Defender Engine Scan
    if (engine === 'defender') {
      return runDefenderScan(req.scanId, uploadedFiles, req.fileMap || {}, req.scanUploadDir, res);
    }

    // Mode A: ThreadShield C++ Multithreaded Engine Scan
    if (!fs.existsSync(EXECUTABLE_PATH)) {
      if (req.scanUploadDir) cleanupDirectorySync(req.scanUploadDir);
      return res.status(400).json({
        error: 'Scanner executable (bin/scanner.exe) not found. Please compile the C++ engine first using scripts\\build.bat.'
      });
    }

    const validatedMode = (mode === 'sequential') ? 'sequential' : 'parallel';
    let workerCountNum = 4;
    let workerArg = '4';

    if (workers === 'auto' || workers === '0') {
      workerCountNum = os.cpus().length || 4;
      workerArg = 'auto';
    } else {
      const parsedW = Number(workers);
      workerCountNum = [1, 2, 4, 8].includes(parsedW) ? parsedW : 4;
      workerArg = workerCountNum.toString();
    }

    if (validatedMode === 'sequential') {
      workerCountNum = 1;
      workerArg = '1';
    }

    const validatedMaxSize = Math.min(25 * 1024 * 1024, Math.max(1, Number(maxSize) || (25 * 1024 * 1024)));

    let parsedSignatures = signatures;
    if (typeof signatures === 'string') {
      parsedSignatures = signatures.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(parsedSignatures) || parsedSignatures.length === 0) {
      parsedSignatures = Object.values(SIGNATURES);
    }

    // Build safe argument array for spawn (NEVER shell concatenation)
    // Passes the dedicated temporary directory containing uploaded batch files
    const args = [
      '--dir', req.scanUploadDir,
      '--allowed-root', req.scanUploadDir,
      '--all-extensions',
      '--mode', validatedMode,
      '--workers', workerArg,
      '--signatures', parsedSignatures.join(','),
      '--max-size', validatedMaxSize.toString()
    ];

    const metadata = {
      fileMap: req.fileMap || {},
      fileCount: uploadedFiles.length,
      totalBatchBytes,
      originalFiles: uploadedFiles.map(f => ({
        originalName: f.originalname,
        size: f.size,
        type: f.mimetype
      }))
    };

    initiateScanProcess(req.scanId, 'upload', 'cpp', args, validatedMode, workerCountNum, {
      engine: 'cpp',
      mode: validatedMode,
      workers: workerCountNum,
      signatures: parsedSignatures,
      maxSize: validatedMaxSize,
      fileCount: uploadedFiles.length
    }, req.scanUploadDir, metadata, res);
  });
});

// Common process initiation and lifecycle handling for C++ Engine
function initiateScanProcess(scanId, type, engine, args, mode, workerCount, options, uploadDir, metadata, res) {
  const workerInitMap = {};
  for (let w = 1; w <= workerCount; w++) {
    workerInitMap[w] = { id: w, file: 'Waiting in SafeQueue...', status: 'idle', count: 0, tasksProcessed: 0, wasActive: false };
  }

  activeScan = {
    id: scanId,
    type,
    engine,
    process: null,
    status: 'running',
    startTime: Date.now(),
    endTime: null,
    options,
    uploadDir,
    metadata,
    progress: {
      scanned_files: 0,
      total_files: (type === 'upload' ? (metadata.fileCount || 1) : 0),
      percentage: 0
    },
    workers: workerInitMap,
    results: [],
    summary: null,
    logs: [],
    error: null
  };

  try {
    const child = spawn(EXECUTABLE_PATH, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true
    });

    activeScan.process = child;

    const rl = readline.createInterface({
      input: child.stdout,
      terminal: false
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      activeScan.logs.push(trimmed);
      if (activeScan.logs.length > 450) {
        activeScan.logs.splice(0, 50);
      }

      try {
        const event = JSON.parse(trimmed);
        handleScanEvent(event);
      } catch (e) {}
    });

    child.stderr.on('data', (data) => {
      const errMsg = data.toString();
      console.error(`[Scanner STDERR] ${errMsg}`);
      activeScan.logs.push(`[STDERR] ${errMsg}`);
    });

    child.on('error', (err) => {
      console.error('[Scanner Spawn Error]', err);
      activeScan.status = 'error';
      activeScan.error = `Failed to start process: ${err.message}`;
      activeScan.endTime = Date.now();
      if (uploadDir) cleanupDirectorySync(uploadDir);
    });

    child.on('close', (code) => {
      activeScan.endTime = Date.now();
      if (activeScan.status === 'running') {
        activeScan.status = (code === 0) ? 'completed' : 'error';
        if (code !== 0 && !activeScan.error) {
          activeScan.error = `Scanner process exited with return code ${code}`;
        }
      }
      activeScan.process = null;
      // Clean up temporary upload files immediately after scan finishes
      if (uploadDir) {
        cleanupDirectorySync(uploadDir);
        activeScan.uploadDir = null;
      }
    });

    res.json({
      success: true,
      scanId,
      status: 'running',
      type,
      engine,
      options: activeScan.options,
      metadata: activeScan.metadata
    });
  } catch (err) {
    activeScan.status = 'error';
    activeScan.error = err.message;
    if (uploadDir) cleanupDirectorySync(uploadDir);
    res.status(500).json({ error: err.message });
  }
}

// Map internal sanitized filenames back to user's original filenames
function resolveOriginalName(eventFile) {
  if (activeScan.type === 'upload' && activeScan.metadata && activeScan.metadata.fileMap) {
    const base = path.basename(eventFile).replace(/\\/g, '/');
    if (activeScan.metadata.fileMap[base]) {
      return activeScan.metadata.fileMap[base];
    }
    if (activeScan.metadata.fileMap[eventFile]) {
      return activeScan.metadata.fileMap[eventFile];
    }
  }
  return eventFile;
}

function handleScanEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'init':
      activeScan.progress.total_files = event.total_files || (activeScan.type === 'upload' ? (activeScan.metadata.fileCount || 1) : 0);
      break;

    case 'file_start': {
      const displayName = resolveOriginalName(event.file);
      if (activeScan.workers[event.worker_id]) {
        activeScan.workers[event.worker_id].file = displayName;
        activeScan.workers[event.worker_id].status = 'scanning';
        activeScan.workers[event.worker_id].taskNum = event.task_num || 0;
      }
      break;
    }

    case 'file_done': {
      const displayName = resolveOriginalName(event.file);

      if (activeScan.workers[event.worker_id]) {
        activeScan.workers[event.worker_id].status = 'idle';
        activeScan.workers[event.worker_id].count++;
        activeScan.workers[event.worker_id].file = `Completed: ${path.basename(displayName)}`;
        activeScan.workers[event.worker_id].taskNum = event.task_num || 0;
      }

      // Clarify educational status message
      let statusDesc = event.message;
      if (event.status === 'MATCH') {
        statusDesc = `Test signature matched (${(event.signatures || []).join(', ')})`;
      } else if (event.status === 'CLEAN') {
        statusDesc = 'No configured test signature matched';
      } else if (event.status === 'SKIPPED') {
        statusDesc = 'Skipped: file exceeds configured size limit';
      }

      activeScan.results.push({
        workerId: event.worker_id,
        file: displayName,
        fileSize: event.file_size || 0,
        status: event.status, // "CLEAN", "MATCH", "SKIPPED", "ERROR"
        signatures: event.signatures || [],
        bytesScanned: event.bytes_scanned,
        durationUs: event.duration_us,
        message: statusDesc,
        engine: 'ThreadShield C++17 Multithreaded Engine'
      });
      break;
    }

    case 'progress':
      activeScan.progress.scanned_files = event.scanned_files;
      activeScan.progress.total_files = event.total_files || activeScan.progress.total_files;
      activeScan.progress.percentage = event.percentage;
      break;

    case 'worker_stopped':
      if (activeScan.workers[event.worker_id]) {
        activeScan.workers[event.worker_id].status = 'finished';
        activeScan.workers[event.worker_id].tasksProcessed = event.tasks_processed || 0;
        activeScan.workers[event.worker_id].wasActive = event.was_active;
        if (!event.was_active || event.tasks_processed === 0) {
          activeScan.workers[event.worker_id].file = 'Unassigned / Idle (0 tasks)';
        }
      }
      break;

    case 'summary':
      activeScan.summary = event;
      activeScan.status = 'completed';
      break;

    case 'error':
      activeScan.error = event.message;
      activeScan.status = 'error';
      break;
  }
}

// Mode B: Microsoft Defender Integration Execution
function runDefenderScan(scanId, files, fileMap, uploadDir, res) {
  const defenderInfo = detectDefender();
  if (!defenderInfo.available) {
    cleanupDirectorySync(uploadDir);
    return res.status(400).json({
      error: 'Microsoft Defender CLI (MpCmdRun.exe) was not found on this system. Mode B requires Windows Defender.'
    });
  }

  activeScan = {
    id: scanId,
    type: 'upload',
    engine: 'defender',
    process: null,
    status: 'running',
    startTime: Date.now(),
    endTime: null,
    options: {
      engine: 'defender',
      fileCount: files.length,
      mode: 'sequential',
      workers: 1
    },
    uploadDir,
    metadata: { fileMap },
    progress: {
      scanned_files: 0,
      total_files: files.length,
      percentage: 0
    },
    workers: {
      1: {
        id: 1,
        file: 'Initializing Microsoft Defender Antivirus...',
        status: 'scanning',
        count: 0,
        tasksProcessed: 0,
        wasActive: true
      }
    },
    results: [],
    summary: null,
    logs: [
      `[Defender Engine] Starting scan of ${files.length} file(s) via MpCmdRun.exe -DisableRemediation`,
      `[Defender Engine] Security note: -DisableRemediation ensures files are never quarantined, deleted, or modified.`
    ],
    error: null
  };

  res.json({
    success: true,
    scanId,
    status: 'running',
    type: 'upload',
    engine: 'defender',
    options: activeScan.options
  });

  // Run scans file by file using Microsoft Defender CLI
  (async () => {
    let cleanCount = 0;
    let matchCount = 0;
    let errorCount = 0;
    let totalBytes = 0;

    for (let i = 0; i < files.length; i++) {
      if (activeScan.status === 'stopped') break;

      const f = files[i];
      const origName = fileMap[f.filename] || f.originalname || f.filename;
      const fileSize = f.size || 0;
      totalBytes += fileSize;

      activeScan.workers[1].file = `Defender scanning: ${origName}`;
      activeScan.workers[1].status = 'scanning';
      activeScan.logs.push(`[Defender] Inspecting (${i + 1}/${files.length}): ${origName} (${fileSize} bytes)...`);

      const fileStart = Date.now();
      try {
        const scanRes = await executeDefenderSingleFile(defenderInfo.path, f.path);
        const fileDurationUs = (Date.now() - fileStart) * 1000;

        let status = 'CLEAN';
        let desc = 'Clean: No threats detected by Microsoft Defender (Code 0)';
        if (scanRes.code === 2 || scanRes.threatDetected) {
          status = 'MATCH';
          matchCount++;
          desc = `Threat detected by Microsoft Defender CLI: ${scanRes.details || 'Malware pattern (Exit code 2)'}`;
        } else if (scanRes.code === 0) {
          cleanCount++;
          desc = 'Clean: No threats detected by Microsoft Defender (Exit code 0)';
        } else {
          errorCount++;
          status = 'ERROR';
          desc = `Defender scan returned code ${scanRes.code}: ${scanRes.details}`;
        }

        activeScan.results.push({
          workerId: 1,
          file: origName,
          fileSize,
          status,
          signatures: scanRes.threats || [],
          bytesScanned: fileSize,
          durationUs: fileDurationUs,
          message: desc,
          engine: 'Microsoft Defender Antivirus CLI'
        });

        activeScan.progress.scanned_files = i + 1;
        activeScan.progress.percentage = Math.round(((i + 1) / files.length) * 100);
        activeScan.workers[1].count = i + 1;
        activeScan.workers[1].tasksProcessed = i + 1;
        activeScan.logs.push(`[Defender] ${origName} -> ${status} (${(fileDurationUs / 1000).toFixed(1)} ms)`);
      } catch (err) {
        errorCount++;
        activeScan.results.push({
          workerId: 1,
          file: origName,
          fileSize,
          status: 'ERROR',
          signatures: [],
          bytesScanned: 0,
          durationUs: (Date.now() - fileStart) * 1000,
          message: `Defender execution error: ${err.message}`,
          engine: 'Microsoft Defender Antivirus CLI'
        });
        activeScan.logs.push(`[Defender Error] ${origName}: ${err.message}`);
      }
    }

    activeScan.endTime = Date.now();
    const elapsedSec = Math.max(0.001, (activeScan.endTime - activeScan.startTime) / 1000);
    const elapsedMs = Math.round(elapsedSec * 1000);
    const throughputMb = (totalBytes / (1024 * 1024)) / elapsedSec;

    activeScan.summary = {
      type: 'summary',
      mode: 'defender',
      worker_count: 1,
      active_workers: 1,
      idle_workers: 0,
      total_files: files.length,
      scanned_files: activeScan.results.length,
      clean_files: cleanCount,
      matched_files: matchCount,
      skipped_files: 0,
      error_files: errorCount,
      total_bytes: totalBytes,
      elapsed_ms: elapsedMs,
      throughput_mb_s: Number(throughputMb.toFixed(2)),
      files_per_sec: Number((activeScan.results.length / elapsedSec).toFixed(1)),
      engine: 'Microsoft Defender Antivirus CLI (MpCmdRun.exe)'
    };

    activeScan.workers[1].status = 'finished';
    activeScan.workers[1].file = 'Completed Defender scan batch';
    activeScan.status = 'completed';
    activeScan.logs.push(`[Defender] Completed batch scan: ${matchCount} threat(s), ${cleanCount} clean file(s).`);

    // Clean up temporary upload files immediately after scan finishes
    cleanupDirectorySync(uploadDir);
    activeScan.uploadDir = null;
  })();
}

function executeDefenderSingleFile(defenderExe, filePath) {
  return new Promise((resolve) => {
    const child = spawn(defenderExe, ['-Scan', '-ScanType', '3', '-File', filePath, '-DisableRemediation'], {
      windowsHide: true
    });
    activeScan.process = child;
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      activeScan.process = null;
      const combined = (stdout + ' ' + stderr).trim();
      const threatDetected = code === 2 || combined.toLowerCase().includes('found threats') || combined.toLowerCase().includes('threat detected');
      resolve({
        code,
        output: combined,
        threatDetected,
        details: combined.replace(/\r?\n/g, ' ').slice(0, 200),
        threats: threatDetected ? ['DEFENDER_THREAT_DETECTED'] : []
      });
    });

    child.on('error', err => {
      activeScan.process = null;
      resolve({
        code: -1,
        output: err.message,
        threatDetected: false,
        details: err.message,
        threats: []
      });
    });
  });
}

// Poll scan status
app.get('/api/scan/status', (req, res) => {
  const queuedFiles = Math.max(0, (activeScan.progress.total_files || 0) - (activeScan.progress.scanned_files || 0));
  const scanningFiles = Object.values(activeScan.workers).filter(w => w.status === 'scanning').length;

  res.json({
    id: activeScan.id,
    type: activeScan.type,
    engine: activeScan.engine,
    metadata: activeScan.metadata,
    status: activeScan.status,
    startTime: activeScan.startTime,
    endTime: activeScan.endTime,
    elapsedMs: activeScan.startTime ? ((activeScan.endTime || Date.now()) - activeScan.startTime) : 0,
    progress: {
      ...activeScan.progress,
      queued_files: queuedFiles,
      scanning_files: scanningFiles
    },
    workers: activeScan.workers,
    summary: activeScan.summary,
    resultCount: activeScan.results.length,
    results: activeScan.results,
    recentLogs: activeScan.logs.slice(-30),
    error: activeScan.error
  });
});

// Stop / cancel running scan
app.post('/api/scan/stop', (req, res) => {
  if (activeScan.status === 'running' && activeScan.process) {
    try {
      activeScan.process.kill();
      activeScan.status = 'stopped';
      activeScan.endTime = Date.now();
      if (activeScan.uploadDir) {
        cleanupDirectorySync(activeScan.uploadDir);
        activeScan.uploadDir = null;
      }
      return res.json({ success: true, message: 'Scan cancelled successfully.' });
    } catch (err) {
      return res.status(500).json({ error: `Failed to terminate scan: ${err.message}` });
    }
  }
  res.json({ success: true, message: 'No active scan is currently running.' });
});

// Benchmark execution helper
function runSingleBenchmark(mode, workers) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dir', SAMPLES_DIR,
      '--allowed-root', SAMPLES_DIR,
      '--mode', mode,
      '--workers', workers.toString(),
      '--signatures', Object.values(SIGNATURES).join(','),
      '--extensions', '.txt,.log,.csv',
      '--max-size', (10 * 1024 * 1024).toString()
    ];

    const child = spawn(EXECUTABLE_PATH, args, { cwd: PROJECT_ROOT, windowsHide: true });
    let summary = null;
    let errOutput = '';

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => {
      try {
        const evt = JSON.parse(line.trim());
        if (evt.type === 'summary') {
          summary = evt;
        }
      } catch (e) {}
    });

    child.stderr.on('data', (d) => { errOutput += d.toString(); });

    child.on('close', (code) => {
      if (code === 0 && summary) {
        resolve(summary);
      } else {
        reject(new Error(errOutput || `Benchmark process exited with code ${code}`));
      }
    });

    child.on('error', (err) => reject(err));
  });
}

// Run comparative benchmark suite over samples/
app.post('/api/benchmark/run', async (req, res) => {
  if (activeScan.status === 'running' || activeBenchmark.running) {
    return res.status(409).json({ error: 'A scan or benchmark is already running.' });
  }

  if (!fs.existsSync(EXECUTABLE_PATH)) {
    return res.status(400).json({ error: 'Scanner binary not compiled.' });
  }

  activeBenchmark.running = true;
  activeBenchmark.error = null;
  activeBenchmark.results = null;

  res.json({ success: true, message: 'Benchmark suite initiated.' });

  try {
    const configurations = [
      { mode: 'sequential', workers: 1, label: '1 Thread (Sequential Baseline)' },
      { mode: 'parallel', workers: 2, label: '2 Threads (Parallel)' },
      { mode: 'parallel', workers: 4, label: '4 Threads (Parallel)' },
      { mode: 'parallel', workers: 8, label: '8 Threads (Parallel)' }
    ];

    const benchmarkData = [];
    let baselineElapsed = null;

    for (let i = 0; i < configurations.length; i++) {
      const cfg = configurations[i];
      activeBenchmark.step = `Running ${cfg.label}...`;
      activeBenchmark.progress = Math.round((i / configurations.length) * 100);

      const summary = await runSingleBenchmark(cfg.mode, cfg.workers);
      if (cfg.mode === 'sequential') {
        baselineElapsed = summary.elapsed_ms;
      }

      const speedup = baselineElapsed ? (baselineElapsed / summary.elapsed_ms) : 1.0;
      const efficiency = (speedup / cfg.workers) * 100.0;

      benchmarkData.push({
        label: cfg.label,
        mode: cfg.mode,
        workers: cfg.workers,
        elapsedMs: summary.elapsed_ms,
        throughputMbS: summary.throughput_mb_s,
        filesPerSec: summary.files_per_sec,
        totalBytes: summary.total_bytes,
        scannedFiles: summary.scanned_files,
        speedup: Number(speedup.toFixed(2)),
        efficiency: Number(efficiency.toFixed(1))
      });
    }

    activeBenchmark.progress = 100;
    activeBenchmark.step = 'Benchmark complete';
    activeBenchmark.results = {
      timestamp: new Date().toISOString(),
      dataset: {
        totalFiles: benchmarkData[0].scannedFiles,
        totalBytes: benchmarkData[0].totalBytes
      },
      runs: benchmarkData
    };
  } catch (err) {
    activeBenchmark.error = err.message;
  } finally {
    activeBenchmark.running = false;
  }
});

// Poll benchmark status
app.get('/api/benchmark/status', (req, res) => {
  res.json(activeBenchmark);
});

// Start express server
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`=======================================================`);
    console.log(` ThreadShield — Multithreaded File Scanner Dashboard`);
    console.log(` Operating Systems Concurrent Architecture Project`);
    console.log(` URL: http://${HOST}:${PORT}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
