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

function uploadFileRequest(port, filePath, fields = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----ThreadShieldBoundary' + Date.now();
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    let parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileContent);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

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

  // TEST SUITE 3: Standalone C++ Engine Scan Modes & Workers
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

  // 3c. Verify oversized file skipping
  const skippedFile = seqLines.find(l => l.type === 'file_done' && l.file.includes('huge_payload.log'));
  assert(skippedFile && skippedFile.status === 'SKIPPED', 'Oversized file (huge_payload.log) was correctly SKIPPED');

  // 3d. Verify signature matching correctness
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

  // 5b. GET /api/samples/info
  const samplesRes = await httpRequest({ ...reqBase, path: '/api/samples/info', method: 'GET' });
  assert(samplesRes.status === 200, 'GET /api/samples/info returned HTTP 200');
  assert(samplesRes.body.totalFiles > 0, `Samples info reports ${samplesRes.body.totalFiles} files`);

  // 5c. Security check via API: invalid target directory
  const invalidDirRes = await httpRequest({
    ...reqBase,
    path: '/api/scan/start',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { dir: '../../outside' });
  assert(invalidDirRes.status === 400, 'POST /api/scan/start rejected invalid directory traversal with HTTP 400');

  // 5d. Start valid parallel scan via API on samples/
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
  while (attempts < 20) {
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

  // TEST SUITE 6: User File Upload & Scan Workflow
  console.log('\n--- Test Group 6: User File Upload & Scan Workflow ---');

  // 6a. Upload file with TEST_SIGNATURE_ALPHA
  const testAlphaFile = path.join(PROJECT_ROOT, 'test_upload_alpha.txt');
  fs.writeFileSync(testAlphaFile, 'Header data\r\nSpecial payload: TEST_SIGNATURE_ALPHA\r\nFooter details');

  const uploadResAlpha = await uploadFileRequest(TEST_PORT, testAlphaFile, {
    mode: 'parallel',
    workers: '4',
    signatures: 'TEST_SIGNATURE_ALPHA,TEST_SIGNATURE_BETA'
  });
  assert(uploadResAlpha.status === 200, 'POST /api/scan/upload initiated for file with TEST_SIGNATURE_ALPHA (HTTP 200)');
  assert(uploadResAlpha.body.scanId !== undefined, 'Upload returned unique scanId');

  // Poll upload scan status
  let uploadPollAlpha = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const pRes = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    uploadPollAlpha = pRes.body;
    if (uploadPollAlpha.status === 'completed' || uploadPollAlpha.status === 'error') {
      break;
    }
    attempts++;
  }

  assert(uploadPollAlpha && uploadPollAlpha.status === 'completed', 'Uploaded file scan completed via C++ engine');
  assert(uploadPollAlpha && uploadPollAlpha.results && uploadPollAlpha.results.length === 1, 'Exactly 1 file result returned');
  assert(uploadPollAlpha.results[0].status === 'MATCH', 'Uploaded file status is MATCH');
  assert(uploadPollAlpha.results[0].signatures.includes('TEST_SIGNATURE_ALPHA'), 'Matched signature TEST_SIGNATURE_ALPHA identified');
  assert(uploadPollAlpha.results[0].file === 'test_upload_alpha.txt', 'Results table maps back to original filename');

  // 6b. Verify temporary upload directory cleanup
  const remainingUploadDirs = fs.readdirSync(TEMP_UPLOADS_ROOT);
  assert(!remainingUploadDirs.includes(uploadResAlpha.body.scanId), 'Temporary upload directory was securely deleted after scan completion');

  // 6c. Upload clean file with no test signatures
  const testCleanFile = path.join(PROJECT_ROOT, 'test_upload_clean.txt');
  fs.writeFileSync(testCleanFile, 'Normal academic project document without any test signatures.');

  const uploadResClean = await uploadFileRequest(TEST_PORT, testCleanFile, {
    mode: 'sequential',
    workers: '1',
    signatures: 'TEST_SIGNATURE_ALPHA,TEST_SIGNATURE_BETA'
  });
  assert(uploadResClean.status === 200, 'POST /api/scan/upload initiated for clean file (HTTP 200)');

  let uploadPollClean = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const pRes = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    uploadPollClean = pRes.body;
    if (uploadPollClean.status === 'completed' || uploadPollClean.status === 'error') {
      break;
    }
    attempts++;
  }

  assert(uploadPollClean && uploadPollClean.status === 'completed', 'Clean file scan completed');
  assert(uploadPollClean.results[0].status === 'CLEAN', 'Clean file status is CLEAN ("No configured test signature matched")');

  // 6d. Upload binary file (.bin) with embedded null bytes and signature
  const testBinFile = path.join(PROJECT_ROOT, 'test_upload_binary.bin');
  const binPayload = Buffer.concat([
    Buffer.from([0x00, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47, 0x00]),
    Buffer.from('BINARY_STREAM_MARKER_TEST_SIGNATURE_BETA_END'),
    Buffer.from([0x00, 0x01, 0x02, 0xDE, 0xAD, 0xBE, 0xEF])
  ]);
  fs.writeFileSync(testBinFile, binPayload);

  const uploadResBin = await uploadFileRequest(TEST_PORT, testBinFile, {
    mode: 'parallel',
    workers: '4',
    signatures: 'TEST_SIGNATURE_ALPHA,TEST_SIGNATURE_BETA'
  });
  assert(uploadResBin.status === 200, 'POST /api/scan/upload initiated for arbitrary binary file (HTTP 200)');

  let uploadPollBin = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const pRes = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    uploadPollBin = pRes.body;
    if (uploadPollBin.status === 'completed' || uploadPollBin.status === 'error') {
      break;
    }
    attempts++;
  }

  assert(uploadPollBin && uploadPollBin.status === 'completed', 'Binary file scan completed');
  assert(uploadPollBin.results[0].status === 'MATCH', 'Binary file status is MATCH');
  assert(uploadPollBin.results[0].signatures.includes('TEST_SIGNATURE_BETA'), 'Binary stream detected TEST_SIGNATURE_BETA across raw bytes');

  // 6e. Upload with small max size limit to verify SKIPPED status
  const uploadResSize = await uploadFileRequest(TEST_PORT, testBinFile, {
    mode: 'parallel',
    workers: '2',
    maxSize: '10' // file is > 10 bytes
  });
  assert(uploadResSize.status === 200, 'Upload with max-size limit accepted');

  let uploadPollSize = null;
  attempts = 0;
  while (attempts < 25) {
    await sleep(200);
    const pRes = await httpRequest({ ...reqBase, path: '/api/scan/status', method: 'GET' });
    uploadPollSize = pRes.body;
    if (uploadPollSize.status === 'completed' || uploadPollSize.status === 'error') {
      break;
    }
    attempts++;
  }

  assert(uploadPollSize && uploadPollSize.results[0].status === 'SKIPPED', 'File exceeding max-size limit was marked SKIPPED');

  // 6f. Invalid upload request (no file)
  const emptyUploadRes = await httpRequest({
    ...reqBase,
    path: '/api/scan/upload',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {});
  assert(emptyUploadRes.status === 400, 'POST /api/scan/upload rejected request with missing file (HTTP 400)');

  // Clean up temporary local test files
  fs.unlinkSync(testAlphaFile);
  fs.unlinkSync(testCleanFile);
  fs.unlinkSync(testBinFile);

  // TEST SUITE 7: Comparative Benchmark Preservation
  console.log('\n--- Test Group 7: Comparative Benchmark Suite ---');
  const benchRes = await httpRequest({ ...reqBase, path: '/api/benchmark/run', method: 'POST' });
  assert(benchRes.status === 200, 'POST /api/benchmark/run started benchmark');

  let benchPoll = null;
  attempts = 0;
  while (attempts < 30) {
    await sleep(400);
    const bRes = await httpRequest({ ...reqBase, path: '/api/benchmark/status', method: 'GET' });
    benchPoll = bRes.body;
    if (benchPoll.results || benchPoll.error) {
      break;
    }
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
