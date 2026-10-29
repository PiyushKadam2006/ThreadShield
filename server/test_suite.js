const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXECUTABLE_PATH = path.resolve(PROJECT_ROOT, 'bin', 'scanner.exe');
const SAMPLES_DIR = path.resolve(PROJECT_ROOT, 'samples');
const TEMP_UPLOADS_ROOT = path.resolve(PROJECT_ROOT, 'temp_uploads');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    testsPassed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    testsFailed++;
  }
}

function runScannerSync(args) {
  try {
    const stdout = execSync(`"${EXECUTABLE_PATH}" ${args}`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

async function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', err => reject(err));

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function uploadFilesRequest(port, filePaths, fields = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----ThreadShieldBoundary' + Date.now();
    let parts = [];

    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }

    const list = Array.isArray(filePaths) ? filePaths : [filePaths];
    for (const fp of list) {
      const fileContent = fs.readFileSync(fp);
      const fileName = path.basename(fp);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      parts.push(fileContent);
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(parts);

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/scan/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function uploadFileRequest(port, filePath, fields = {}) {
  return uploadFilesRequest(port, [filePath], fields);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log(' ThreadShield Automated Test Suite');
  console.log(' Operating Systems Concurrent Architecture Testing');
  console.log('======================================================\n');

  // TEST SUITE 1: Binary & Environment Verification
  console.log('--- Test Group 1: Binary & Environment ---');
  assert(fs.existsSync(EXECUTABLE_PATH), `C++ Engine binary exists at ${EXECUTABLE_PATH}`);

  // TEST SUITE 2: Sample Generation
  console.log('\n--- Test Group 2: Sample Generation ---');
  const { generateSamples } = require('./sample_generator');
  const genResult = generateSamples();
  assert(fs.existsSync(SAMPLES_DIR), 'samples/ directory created');
  assert(genResult.count >= 20, `Generated ${genResult.count} files (>= 20 expected)`);
  assert(fs.existsSync(path.join(SAMPLES_DIR, 'test_detection_alpha.txt')), 'test_detection_alpha.txt generated');
  assert(fs.existsSync(path.join(SAMPLES_DIR, 'security_alert.log')), 'security_alert.log generated');

  // TEST SUITE 3: Standalone C++ Engine Scan Modes, Workers & Auto Option
  console.log('\n--- Test Group 3: C++ Engine Concurrency & Accuracy ---');
  
  // 3a. Sequential scan (1 worker)
  const seqRes = runScannerSync('--dir samples --mode sequential --workers 1');
  assert(seqRes.code === 0, 'Sequential mode executed successfully (code 0)');
  const seqLines = seqRes.stdout.trim().split('\n').map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
  const seqSummary = seqLines.find(l => l.type === 'summary');
  assert(seqSummary !== undefined, 'Sequential mode produced summary event');
  assert(seqSummary && seqSummary.mode === 'sequential', 'Summary confirms mode: sequential');
  assert(seqSummary && seqSummary.worker_count === 1, 'Summary confirms worker_count: 1');
  assert(seqSummary && seqSummary.matched_files > 0, `Detected ${seqSummary.matched_files} test files in sequential mode`);

  // 3b. Parallel scan with 2, 4, and 8 workers
  for (const w of [2, 4, 8]) {
    const parRes = runScannerSync(`--dir samples --mode parallel --workers ${w}`);
    assert(parRes.code === 0, `Parallel mode with ${w} workers executed successfully`);
    const parLines = parRes.stdout.trim().split('\n').map(l => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    const parSummary = parLines.find(l => l.type === 'summary');
    assert(parSummary !== undefined, `Parallel (${w} workers) produced summary event`);
    assert(parSummary && parSummary.worker_count === w, `Summary reports exact worker_count: ${w}`);
    assert(parSummary && parSummary.total_files === seqSummary.total_files, `Worker count ${w} scanned same total files (${seqSummary.total_files})`);
    assert(parSummary && parSummary.matched_files === seqSummary.matched_files, `Worker count ${w} detected same number of matches (${seqSummary.matched_files})`);
  }

  // 3c. Auto worker option
  const autoRes = runScannerSync('--dir samples --mode parallel --workers auto');
  assert(autoRes.code === 0, 'Parallel mode with --workers auto executed successfully');
  const autoLines = autoRes.stdout.trim().split('\n').map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
  const autoSummary = autoLines.find(l => l.type === 'summary');
  assert(autoSummary && autoSummary.worker_count > 0, `Auto mode configured ${autoSummary?.worker_count} workers matching hardware`);

  // 3d. Verify oversized file skipping
  const skippedFile = seqLines.find(l => l.type === 'file_done' && l.file.includes('huge_payload.log'));
  assert(skippedFile && skippedFile.status === 'SKIPPED', 'Oversized file (huge_payload.log) was correctly SKIPPED');

  // 3e. Verify signature matching correctness
  const alphaMatch = seqLines.find(l => l.type === 'file_done' && l.file.includes('test_detection_alpha.txt'));
  assert(alphaMatch && alphaMatch.status === 'MATCH', 'test_detection_alpha.txt correctly identified as MATCH');
  assert(alphaMatch && alphaMatch.signatures.includes('TEST_SIGNATURE_ALPHA'), 'test_detection_alpha.txt matched TEST_SIGNATURE_ALPHA');

  // TEST SUITE 4: Security & Path Traversal Prevention
  console.log('\n--- Test Group 4: Path Traversal & Security Constraints ---');
  const traversalRes1 = runScannerSync('--dir ..');
  assert(traversalRes1.code === 1, 'Path traversal attempt with ".." was rejected (code 1)');
  assert(traversalRes1.stdout.includes('Security violation'), 'C++ output contains security violation message for ".."');

  const traversalRes2 = runScannerSync('--dir ../..');
  assert(traversalRes2.code === 1, 'Deep path traversal attempt with "../.." was rejected (code 1)');

  const absoluteRootRes = runScannerSync('--allowed-root C:\\Windows');
  assert(absoluteRootRes.code === 1, 'Absolute external root "C:\\Windows" was rejected (code 1)');

  // TEST SUITE 5: Express Server Integration & Polling API
  console.log('\n--- Test Group 5: Express Backend & REST API Integration ---');
  const TEST_PORT = 3099;
  process.env.PORT = TEST_PORT.toString();
  
  // Start server
  const server = require('./server');
  const serverInstance = server.listen(TEST_PORT, '127.0.0.1');
  await sleep(600);

  const reqBase = {
    hostname: '127.0.0.1',
    port: TEST_PORT,
    timeout: 5000
  };

  // 5a. GET /api/system/info
  const sysRes = await httpRequest({ ...reqBase, path: '/api/system/info', method: 'GET' });
  assert(sysRes.status === 200, 'GET /api/system/info returned HTTP 200');
  assert(sysRes.body.compiler && sysRes.body.compiler.detected, 'System info detects compiler');
  assert(sysRes.body.executable && sysRes.body.executable.compiled, 'System info confirms executable compiled');
  assert(sysRes.body.defender !== undefined, 'System info includes defender discovery object');
  assert(sysRes.body.maxBatchSizeMb === 100, 'System info reports 100 MB max batch size');

  // 5b. GET /api/samples/test-fixture
  const fixtureRes = await httpRequest({ ...reqBase, path: '/api/samples/test-fixture', method: 'GET' });
  assert(fixtureRes.status === 200, 'GET /api/samples/test-fixture returned HTTP 200');
  assert(fixtureRes.body.signature === 'TEST_SIGNATURE_ALPHA', 'Test fixture contains TEST_SIGNATURE_ALPHA');

  // 5c. GET /api/samples/info
  const samplesRes = await httpRequest({ ...reqBase, path: '/api/samples/info', method: 'GET' });
  assert(samplesRes.status === 200, 'GET /api/samples/info returned HTTP 200');
  assert(samplesRes.body.totalFiles > 0, `Samples info reports ${samplesRes.body.totalFiles} files`);

  // 5d. Security check via API: invalid target directory
  const invalidDirRes = await httpRequest({
    ...reqBase,
    path: '/api/scan/start',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { dir: '../../outside' });
  assert(invalidDirRes.status === 400, 'POST /api/scan/start rejected invalid directory traversal with HTTP 400');

  // 5e. Start valid parallel scan via API on samples/
  const scanStartRes = await httpRequest({
    ...reqBase,
    path: '/api/scan/start',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    mode: 'parallel',
    workers: 4,
    signatures: ['TEST_SIGNATURE_ALPHA', 'TEST_SIGNATURE_BETA'],
    extensions: ['.txt', '.log', '.csv'],
    maxSize: 10485760
  });
  assert(scanStartRes.status === 200, 'POST /api/scan/start initiated scan with HTTP 200');

  // Poll scan status until completed
  let pollStatus = null;
  let attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const pollRes = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    pollStatus = pollRes.body;
    if (pollStatus.status === 'completed' || pollStatus.status === 'error') {
      break;
    }
    attempts++;
  }

  assert(pollStatus && pollStatus.status === 'completed', 'Samples scan completed via polling API');
  assert(pollStatus && pollStatus.results && pollStatus.results.length > 0, `Scan returned ${pollStatus.results.length} file results`);

  // TEST SUITE 6: Multi-File Upload & Scan Workflow (Mode A)
  console.log('\n--- Test Group 6: Multi-File Upload & C++ Engine Workflows ---');

  // 6a. Create multiple temporary test files
  const fileAlpha = path.join(PROJECT_ROOT, 'test_batch_alpha.txt');
  const fileBeta = path.join(PROJECT_ROOT, 'test_batch_beta.log');
  const fileClean1 = path.join(PROJECT_ROOT, 'test_batch_clean1.txt');
  const fileClean2 = path.join(PROJECT_ROOT, 'test_batch_clean2.csv');
  const fileClean3 = path.join(PROJECT_ROOT, 'test_batch_clean3.txt');

  fs.writeFileSync(fileAlpha, 'Alpha document containing TEST_SIGNATURE_ALPHA payload.');
  fs.writeFileSync(fileBeta, 'Log file record: marker TEST_SIGNATURE_BETA observed.');
  fs.writeFileSync(fileClean1, 'Clean research note about operating systems thread synchronization.');
  fs.writeFileSync(fileClean2, 'id,name,value\n1,process,active\n2,thread,running\n');
  fs.writeFileSync(fileClean3, 'Another completely benign text file for testing multithreading.');

  // Test 6b: Dynamic Batching (5 files with 2 workers -> files > workers)
  const batchRes1 = await uploadFilesRequest(TEST_PORT, [fileAlpha, fileBeta, fileClean1, fileClean2, fileClean3], {
    engine: 'cpp',
    mode: 'parallel',
    workers: '2',
    signatures: 'TEST_SIGNATURE_ALPHA,TEST_SIGNATURE_BETA'
  });
  assert(batchRes1.status === 200, 'POST /api/scan/upload accepted 5 files with 2 workers (HTTP 200)');

  let pollBatch1 = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const p = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    pollBatch1 = p.body;
    if (pollBatch1.status === 'completed' || pollBatch1.status === 'error') break;
    attempts++;
  }

  assert(pollBatch1 && pollBatch1.status === 'completed', 'Batch 1 (5 files > 2 workers) scan completed');
  assert(pollBatch1 && pollBatch1.results.length === 5, 'All 5 files processed in batch');
  assert(pollBatch1.summary && pollBatch1.summary.active_workers === 2, 'Summary reports 2 active workers');
  assert(pollBatch1.summary && pollBatch1.summary.matched_files === 2, 'Summary reports 2 matched files (Alpha + Beta)');
  assert(pollBatch1.summary && pollBatch1.summary.clean_files === 3, 'Summary reports 3 clean files');

  // Verify file name mapping
  const alphaResObj = pollBatch1.results.find(r => r.file === 'test_batch_alpha.txt');
  assert(alphaResObj && alphaResObj.status === 'MATCH', 'test_batch_alpha.txt status is MATCH');
  assert(alphaResObj && alphaResObj.signatures.includes('TEST_SIGNATURE_ALPHA'), 'test_batch_alpha.txt matched TEST_SIGNATURE_ALPHA');

  // Test 6c: Idle Worker Verification (2 files with 4 workers -> files < workers)
  const batchRes2 = await uploadFilesRequest(TEST_PORT, [fileAlpha, fileClean1], {
    engine: 'cpp',
    mode: 'parallel',
    workers: '4',
    signatures: 'TEST_SIGNATURE_ALPHA'
  });
  assert(batchRes2.status === 200, 'POST /api/scan/upload accepted 2 files with 4 workers (HTTP 200)');

  let pollBatch2 = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const p = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    pollBatch2 = p.body;
    if (pollBatch2.status === 'completed' || pollBatch2.status === 'error') break;
    attempts++;
  }

  assert(pollBatch2 && pollBatch2.status === 'completed', 'Batch 2 (2 files < 4 workers) scan completed');
  assert(pollBatch2.summary && pollBatch2.summary.worker_count === 4, 'Summary reports worker_count: 4');
  assert(pollBatch2.summary && pollBatch2.summary.active_workers === 2, 'Summary reports active_workers: 2');
  assert(pollBatch2.summary && pollBatch2.summary.idle_workers === 2, 'Summary correctly reports idle_workers: 2');

  // Verify worker status reflects idle / unassigned
  const idleWorkers = Object.values(pollBatch2.workers).filter(w => !w.wasActive || w.tasksProcessed === 0);
  assert(idleWorkers.length === 2, 'Exactly 2 workers marked idle/unassigned');

  // Test 6d: Binary file upload with null bytes
  const testBinFile = path.join(PROJECT_ROOT, 'test_batch_binary.bin');
  const binPayload = Buffer.concat([
    Buffer.from([0x00, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47, 0x00]),
    Buffer.from('BINARY_PAYLOAD_TEST_SIGNATURE_BETA_STREAM_DATA'),
    Buffer.from([0x00, 0x01, 0x02, 0xDE, 0xAD, 0xBE, 0xEF])
  ]);
  fs.writeFileSync(testBinFile, binPayload);

  const binUploadRes = await uploadFilesRequest(TEST_PORT, [testBinFile], {
    engine: 'cpp',
    mode: 'parallel',
    workers: '2',
    signatures: 'TEST_SIGNATURE_BETA'
  });
  assert(binUploadRes.status === 200, 'POST /api/scan/upload accepted arbitrary binary file (HTTP 200)');

  let pollBin = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const p = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    pollBin = p.body;
    if (pollBin.status === 'completed' || pollBin.status === 'error') break;
    attempts++;
  }
  assert(pollBin && pollBin.results[0].status === 'MATCH', 'Binary file detected TEST_SIGNATURE_BETA across raw bytes');

  // Test 6e: Max size limit enforcement (oversized file skipped)
  const sizeUploadRes = await uploadFilesRequest(TEST_PORT, [testBinFile], {
    engine: 'cpp',
    mode: 'parallel',
    workers: '2',
    maxSize: '15' // 15 bytes limit (file is > 15 bytes)
  });
  assert(sizeUploadRes.status === 200, 'Upload with 15 bytes max size limit accepted');

  let pollSize = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const p = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    pollSize = p.body;
    if (pollSize.status === 'completed' || pollSize.status === 'error') break;
    attempts++;
  }
  assert(pollSize && pollSize.results[0].status === 'SKIPPED', 'File exceeding max-size limit was marked SKIPPED');

  // 6f. Verify temporary upload directory cleanup
  const remainingUploadDirs = fs.readdirSync(TEMP_UPLOADS_ROOT);
  assert(remainingUploadDirs.length === 0, 'All temporary upload directories cleaned up after scans');

  // TEST SUITE 7: Mode B - Microsoft Defender CLI Integration
  console.log('\n--- Test Group 7: Mode B - Microsoft Defender CLI Integration ---');
  if (sysRes.body.defender && sysRes.body.defender.available) {
    const defRes = await uploadFilesRequest(TEST_PORT, [fileClean1], {
      engine: 'defender'
    });
    assert(defRes.status === 200, 'POST /api/scan/upload accepted Defender scan request (HTTP 200)');

    let pollDef = null;
    attempts = 0;
    while (attempts < 30) {
      await sleep(400);
      const p = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
      pollDef = p.body;
      if (pollDef.status === 'completed' || pollDef.status === 'error') break;
      attempts++;
    }

    assert(pollDef && pollDef.status === 'completed', 'Microsoft Defender scan completed');
    assert(pollDef && pollDef.summary && pollDef.summary.mode === 'defender', 'Summary confirms mode: defender');
    assert(pollDef.results && pollDef.results[0].status === 'CLEAN', 'Clean file returned status CLEAN via Defender');
    assert(pollDef.results[0].engine.includes('Microsoft Defender'), 'Result specifies Microsoft Defender engine');
  } else {
    console.log('  [SKIP] Microsoft Defender CLI not present on host environment');
  }

  // Clean up temporary local test files
  fs.unlinkSync(fileAlpha);
  fs.unlinkSync(fileBeta);
  fs.unlinkSync(fileClean1);
  fs.unlinkSync(fileClean2);
  fs.unlinkSync(fileClean3);
  fs.unlinkSync(testBinFile);

  // TEST SUITE 8: Comparative Benchmark Preservation
  console.log('\n--- Test Group 8: Comparative Benchmark Suite ---');
  const benchRes = await httpRequest({ ...reqBase, path: '/api/benchmark/run', method: 'POST' });
  assert(benchRes.status === 200, 'POST /api/benchmark/run started benchmark');

  let benchPoll = null;
  attempts = 0;
  while (attempts < 30) {
    await sleep(400);
    const bRes = await httpRequest({ ...reqBase, path: '/api/benchmark/status', method: 'GET' });
    benchPoll = bRes.body;
    if (benchPoll.results || benchPoll.error) break;
    attempts++;
  }

  assert(benchPoll && benchPoll.results !== null, 'Benchmark completed and returned comparative results');
  if (benchPoll && benchPoll.results && benchPoll.results.runs) {
    console.log('\n  [BENCHMARK RESULTS TABLE]');
    console.table(benchPoll.results.runs.map(r => ({
      Mode: r.mode,
      Workers: r.workers,
      'Time (ms)': r.elapsedMs,
      'Throughput (MB/s)': r.throughputMbS,
      Speedup: `${r.speedup}x`,
      Efficiency: `${r.efficiency}%`
    })));
  }

  serverInstance.close();

  // Summary
  console.log('\n======================================================');
  console.log(` Test Results: ${testsPassed} Passed, ${testsFailed} Failed`);
  console.log('======================================================\n');

  process.exit(testsFailed === 0 ? 0 : 1);
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
