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

// Clean up any stale temporary upload directories from prior runs
function cleanupDirectorySync(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const full = path.join(dirPath, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          cleanupDirectorySync(full);
          fs.rmdirSync(full);
        } else {
          fs.unlinkSync(full);
        }
      }
      fs.rmdirSync(dirPath);
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
  workers: {}, // { [workerId]: { id, file, status, count } }
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

// Multer Storage Engine for per-scan temporary directories
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const scanId = 'upload_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    req.scanId = scanId;
    const uploadDir = path.join(TEMP_UPLOADS_ROOT, scanId);
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      req.scanUploadDir = uploadDir;
      cb(null, uploadDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Sanitize extension and assign safe internal filename (never trust client path)
    const rawExt = path.extname(file.originalname || '').slice(0, 16);
    const safeExt = rawExt.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeInternalName = 'payload' + (safeExt ? safeExt : '.dat');
    cb(null, safeInternalName);
  }
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25 MB max
  }
});

// Locate available C++ compiler
function detectCompiler() {
  const possiblePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'w64devkit', 'bin', 'g++.exe'),
    'C:\\MinGW\\bin\\g++.exe',
    'g++.exe',
    'clang++.exe'
  ];

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        return { available: true, path: p, type: 'g++' };
      }
    } catch (e) {}
  }
  return { available: false, path: null, type: null };
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
    executable: {
      compiled: binaryExists,
      path: EXECUTABLE_PATH
    },
    samplesDir: SAMPLES_DIR,
    defaultSignatures: Object.values(SIGNATURES),
    maxUploadSizeMb: 25
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
  const workerCount = [1, 2, 4, 8].includes(Number(workers)) ? Number(workers) : 4;
  const validatedMaxSize = Math.max(1024, Number(maxSize) || (10 * 1024 * 1024));

  const args = [
    '--dir', validatedTargetDir,
    '--allowed-root', SAMPLES_DIR,
    '--mode', validatedMode,
    '--workers', workerCount.toString(),
    '--signatures', (Array.isArray(signatures) ? signatures.join(',') : signatures),
    '--extensions', (Array.isArray(extensions) ? extensions.join(',') : extensions),
    '--max-size', validatedMaxSize.toString()
  ];

  const scanId = 'scan_samples_' + Date.now();
  initiateScanProcess(scanId, 'samples', args, validatedMode, workerCount, {
    mode: validatedMode,
    workers: workerCount,
    signatures,
    extensions,
    maxSize: validatedMaxSize,
    dir: validatedTargetDir
  }, null, {}, res);
});

// Secure Upload-and-Scan Endpoint for user-selected local files
app.post('/api/scan/upload', (req, res) => {
  if (activeScan.status === 'running') {
    return res.status(409).json({ error: 'A scan is currently running. Please wait or stop the current scan.' });
  }

  uploadMiddleware.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Upload rejected: File size exceeds the maximum limit of 25 MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }

    if (!req.file) {
      if (req.scanUploadDir) cleanupDirectorySync(req.scanUploadDir);
      return res.status(400).json({ error: 'No file was provided for scanning.' });
    }

    if (!fs.existsSync(EXECUTABLE_PATH)) {
      if (req.scanUploadDir) cleanupDirectorySync(req.scanUploadDir);
      return res.status(400).json({
        error: 'Scanner executable (bin/scanner.exe) not found. Please compile the C++ engine first using scripts\\build.bat.'
      });
    }

    const {
      mode = 'parallel',
      workers = 4,
      signatures = Object.values(SIGNATURES),
      maxSize = 25 * 1024 * 1024
    } = req.body;

    const validatedMode = (mode === 'sequential') ? 'sequential' : 'parallel';
    const workerCount = [1, 2, 4, 8].includes(Number(workers)) ? Number(workers) : 4;
    const validatedMaxSize = Math.min(25 * 1024 * 1024, Math.max(1, Number(maxSize) || (25 * 1024 * 1024)));

    let parsedSignatures = signatures;
    if (typeof signatures === 'string') {
      parsedSignatures = signatures.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(parsedSignatures) || parsedSignatures.length === 0) {
      parsedSignatures = Object.values(SIGNATURES);
    }

    // Build safe argument array for spawn (NEVER shell concatenation)
    const args = [
      '--file', req.file.path,
      '--allowed-root', req.scanUploadDir,
      '--all-extensions',
      '--mode', validatedMode,
      '--workers', workerCount.toString(),
      '--signatures', parsedSignatures.join(','),
      '--max-size', validatedMaxSize.toString()
    ];

    const metadata = {
      originalFilename: req.file.originalname || 'unknown_file',
      originalSize: req.file.size,
      mimetype: req.file.mimetype || 'application/octet-stream'
    };

    initiateScanProcess(req.scanId, 'upload', args, validatedMode, workerCount, {
      mode: validatedMode,
      workers: workerCount,
      signatures: parsedSignatures,
      maxSize: validatedMaxSize,
      file: metadata.originalFilename
    }, req.scanUploadDir, metadata, res);
  });
});

// Common process initiation and lifecycle handling
function initiateScanProcess(scanId, type, args, mode, workerCount, options, uploadDir, metadata, res) {
  const workerInitMap = {};
  for (let w = 1; w <= workerCount; w++) {
    workerInitMap[w] = { id: w, file: 'Waiting...', status: 'idle', count: 0 };
  }

  activeScan = {
    id: scanId,
    type,
    process: null,
    status: 'running',
    startTime: Date.now(),
    endTime: null,
    options,
    uploadDir,
    metadata,
    progress: {
      scanned_files: 0,
      total_files: (type === 'upload' ? 1 : 0),
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
      if (activeScan.logs.length > 300) {
        activeScan.logs.shift();
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

function handleScanEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'init':
      activeScan.progress.total_files = event.total_files || (activeScan.type === 'upload' ? 1 : 0);
      break;

    case 'file_start':
      if (activeScan.workers[event.worker_id]) {
        const displayName = (activeScan.type === 'upload' && activeScan.metadata.originalFilename)
          ? activeScan.metadata.originalFilename
          : event.file;
        activeScan.workers[event.worker_id].file = displayName;
        activeScan.workers[event.worker_id].status = 'scanning';
      }
      break;

    case 'file_done': {
      const displayName = (activeScan.type === 'upload' && activeScan.metadata.originalFilename)
        ? activeScan.metadata.originalFilename
        : event.file;

      if (activeScan.workers[event.worker_id]) {
        activeScan.workers[event.worker_id].status = 'idle';
        activeScan.workers[event.worker_id].count++;
        activeScan.workers[event.worker_id].file = `Completed: ${path.basename(displayName)}`;
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
        message: statusDesc
      });
      break;
    }

    case 'progress':
      activeScan.progress.scanned_files = event.scanned_files;
      activeScan.progress.total_files = event.total_files || (activeScan.type === 'upload' ? 1 : activeScan.progress.total_files);
      activeScan.progress.percentage = event.percentage;
      break;

    case 'worker_stopped':
      if (activeScan.workers[event.worker_id]) {
        activeScan.workers[event.worker_id].status = 'finished';
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

// Poll scan status
app.get('/api/scan/status', (req, res) => {
  res.json({
    id: activeScan.id,
    type: activeScan.type,
    metadata: activeScan.metadata,
    status: activeScan.status,
    startTime: activeScan.startTime,
    endTime: activeScan.endTime,
    elapsedMs: activeScan.startTime ? ((activeScan.endTime || Date.now()) - activeScan.startTime) : 0,
    progress: activeScan.progress,
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

    const child = spawn(EXECUTABLE_PATH, args, { cwd: PROJECT_ROOT });
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
