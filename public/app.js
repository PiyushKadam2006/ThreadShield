// ThreadShield Frontend Controller
document.addEventListener('DOMContentLoaded', () => {
  // Application State
  const state = {
    activeTab: 'upload', // 'upload' or 'samples'
    engine: 'cpp', // 'cpp' (Mode A) or 'defender' (Mode B)
    selectedFiles: [], // Array of File objects
    mode: 'parallel',
    workers: 4, // 1, 2, 4, 8, or 'auto'
    signatures: ['TEST_SIGNATURE_ALPHA', 'TEST_SIGNATURE_BETA', 'TEST_SIGNATURE_GAMMA', 'TEST_SIGNATURE_DELTA'],
    extensions: ['.txt', '.log', '.csv'],
    maxSize: 26214400, // 25 MB
    pollInterval: null,
    benchmarkPollInterval: null,
    allResults: [],
    system: null
  };

  // DOM Elements
  const el = {
    engineStatus: document.getElementById('engine-status'),
    compilerInfo: document.getElementById('compiler-info'),
    defenderStatus: document.getElementById('defender-status'),
    cpuCores: document.getElementById('cpu-cores'),
    autoCoresHint: document.getElementById('auto-cores-hint'),
    datasetFilesCount: document.getElementById('dataset-files-count'),
    datasetBytesSize: document.getElementById('dataset-bytes-size'),

    tabBtnUpload: document.getElementById('tab-btn-upload'),
    tabBtnSamples: document.getElementById('tab-btn-samples'),
    sectionUpload: document.getElementById('section-upload'),
    sectionSamples: document.getElementById('section-samples'),
    uploadActions: document.getElementById('upload-actions'),
    samplesActions: document.getElementById('samples-actions'),

    cardEngineCpp: document.getElementById('card-engine-cpp'),
    cardEngineDefender: document.getElementById('card-engine-defender'),
    concurrencyControls: document.getElementById('concurrency-controls'),
    signaturesGroup: document.getElementById('signatures-group'),
    startScanBtnLabel: document.getElementById('start-scan-btn-label'),

    fileDropzone: document.getElementById('file-dropzone'),
    userFileInput: document.getElementById('user-file-input'),
    dropzonePrompt: document.getElementById('dropzone-prompt'),
    selectedFilesContainer: document.getElementById('selected-files-container'),
    batchStats: document.getElementById('batch-stats'),
    filesList: document.getElementById('files-list'),
    btnAddMore: document.getElementById('btn-add-more'),
    btnLoadFixture: document.getElementById('btn-load-fixture'),
    btnLoadFixtureTop: document.getElementById('btn-load-fixture-top'),
    btnClearAll: document.getElementById('btn-clear-all'),

    btnModeParallel: document.getElementById('btn-mode-parallel'),
    btnModeSequential: document.getElementById('btn-mode-sequential'),
    workerPills: document.getElementById('worker-pills'),
    workerCountGroup: document.getElementById('worker-count-group'),
    pillAuto: document.getElementById('pill-auto'),
    maxFileSize: document.getElementById('max-file-size'),

    btnStartUploadScan: document.getElementById('btn-start-upload-scan'),
    btnStartSamplesScan: document.getElementById('btn-start-samples-scan'),
    btnStopScan: document.getElementById('btn-stop-scan'),
    btnRunBenchmark: document.getElementById('btn-run-benchmark'),
    btnGenerateSamples: document.getElementById('btn-generate-samples'),

    metricTime: document.getElementById('metric-time'),
    metricThroughput: document.getElementById('metric-throughput'),
    metricQueueStatus: document.getElementById('metric-queue-status'),
    metricBytes: document.getElementById('metric-bytes'),
    metricMatches: document.getElementById('metric-matches'),
    metricClean: document.getElementById('metric-clean'),

    scanStateBadge: document.getElementById('scan-state-badge'),
    progressText: document.getElementById('progress-text'),
    progressBarFill: document.getElementById('progress-bar-fill'),

    activeWorkerBadge: document.getElementById('active-worker-badge'),
    workerGrid: document.getElementById('worker-grid'),

    benchmarkPanel: document.getElementById('benchmark-panel'),
    benchmarkTableBody: document.getElementById('benchmark-table-body'),
    benchmarkStatusBadge: document.getElementById('benchmark-status-badge'),

    resultSearch: document.getElementById('result-search'),
    resultFilter: document.getElementById('result-filter'),
    resultsTbody: document.getElementById('results-tbody'),

    terminalLogs: document.getElementById('terminal-logs'),
    logCount: document.getElementById('log-count'),
    toast: document.getElementById('toast')
  };

  // Toast Notification
  function showToast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.style.borderColor = isError ? 'var(--coral)' : 'var(--cyan)';
    el.toast.classList.remove('hidden');
    setTimeout(() => {
      el.toast.classList.add('hidden');
    }, 4500);
  }

  // Format Bytes Utility
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Load System & Environment Info
  async function loadSystemInfo() {
    try {
      const res = await fetch('/api/system/info');
      const data = await res.json();
      state.system = data;

      const logicalCores = data.cpus || 4;
      el.cpuCores.textContent = `${logicalCores} Logical Cores (${data.cpuModel})`;
      if (el.pillAuto) {
        el.pillAuto.textContent = `Auto (${logicalCores})`;
        el.autoCoresHint.textContent = `Auto = ${logicalCores} logical CPU cores`;
      }

      if (data.compiler && data.compiler.detected) {
        el.compilerInfo.textContent = `${data.compiler.type} (${data.compiler.path})`;
      } else {
        el.compilerInfo.textContent = 'None detected';
        el.compilerInfo.classList.add('missing');
      }

      if (data.defender && data.defender.available) {
        el.defenderStatus.textContent = 'MpCmdRun.exe Ready';
        el.defenderStatus.classList.add('ready');
      } else {
        el.defenderStatus.textContent = 'Not available';
        el.defenderStatus.classList.add('missing');
      }

      if (data.executable && data.executable.compiled) {
        el.engineStatus.textContent = 'Engine Ready (scanner.exe)';
        el.engineStatus.classList.add('ready');
      } else {
        el.engineStatus.textContent = 'Not compiled (Run scripts/build.bat)';
        el.engineStatus.classList.add('missing');
      }
    } catch (e) {
      console.error('System info fetch error:', e);
    }
  }

  async function loadSamplesInfo() {
    try {
      const res = await fetch('/api/samples/info');
      const data = await res.json();
      if (data.exists) {
        el.datasetFilesCount.textContent = data.totalFiles;
        el.datasetBytesSize.textContent = formatBytes(data.totalBytes);
      }
    } catch (e) {
      console.error('Samples info fetch error:', e);
    }
  }

  async function generateSamplesDataset() {
    try {
      showToast('Generating test sample dataset in samples/...');
      const res = await fetch('/api/samples/generate', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message);
        el.datasetFilesCount.textContent = data.count;
        el.datasetBytesSize.textContent = formatBytes(data.totalBytes);
      } else {
        showToast(`Failed to generate samples: ${data.error}`, true);
      }
    } catch (e) {
      showToast(`Network error generating samples: ${e.message}`, true);
    }
  }

  // Tab Switching
  function switchTab(targetTab) {
    state.activeTab = targetTab;
    if (targetTab === 'upload') {
      el.tabBtnUpload.classList.add('active');
      el.tabBtnSamples.classList.remove('active');
      el.sectionUpload.classList.add('active');
      el.sectionSamples.classList.remove('active');
      el.uploadActions.classList.remove('hidden');
      el.samplesActions.classList.add('hidden');
    } else {
      el.tabBtnSamples.classList.add('active');
      el.tabBtnUpload.classList.remove('active');
      el.sectionSamples.classList.add('active');
      el.sectionUpload.classList.remove('active');
      el.samplesActions.classList.remove('hidden');
      el.uploadActions.classList.add('hidden');
      loadSamplesInfo();
    }
  }

  // Engine Mode Selection (Mode A: C++ vs Mode B: Defender)
  function setEngineMode(engine) {
    state.engine = engine;
    if (engine === 'cpp') {
      el.cardEngineCpp.classList.add('active');
      el.cardEngineDefender.classList.remove('active');
      el.concurrencyControls.style.display = 'block';
      el.startScanBtnLabel.textContent = 'Start Multithreaded Scan (C++17 Engine)';
      initWorkerCards(getEffectiveWorkerCount());
    } else {
      el.cardEngineDefender.classList.add('active');
      el.cardEngineCpp.classList.remove('active');
      el.concurrencyControls.style.display = 'none';
      el.startScanBtnLabel.textContent = 'Start Microsoft Defender Scan (CLI)';
      initWorkerCards(1, 'Microsoft Defender CLI');
    }
  }

  // Multiple File Selection Handling
  function addFilesToSelection(fileList) {
    if (!fileList || fileList.length === 0) return;

    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
    const MAX_BATCH_SIZE = 100 * 1024 * 1024; // 100 MB
    const MAX_FILE_COUNT = 50;

    let addedCount = 0;
    let rejectedOversize = 0;

    const filesArray = Array.from(fileList);
    for (const file of filesArray) {
      if (state.selectedFiles.length >= MAX_FILE_COUNT) {
        showToast(`Maximum batch limit of ${MAX_FILE_COUNT} files reached.`, true);
        break;
      }

      if (file.size > MAX_FILE_SIZE) {
        rejectedOversize++;
        continue;
      }

      // Check current total batch size
      const currentBatchBytes = state.selectedFiles.reduce((sum, f) => sum + f.size, 0);
      if (currentBatchBytes + file.size > MAX_BATCH_SIZE) {
        showToast(`Total batch size limit of 100 MB exceeded.`, true);
        break;
      }

      // Avoid exact duplicate file entries
      const alreadyExists = state.selectedFiles.some(f => 
        f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
      );

      if (!alreadyExists) {
        state.selectedFiles.push(file);
        addedCount++;
      }
    }

    if (rejectedOversize > 0) {
      showToast(`${rejectedOversize} file(s) exceeded the 25 MB per-file limit and were skipped.`, true);
    } else if (addedCount > 0) {
      showToast(`Added ${addedCount} file(s) to scan queue.`);
    }

    renderSelectedFilesList();
  }

  function removeFileByIndex(index) {
    if (index >= 0 && index < state.selectedFiles.length) {
      const removed = state.selectedFiles.splice(index, 1)[0];
      showToast(`Removed ${removed.name} from queue.`);
      renderSelectedFilesList();
    }
  }

  function clearAllFiles() {
    state.selectedFiles = [];
    el.userFileInput.value = '';
    renderSelectedFilesList();
    showToast('Cleared all selected files.');
  }

  // Load Harmless Educational Test Fixture
  async function loadTestFixture() {
    try {
      const fixturePayload = 
`[ThreadShield Educational Test Fixture]
Timestamp: ${new Date().toISOString()}
Target Marker: TEST_SIGNATURE_ALPHA
Note: This is a harmless academic test payload generated to demonstrate multithreaded signature pattern detection safely without actual malware.`;

      const fixtureFile = new File([fixturePayload], `harmless_test_alpha_${Date.now().toString().slice(-4)}.txt`, {
        type: 'text/plain',
        lastModified: Date.now()
      });

      addFilesToSelection([fixtureFile]);
      showToast('Loaded harmless educational test fixture (TEST_SIGNATURE_ALPHA).');
    } catch (e) {
      showToast(`Error creating fixture: ${e.message}`, true);
    }
  }

  // Render Selected Files Queue
  function renderSelectedFilesList() {
    if (state.selectedFiles.length === 0) {
      el.selectedFilesContainer.classList.add('hidden');
      el.dropzonePrompt.classList.remove('hidden');
      el.metricQueueStatus.textContent = '0 / 0';
      return;
    }

    el.selectedFilesContainer.classList.remove('hidden');
    el.dropzonePrompt.classList.add('hidden');

    const totalBytes = state.selectedFiles.reduce((sum, f) => sum + f.size, 0);
    el.batchStats.textContent = `${state.selectedFiles.length} file(s) selected • ${formatBytes(totalBytes)} / 100 MB max`;
    el.metricQueueStatus.textContent = `0 / ${state.selectedFiles.length}`;

    el.filesList.innerHTML = state.selectedFiles.map((file, idx) => {
      const ext = (file.name.split('.').pop() || 'dat').toLowerCase();
      return `
        <div class="file-row" id="file-queue-row-${idx}">
          <div class="file-row-left">
            <div class="file-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                <polyline points="13 2 13 9 20 9"></polyline>
              </svg>
            </div>
            <div class="file-row-info">
              <div class="file-row-name mono" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
              <div class="file-row-meta">
                <span>${formatBytes(file.size)}</span> • <span>${escapeHtml(file.type || '.' + ext)}</span>
              </div>
            </div>
          </div>
          <div class="file-row-right">
            <span class="badge" id="file-queue-status-${idx}">Ready</span>
            <button type="button" class="btn-remove-file" data-index="${idx}" title="Remove file">✕</button>
          </div>
        </div>
      `;
    }).join('');

    // Attach remove handlers
    el.filesList.querySelectorAll('.btn-remove-file').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.index);
        removeFileByIndex(idx);
      });
    });
  }

  // Resolve Effective Worker Count
  function getEffectiveWorkerCount() {
    if (state.mode === 'sequential') return 1;
    if (state.workers === 'auto') {
      return (state.system && state.system.cpus) ? state.system.cpus : 4;
    }
    return Number(state.workers) || 4;
  }

  // Worker Cards UI
  function initWorkerCards(workerCount, customTitle = null) {
    el.workerGrid.innerHTML = '';
    const label = customTitle || `${workerCount} Worker Thread${workerCount > 1 ? 's' : ''} Configured`;
    el.activeWorkerBadge.textContent = label;

    for (let i = 1; i <= workerCount; i++) {
      const card = document.createElement('div');
      card.className = 'worker-card';
      card.id = `worker-card-${i}`;
      card.innerHTML = `
        <div class="worker-card-header">
          <span class="worker-title">${customTitle ? 'Engine Worker' : 'Worker #' + i}</span>
          <span class="worker-status-dot" id="worker-dot-${i}"></span>
        </div>
        <div class="worker-file mono" id="worker-file-${i}">Ready in SafeQueue</div>
        <div class="worker-count" id="worker-count-${i}">0 tasks processed</div>
      `;
      el.workerGrid.appendChild(card);
    }
  }

  function updateWorkerCard(id, file, status, count, tasksProcessed, wasActive) {
    const card = document.getElementById(`worker-card-${id}`);
    const dot = document.getElementById(`worker-dot-${id}`);
    const fileLabel = document.getElementById(`worker-file-${id}`);
    const countLabel = document.getElementById(`worker-count-${id}`);

    if (!card) return;

    if (status === 'scanning') {
      card.className = 'worker-card active';
      dot.className = 'worker-status-dot scanning';
      fileLabel.textContent = file;
    } else if (status === 'finished') {
      card.classList.remove('active');
      if (wasActive === false || (tasksProcessed === 0 && count === 0)) {
        card.className = 'worker-card unassigned';
        dot.className = 'worker-status-dot unassigned';
        fileLabel.textContent = 'Unassigned / Idle (0 tasks)';
      } else {
        card.className = 'worker-card';
        dot.className = 'worker-status-dot finished';
        fileLabel.textContent = file || 'Completed';
      }
    } else {
      card.className = 'worker-card';
      dot.className = 'worker-status-dot';
      fileLabel.textContent = file || 'Idle';
    }

    if (countLabel) {
      const finalCount = (tasksProcessed !== undefined) ? tasksProcessed : (count || 0);
      countLabel.textContent = `${finalCount} task${finalCount === 1 ? '' : 's'} processed`;
    }
  }

  // Concurrency Mode & Options
  function setMode(mode) {
    state.mode = mode;
    if (mode === 'sequential') {
      el.btnModeSequential.classList.add('active');
      el.btnModeParallel.classList.remove('active');
      el.workerCountGroup.style.opacity = '0.4';
      el.workerCountGroup.style.pointerEvents = 'none';
      initWorkerCards(1);
    } else {
      el.btnModeParallel.classList.add('active');
      el.btnModeSequential.classList.remove('active');
      el.workerCountGroup.style.opacity = '1';
      el.workerCountGroup.style.pointerEvents = 'auto';
      initWorkerCards(getEffectiveWorkerCount());
    }
  }

  function getSelectedSignatures() {
    const checked = document.querySelectorAll('input[name="sig"]:checked');
    return Array.from(checked).map(c => c.value);
  }

  function getSelectedExtensions() {
    const checked = document.querySelectorAll('input[name="ext"]:checked');
    return Array.from(checked).map(c => c.value);
  }

  // Reset UI before scan execution
  function resetScanUI(totalFiles) {
    state.allResults = [];
    el.resultsTbody.innerHTML = '<tr class="empty-row"><td colspan="8">Scanning in progress... Task dispatching across workers.</td></tr>';
    el.metricTime.textContent = '0.0 ms';
    el.metricThroughput.textContent = '0.0 MB/s';
    el.metricQueueStatus.textContent = `0 / ${totalFiles}`;
    el.metricBytes.textContent = '0 B';
    el.metricMatches.textContent = '0';
    el.metricClean.textContent = '0';
    el.progressBarFill.style.width = '0%';
    el.progressText.textContent = `0 / ${totalFiles} files (0%)`;
    el.scanStateBadge.textContent = 'Status: RUNNING';
    el.scanStateBadge.className = 'progress-status';

    const effectiveWorkers = (state.engine === 'defender') ? 1 : getEffectiveWorkerCount();
    initWorkerCards(effectiveWorkers, state.engine === 'defender' ? 'Microsoft Defender Antivirus CLI' : null);

    el.btnStartUploadScan.disabled = true;
    el.btnStartSamplesScan.disabled = true;
    el.btnStopScan.disabled = false;
    el.btnRunBenchmark.disabled = true;
  }

  // Start User File Upload Scan
  async function startUploadScan() {
    if (state.selectedFiles.length === 0) {
      showToast('Please select at least one file to scan.', true);
      return;
    }

    const sigs = getSelectedSignatures();
    if (state.engine === 'cpp' && sigs.length === 0) {
      showToast('Please enable at least one test signature for Mode A.', true);
      return;
    }

    state.signatures = sigs;
    state.maxSize = Number(el.maxFileSize.value);

    resetScanUI(state.selectedFiles.length);

    const formData = new FormData();
    state.selectedFiles.forEach(file => {
      formData.append('files', file);
    });

    formData.append('engine', state.engine);
    formData.append('mode', state.mode);
    formData.append('workers', state.workers);
    formData.append('signatures', state.signatures.join(','));
    formData.append('maxSize', state.maxSize);

    try {
      const engineLabel = state.engine === 'defender' ? 'Microsoft Defender CLI' : `C++ (${state.mode.toUpperCase()})`;
      showToast(`Uploading ${state.selectedFiles.length} file(s) to 127.0.0.1 for ${engineLabel} scan...`);

      const res = await fetch('/api/scan/upload', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to start file scan.', true);
        finishScanUI('error', data.error);
        return;
      }

      showToast(`Scan running: ${engineLabel}`);
      pollScanStatus();
    } catch (err) {
      showToast(`Scan request failed: ${err.message}`, true);
      finishScanUI('error', err.message);
    }
  }

  // Start Samples Directory Scan
  async function startSamplesScan() {
    const sigs = getSelectedSignatures();
    const exts = getSelectedExtensions();

    if (sigs.length === 0) {
      showToast('Please enable at least one test signature.', true);
      return;
    }

    state.signatures = sigs;
    state.extensions = exts;
    state.maxSize = Number(el.maxFileSize.value);

    resetScanUI(100);

    try {
      const res = await fetch('/api/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: state.mode,
          workers: state.workers,
          signatures: state.signatures,
          extensions: state.extensions,
          maxSize: state.maxSize
        })
      });

      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to start samples scan.', true);
        finishScanUI('error', data.error);
        return;
      }

      showToast(`Samples scan running (${state.mode.toUpperCase()} - ${getEffectiveWorkerCount()} workers)`);
      pollScanStatus();
    } catch (err) {
      showToast(`Scan request failed: ${err.message}`, true);
      finishScanUI('error', err.message);
    }
  }

  // Polling Status Loop
  function pollScanStatus() {
    if (state.pollInterval) clearInterval(state.pollInterval);

    state.pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/scan/status');
        const data = await res.json();

        // Update progress
        const pct = (data.progress.percentage || 0).toFixed(1);
        el.progressBarFill.style.width = `${pct}%`;
        const total = data.progress.total_files || 0;
        const scanned = data.progress.scanned_files || 0;
        el.progressText.textContent = `${scanned} / ${total} files (${pct}%)`;
        el.metricQueueStatus.textContent = `${scanned} / ${total}`;

        // Update workers
        if (data.workers) {
          for (const [wId, wData] of Object.entries(data.workers)) {
            updateWorkerCard(wId, wData.file, wData.status, wData.count, wData.tasksProcessed, wData.wasActive);
          }
        }

        // Active vs Idle worker badge
        if (data.summary && data.summary.active_workers !== undefined) {
          const cfg = data.summary.worker_count;
          const act = data.summary.active_workers;
          const idl = data.summary.idle_workers;
          el.activeWorkerBadge.textContent = `${cfg} Workers Configured (${act} Active, ${idl} Idle)`;
        }

        // Update logs & log count
        if (data.recentLogs && data.recentLogs.length > 0) {
          el.logCount.textContent = `${data.recentLogs.length} events logged`;
          el.terminalLogs.innerHTML = data.recentLogs
            .map(line => `<div class="log-line">${escapeHtml(line)}</div>`)
            .join('');
          el.terminalLogs.scrollTop = el.terminalLogs.scrollHeight;
        }

        // Update results table
        if (data.results && data.results.length !== state.allResults.length) {
          state.allResults = data.results;
          renderResultsTable();

          const matches = state.allResults.filter(r => r.status === 'MATCH').length;
          const clean = state.allResults.filter(r => r.status === 'CLEAN').length;
          const bytes = state.allResults.reduce((acc, r) => acc + (r.bytesScanned || 0), 0);

          el.metricMatches.textContent = matches;
          el.metricClean.textContent = clean;
          el.metricBytes.textContent = formatBytes(bytes);
        }

        // Live elapsed time
        el.metricTime.textContent = `${(data.elapsedMs || 0).toFixed(1)} ms`;

        // Check completion
        if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
          clearInterval(state.pollInterval);
          state.pollInterval = null;

          if (data.summary) {
            el.metricTime.textContent = `${data.summary.elapsed_ms} ms`;
            el.metricThroughput.textContent = `${data.summary.throughput_mb_s} MB/s`;
            el.metricBytes.textContent = formatBytes(data.summary.total_bytes);
            el.metricMatches.textContent = data.summary.matched_files;
            el.metricClean.textContent = data.summary.clean_files;
            el.progressBarFill.style.width = '100%';
            el.progressText.textContent = `${data.summary.scanned_files} / ${data.summary.total_files} (100%)`;

            if (data.summary.active_workers !== undefined) {
              const cfg = data.summary.worker_count;
              const act = data.summary.active_workers;
              const idl = data.summary.idle_workers;
              el.activeWorkerBadge.textContent = `${cfg} Workers (${act} Active, ${idl} Idle)`;
            }
          }

          finishScanUI(data.status, data.error, data.summary);
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    }, 180);
  }

  function finishScanUI(status, errorMsg, summary) {
    el.btnStartUploadScan.disabled = false;
    el.btnStartSamplesScan.disabled = false;
    el.btnStopScan.disabled = true;
    el.btnRunBenchmark.disabled = false;

    if (status === 'completed') {
      el.scanStateBadge.textContent = 'Status: COMPLETED';
      el.scanStateBadge.className = 'progress-status ready';
      const engineName = summary?.engine || (state.engine === 'defender' ? 'Microsoft Defender CLI' : 'C++17 Multithreaded Engine');
      showToast(`Scan completed successfully via ${engineName}.`);
    } else if (status === 'stopped') {
      el.scanStateBadge.textContent = 'Status: CANCELLED';
      el.scanStateBadge.className = 'progress-status missing';
      showToast('Scan was cancelled.');
    } else {
      el.scanStateBadge.textContent = 'Status: ERROR';
      el.scanStateBadge.className = 'progress-status missing';
      if (errorMsg) showToast(`Scan error: ${errorMsg}`, true);
    }
  }

  // Stop Scan
  async function stopScan() {
    try {
      const res = await fetch('/api/scan/stop', { method: 'POST' });
      const data = await res.json();
      showToast(data.message || 'Stop request sent.');
    } catch (e) {
      showToast(`Error stopping scan: ${e.message}`, true);
    }
  }

  // Render Results Table
  function renderResultsTable() {
    const filter = el.resultFilter.value;
    const search = el.resultSearch.value.toLowerCase().trim();

    const filtered = state.allResults.filter(r => {
      if (filter !== 'ALL' && r.status !== filter) return false;
      if (search && !r.file.toLowerCase().includes(search)) return false;
      return true;
    });

    if (filtered.length === 0) {
      el.resultsTbody.innerHTML = '<tr class="empty-row"><td colspan="8">No matching files found.</td></tr>';
      return;
    }

    el.resultsTbody.innerHTML = filtered.map((r, idx) => {
      let statusBadge = '';
      if (r.status === 'MATCH') {
        const label = (r.engine && r.engine.includes('Defender')) ? 'THREAT DETECTED' : 'TEST SIGNATURE MATCHED';
        statusBadge = `<span class="badge match">${label}</span>`;
      } else if (r.status === 'CLEAN') {
        const label = (r.engine && r.engine.includes('Defender')) ? 'CLEAN (0 THREATS)' : 'NO TEST SIGNATURE MATCHED';
        statusBadge = `<span class="badge clean">${label}</span>`;
      } else if (r.status === 'SKIPPED') {
        statusBadge = `<span class="badge skipped">SKIPPED (SIZE LIMIT)</span>`;
      } else {
        statusBadge = `<span class="badge error">ERROR</span>`;
      }

      let details = '-';
      if (r.status === 'MATCH') {
        details = `<span class="mono" style="color: var(--amber)">Matched: ${(r.signatures || []).join(', ') || 'Malware Pattern'}</span>`;
      } else if (r.message) {
        details = `<span class="text-muted">${escapeHtml(r.message)}</span>`;
      }

      const engineBadge = (r.engine && r.engine.includes('Defender'))
        ? `<span class="badge purple" style="font-size:0.68rem;">MS Defender</span>`
        : `<span class="badge" style="font-size:0.68rem;">C++ Thread #${r.workerId}</span>`;

      return `
        <tr>
          <td>${idx + 1}</td>
          <td><span class="mono">Worker #${r.workerId}</span></td>
          <td class="mono"><strong>${escapeHtml(r.file)}</strong></td>
          <td>${engineBadge}</td>
          <td>${statusBadge}</td>
          <td>${details}</td>
          <td class="mono">${formatBytes(r.fileSize || 0)}</td>
          <td class="mono">${(r.durationUs / 1000).toFixed(2)} ms</td>
        </tr>
      `;
    }).join('');
  }

  // Benchmark Suite
  async function runBenchmark() {
    el.benchmarkPanel.style.display = 'block';
    el.benchmarkStatusBadge.textContent = 'Running Benchmark Suite...';
    el.benchmarkStatusBadge.className = 'badge purple';
    el.benchmarkTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">Executing benchmark across 1, 2, 4, and 8 worker threads...</td></tr>';

    el.btnStartUploadScan.disabled = true;
    el.btnStartSamplesScan.disabled = true;
    el.btnRunBenchmark.disabled = true;

    try {
      const res = await fetch('/api/benchmark/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Benchmark initialization failed.', true);
        el.btnStartUploadScan.disabled = false;
        el.btnStartSamplesScan.disabled = false;
        el.btnRunBenchmark.disabled = false;
        return;
      }

      showToast('Running comparative benchmark (1, 2, 4, and 8 threads)...');
      pollBenchmarkStatus();
    } catch (e) {
      showToast(`Benchmark error: ${e.message}`, true);
      el.btnStartUploadScan.disabled = false;
      el.btnStartSamplesScan.disabled = false;
      el.btnRunBenchmark.disabled = false;
    }
  }

  function pollBenchmarkStatus() {
    if (state.benchmarkPollInterval) clearInterval(state.benchmarkPollInterval);

    state.benchmarkPollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/benchmark/status');
        const data = await res.json();

        if (data.running) {
          el.benchmarkStatusBadge.textContent = `${data.step} (${data.progress}%)`;
        } else if (data.results) {
          clearInterval(state.benchmarkPollInterval);
          state.benchmarkPollInterval = null;
          el.benchmarkStatusBadge.textContent = 'Completed';
          el.benchmarkStatusBadge.className = 'badge emerald';
          renderBenchmarkResults(data.results);
          el.btnStartUploadScan.disabled = false;
          el.btnStartSamplesScan.disabled = false;
          el.btnRunBenchmark.disabled = false;
          showToast('Comparative speedup benchmark completed!');
        } else if (data.error) {
          clearInterval(state.benchmarkPollInterval);
          state.benchmarkPollInterval = null;
          el.benchmarkStatusBadge.textContent = 'Error';
          el.benchmarkStatusBadge.className = 'badge error';
          el.benchmarkTableBody.innerHTML = `<tr><td colspan="7" style="color: var(--coral);">Error: ${escapeHtml(data.error)}</td></tr>`;
          el.btnStartUploadScan.disabled = false;
          el.btnStartSamplesScan.disabled = false;
          el.btnRunBenchmark.disabled = false;
        }
      } catch (e) {
        console.error('Benchmark poll error:', e);
      }
    }, 400);
  }

  function renderBenchmarkResults(bench) {
    if (!bench || !bench.runs) return;

    const maxSpeedup = Math.max(...bench.runs.map(r => r.speedup), 1.0);

    el.benchmarkTableBody.innerHTML = bench.runs.map(r => {
      const pct = Math.min(100, Math.round((r.speedup / maxSpeedup) * 100));
      return `
        <tr>
          <td><strong>${escapeHtml(r.label)}</strong></td>
          <td class="mono">${r.workers}</td>
          <td class="mono">${r.elapsedMs.toFixed(2)} ms</td>
          <td class="mono cyan">${r.throughputMbS.toFixed(2)} MB/s</td>
          <td class="mono" style="color: var(--purple); font-weight: bold;">${r.speedup.toFixed(2)}x</td>
          <td class="mono">${r.efficiency.toFixed(1)}%</td>
          <td>
            <div class="speedup-bar-cell">
              <div class="speedup-track">
                <div class="speedup-fill" style="width: ${pct}%;"></div>
              </div>
              <span class="mono" style="font-size: 0.72rem;">${r.speedup.toFixed(2)}x</span>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Event Listeners
  el.tabBtnUpload.addEventListener('click', () => switchTab('upload'));
  el.tabBtnSamples.addEventListener('click', () => switchTab('samples'));

  el.cardEngineCpp.addEventListener('click', () => setEngineMode('cpp'));
  el.cardEngineDefender.addEventListener('click', () => setEngineMode('defender'));

  el.userFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToSelection(e.target.files);
    }
  });

  el.btnAddMore.addEventListener('click', () => {
    el.userFileInput.click();
  });

  el.btnLoadFixture.addEventListener('click', loadTestFixture);
  el.btnLoadFixtureTop.addEventListener('click', loadTestFixture);
  el.btnClearAll.addEventListener('click', clearAllFiles);

  // Drag and drop for multiple files
  el.fileDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.fileDropzone.classList.add('dragover');
  });

  el.fileDropzone.addEventListener('dragleave', () => {
    el.fileDropzone.classList.remove('dragover');
  });

  el.fileDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.fileDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToSelection(e.dataTransfer.files);
    }
  });

  el.btnModeParallel.addEventListener('click', () => setMode('parallel'));
  el.btnModeSequential.addEventListener('click', () => setMode('sequential'));

  el.workerPills.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (btn) {
      el.workerPills.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.dataset.workers;
      state.workers = (val === 'auto') ? 'auto' : Number(val);
      initWorkerCards(getEffectiveWorkerCount());
    }
  });

  el.btnStartUploadScan.addEventListener('click', startUploadScan);
  el.btnStartSamplesScan.addEventListener('click', startSamplesScan);
  el.btnStopScan.addEventListener('click', stopScan);
  el.btnRunBenchmark.addEventListener('click', runBenchmark);
  el.btnGenerateSamples.addEventListener('click', generateSamplesDataset);

  el.resultSearch.addEventListener('input', renderResultsTable);
  el.resultFilter.addEventListener('change', renderResultsTable);

  // Initialize
  initWorkerCards(getEffectiveWorkerCount());
  loadSystemInfo();
  loadSamplesInfo();
});
