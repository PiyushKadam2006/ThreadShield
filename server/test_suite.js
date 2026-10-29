const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXECUTABLE_PATH = path.resolve(PROJECT_ROOT, 'bin', 'scanner.exe');
const SAMPLES_DIR = path.resolve(PROJECT_ROOT, 'samples');

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
  assert(fs.existsSync(path.join(SAMPLES_DIR, 'reports', 'quarterly_audit.csv')), 'reports/quarterly_audit.csv generated');
  assert(fs.existsSync(path.join(SAMPLES_DIR, 'archives', 'huge_payload.log')), 'archives/huge_payload.log (oversized file) generated');

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

  const absoluteRootRes = runScannerSync('--dir C:\\Windows');
  assert(absoluteRootRes.code === 1, 'Absolute external path "C:\\Windows" was rejected (code 1)');

  // TEST SUITE 5: Express Server Integration & Polling API
  console.log('\n--- Test Group 5: Express Backend & REST API Integration ---');
  const TEST_PORT = 3099;
  process.env.PORT = TEST_PORT.toString();
  
  // Start server
  const serverModule = require('./server');
  // Wait 500ms for server to bind
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

  // 5d. Start valid parallel scan via API
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
  assert(scanStartRes.body.scanId !== undefined, 'Received valid scanId');

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

  assert(pollStatus && pollStatus.status === 'completed', 'Scan completed via polling API');
  assert(pollStatus && pollStatus.results && pollStatus.results.length > 0, `Scan returned ${pollStatus.results.length} file results`);
  assert(pollStatus && pollStatus.summary !== null, 'Scan status contains final summary metrics');
  assert(pollStatus && pollStatus.workers && Object.keys(pollStatus.workers).length === 4, 'Status tracked 4 worker thread cards');

  // 5e. Test comparative benchmark endpoint
  console.log('\n--- Test Group 6: Comparative Benchmark Suite ---');
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

