const fs = require('fs');
const path = require('path');

const SAMPLES_DIR = path.resolve(__dirname, '..', 'samples');

// Harmless educational test signatures
const SIGNATURES = {
  ALPHA: 'TEST_SIGNATURE_ALPHA',
  BETA: 'TEST_SIGNATURE_BETA',
  GAMMA: 'TEST_SIGNATURE_GAMMA',
  DELTA: 'TEST_SIGNATURE_DELTA'
};

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function cleanDirectorySync(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function generateFillerText(paragraphs = 10) {
  const sentences = [
    "The operating system manages hardware resources and coordinates background worker threads.",
    "Mutual exclusion ensures that shared resources are accessed safely by at most one thread at a time.",
    "A thread pool reduces the overhead of frequent thread creation and destruction.",
    "Producer-consumer queues decouple task generation from task execution in concurrent systems.",
    "Amdahl's law defines the theoretical maximum speedup achievable through parallel processing.",
    "Race conditions occur when the output depends on the non-deterministic scheduling of concurrent threads.",
    "Atomic operations and condition variables enable low-latency synchronization without busy waiting.",
    "ThreadShield guarantees isolated analysis within the dedicated workspace environment."
  ];
  let result = [];
  for (let i = 0; i < paragraphs; i++) {
    let p = [];
    for (let j = 0; j < 8; j++) {
      p.push(sentences[(i + j) % sentences.length]);
    }
    result.push(p.join(" "));
  }
  return result.join("\n\n");
}

function generateSamples() {
  console.log(`[SampleGenerator] Initializing samples directory: ${SAMPLES_DIR}`);
  ensureDirSync(SAMPLES_DIR);
  cleanDirectorySync(SAMPLES_DIR);

  const subdirs = [
    '',
    'logs',
    'reports',
    'archives',
    'nested/deep',
    'transactions'
  ];

  for (const sub of subdirs) {
    ensureDirSync(path.join(SAMPLES_DIR, sub));
  }

  const generatedFiles = [];

  function writeFile(relPath, content) {
    const fullPath = path.join(SAMPLES_DIR, relPath);
    ensureDirSync(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content);
    const size = Buffer.byteLength(content);
    generatedFiles.push({ path: relPath, size });
  }

  // 1. Root level clean and signature files
  writeFile('clean_readme.txt', 
    `# ThreadShield Sample Dataset\n\nThis is a harmless clean text file for testing the multithreaded scanner engine.\n${generateFillerText(5)}`
  );

  writeFile('test_detection_alpha.txt',
    `# Security Verification Test\nThis file contains educational test string:\n--> ${SIGNATURES.ALPHA} <--\nUsed to verify scanner pattern matching.\n${generateFillerText(4)}`
  );

  writeFile('system_overview.log',
    `[INFO] 2026-10-29 10:00:00 Kernel boot sequence complete.\n[INFO] Initialized 8 worker threads in pool.\n${generateFillerText(10)}`
  );

  writeFile('security_alert.log',
    `[WARN] 2026-10-29 10:15:22 Pattern detected in audit buffer: ${SIGNATURES.BETA}\n[INFO] Alert flagged for academic simulation.\n${generateFillerText(6)}`
  );

  // 2. Subdirectory: logs
  for (let i = 1; i <= 6; i++) {
    const isDetection = (i === 2 || i === 5);
    const sig = (i === 2) ? SIGNATURES.GAMMA : SIGNATURES.ALPHA;
    const body = isDetection 
      ? `=== AUDIT LOG ENTRY ${i} ===\nMarker: ${sig}\n${generateFillerText(15)}`
      : `=== AUDIT LOG ENTRY ${i} ===\nStatus: NORMAL\n${generateFillerText(20)}`;
    writeFile(`logs/server_worker_${i}.log`, body);
  }

  // 3. Subdirectory: reports (CSVs and text)
  writeFile('reports/quarterly_audit.csv', 
    `id,component,status,notes\n1,Scheduler,PASS,Fair queueing verified\n2,TaskQueue,ALERT,Test signature present: ${SIGNATURES.DELTA}\n3,MemoryManager,PASS,No fragmentation\n4,SyncBarrier,PASS,All workers joined successfully\n`
  );

  writeFile('reports/performance_benchmarks.csv',
    `threads,throughput_mbs,speedup,efficiency\n1,12.4,1.00,100%\n2,23.8,1.92,96%\n4,44.1,3.56,89%\n8,78.5,6.33,79%\n`
  );

  writeFile('reports/clean_summary.txt', generateFillerText(25));

  // 4. Subdirectory: transactions
  for (let i = 1; i <= 4; i++) {
    let rows = ['tx_id,timestamp,amount,status,reference'];
    for (let r = 1000; r < 1100; r++) {
      let ref = (i === 3 && r === 1050) ? `REF_${SIGNATURES.BETA}` : `REF_${r * 13}`;
      const amount = (((r * 9301 + i * 49297) % 233280) / 233280 * 500).toFixed(2);
      rows.push(`${r},2026-10-29T12:00:00Z,${amount},COMPLETED,${ref}`);
    }
    writeFile(`transactions/batch_${i}.csv`, rows.join('\n'));
  }

  // 5. Nested deep directory
  writeFile('nested/deep/isolated_config.txt',
    `# Deep configuration test\nenvironment=isolated\nsafe_mode=true\nmarker=${SIGNATURES.GAMMA}\n`
  );

  writeFile('nested/deep/standard_notes.txt', generateFillerText(8));

  // 6. Non-matching extensions to test extension filtering
  writeFile('archives/backup_data.bin', Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04]));
  writeFile('archives/cache_temp.tmp', `Temporary cache data without target extension.\n${generateFillerText(2)}`);
  writeFile('archives/old_state.bak', `Backup state file.\n${generateFillerText(2)}`);

  // 7. Larger files to simulate real scanning workload (e.g. 500 KB to 1.5 MB)
  const heavyCleanData = generateFillerText(120); // ~100-200KB
  for (let i = 1; i <= 8; i++) {
    // Generate repeated data to create substantial workload for multi-thread scanning
    let repeated = Buffer.alloc(350 * 1024, `[DATA BLOCK ${i}] ` + heavyCleanData.slice(0, 1000));
    // Embed a test signature in one of the heavy files
    if (i === 4) {
      repeated.write(`\n=== EMBEDDED TEST RULE: ${SIGNATURES.DELTA} ===\n`, 50000);
    }
    writeFile(`logs/large_workload_${i}.log`, repeated);
  }

  // 8. One oversized file to test --max-size filtering (e.g. 12 MB)
  const oversizedBuffer = Buffer.alloc(12 * 1024 * 1024, 0x20); // 12 MB of spaces
  oversizedBuffer.write("OVERSIZED_TEST_FILE_START\n", 0);
  oversizedBuffer.write(`\n${SIGNATURES.ALPHA}\n`, 1024 * 1024);
  writeFile('archives/huge_payload.log', oversizedBuffer);

  const totalSize = generatedFiles.reduce((acc, f) => acc + f.size, 0);
  console.log(`[SampleGenerator] Successfully generated ${generatedFiles.length} files (${(totalSize / (1024 * 1024)).toFixed(2)} MB total).`);
  return {
    count: generatedFiles.length,
    totalBytes: totalSize,
    files: generatedFiles
  };
}

if (require.main === module) {
  generateSamples();
}

module.exports = {
  generateSamples,
  SAMPLES_DIR,
  SIGNATURES
};

