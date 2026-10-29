// ThreadShield Frontend Controller
document.addEventListener('DOMContentLoaded', () => {
  // Application State
  const state = {
    mode: 'parallel',
    workers: 4,
    signatures: ['TEST_SIGNATURE_ALPHA', 'TEST_SIGNATURE_BETA', 'TEST_SIGNATURE_GAMMA', 'TEST_SIGNATURE_DELTA'],
    extensions: ['.txt', '.log', '.csv'],
    maxSize: 10485760,
    pollInterval: null,
    benchmarkPollInterval: null,
    allResults: [],
    system: null
  };

  // DOM Elements
  const el = {
    engineStatus: document.getElementById('engine-status'),
    compilerInfo: document.getElementById('compiler-info'),
    cpuCores: document.getElementById('cpu-cores'),
    samplesRoot: document.getElementById('samples-root'),
    datasetFilesCount: document.getElementById('dataset-files-count'),
    datasetBytesSize: document.getElementById('dataset-bytes-size'),

    btnModeParallel: document.getElementById('btn-mode-parallel'),
    btnModeSequential: document.getElementById('btn-mode-sequential'),
    workerPills: document.getElementById('worker-pills'),
    workerCountGroup: document.getElementById('worker-count-group'),
    maxFileSize: document.getElementById('max-file-size'),

    btnStartScan: document.getElementById('btn-start-scan'),
    btnStopScan: document.getElementById('btn-stop-scan'),
    btnRunBenchmark: document.getElementById('btn-run-benchmark'),
    btnGenerateSamples: document.getElementById('btn-generate-samples'),

    metricTime: document.getElementById('metric-time'),
    metricThroughput: document.getElementById('metric-throughput'),
    metricRate: document.getElementById('metric-rate'),
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

  // Show Toast Notification
  function showToast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.style.borderColor = isError ? 'var(--coral)' : 'var(--cyan)';
    el.toast.classList.remove('hidden');
    setTimeout(() => {
      el.toast.classList.add('hidden');
    }, 4000);
  }

  // Format Bytes Utility
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Load System & Sample Dataset Info
  async function loadSystemInfo() {
    try {
      const res = await fetch('/api/system/info');
      const data = await res.json();
      state.system = data;

      el.cpuCores.textContent = `${data.cpus} Logical Cores (${data.cpuModel})`;
      if (data.compiler.detected) {
        el.compilerInfo.textContent = `${data.compiler.type} (${data.compiler.path})`;
      } else {
        el.compilerInfo.textContent = 'None detected';
        el.compilerInfo.classList.add('missing');
      }

      if (data.executable.compiled) {
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
      if (!data.exists || data.totalFiles === 0) {
        // Auto-generate test samples if directory is empty
        await generateSamplesDataset();
      } else {
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

  // Render Worker Cards
  function initWorkerCards(workerCount) {
    el.workerGrid.innerHTML = '';
    el.activeWorkerBadge.textContent = `${workerCount} Worker Thread${workerCount > 1 ? 's' : ''} Configured`;
    
    for (let i = 1; i <= workerCount; i++) {
      const card = document.createElement('div');
      card.className = 'worker-card';
      card.id = `worker-card-${i}`;
      card.innerHTML = `
        <div class="worker-card-header">
          <span class="worker-title">Worker #${i}</span>
          <span class="worker-status-dot" id="worker-dot-${i}"></span>
        </div>
        <div class="worker-file mono" id="worker-file-${i}">Ready</div>
        <div class="worker-count" id="worker-count-${i}">0 files scanned</div>
      `;
      el.workerGrid.appendChild(card);
    }
  }

  // Update Worker Card
  function updateWorkerCard(id, file, status, count) {
    const card = document.getElementById(`worker-card-${id}`);
    const dot = document.getElementById(`worker-dot-${id}`);
    const fileLabel = document.getElementById(`worker-file-${id}`);
    const countLabel = document.getElementById(`worker-count-${id}`);

    if (!card) return;

    if (status === 'scanning') {
      card.classList.add('active');
      dot.className = 'worker-status-dot scanning';
      fileLabel.textContent = file;
    } else if (status === 'finished') {
      card.classList.remove('active');
      dot.className = 'worker-status-dot finished';
      fileLabel.textContent = 'Completed';
    } else {
      card.classList.remove('active');
      dot.className = 'worker-status-dot';
      fileLabel.textContent = file || 'Idle';
    }

    if (countLabel && count !== undefined) {
      countLabel.textContent = `${count} file${count === 1 ? '' : 's'} scanned`;
    }
  }

  // Scan Mode Handler
  function setMode(mode) {
    state.mode = mode;
    if (mode === 'sequential') {
      el.btnModeSequential.classList.add('active');
      el.btnModeParallel.classList.remove('active');
      el.workerCountGroup.style.opacity = '0.4';
      el.workerCountGroup.style.pointerEvents = 'none';
      state.workers = 1;
      initWorkerCards(1);
    } else {
      el.btnModeParallel.classList.add('active');
      el.btnModeSequential.classList.remove('active');
      el.workerCountGroup.style.opacity = '1';
      el.workerCountGroup.style.pointerEvents = 'auto';
      // Read current active pill
      const activePill = el.workerPills.querySelector('.pill-btn.active');
      state.workers = activePill ? Number(activePill.dataset.workers) : 4;
      initWorkerCards(state.workers);
    }
  }

  // Get Selected Signatures
  function getSelectedSignatures() {
    const checked = document.querySelectorAll('input[name="sig"]:checked');
    return Array.from(checked).map(c => c.value);
  }

  // Get Selected Extensions
  function getSelectedExtensions() {
    const checked = document.querySelectorAll('input[name="ext"]:checked');
    return Array.from(checked).map(c => c.value);
  }

  // Start Scan
  async function startScan() {
    const sigs = getSelectedSignatures();
    const exts = getSelectedExtensions();

    if (sigs.length === 0) {
      showToast('Please select at least one test signature.', true);
      return;
    }
    if (exts.length === 0) {
      showToast('Please select at least one file extension.', true);
      return;
    }

    state.signatures = sigs;
    state.extensions = exts;
    state.maxSize = Number(el.maxFileSize.value);

    // Reset UI state
    state.allResults = [];
    el.resultsTbody.innerHTML = '<tr class="empty-row"><td colspan="7">Scanning in progress...</td></tr>';
    el.metricTime.textContent = '0.0 ms';
    el.metricThroughput.textContent = '0.0 MB/s';
    el.metricRate.textContent = '0 files/s';
    el.metricMatches.textContent = '0';
    el.metricClean.textContent = '0';
    el.progressBarFill.style.width = '0%';
    el.progressText.textContent = 'Initializing...';
    el.scanStateBadge.textContent = 'Status: RUNNING';
    el.scanStateBadge.className = 'progress-status';

    initWorkerCards(state.workers);

    el.btnStartScan.disabled = true;
    el.btnStopScan.disabled = false;
    el.btnRunBenchmark.disabled = true;

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
        showToast(data.error || 'Failed to start scanner process.', true);
        finishScanUI('error', data.error);
        return;
      }

      showToast(`Scan started (${state.mode.toUpperCase()} - ${state.workers} worker${state.workers > 1 ? 's' : ''})`);
      pollScanStatus();
    } catch (err) {
      showToast(`Scan trigger error: ${err.message}`, true);
      finishScanUI('error', err.message);
    }
  }

  // Poll Scan Status
  function pollScanStatus() {
    if (state.pollInterval) clearInterval(state.pollInterval);

    state.pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/scan/status');
        const data = await res.json();

        // Update progress
        const pct = (data.progress.percentage || 0).toFixed(1);
        el.progressBarFill.style.width = `${pct}%`;
        el.progressText.textContent = `${data.progress.scanned_files || 0} / ${data.progress.total_files || 0} files (${pct}%)`;

        // Update workers
        if (data.workers) {
          for (const [wId, wData] of Object.entries(data.workers)) {
            updateWorkerCard(wId, wData.file, wData.status, wData.count);
          }
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

          // Calculate live counters
          const matches = state.allResults.filter(r => r.status === 'MATCH').length;
          const clean = state.allResults.filter(r => r.status === 'CLEAN').length;
          el.metricMatches.textContent = matches;
          el.metricClean.textContent = clean;
        }

        // Live elapsed time
        el.metricTime.textContent = `${(data.elapsedMs || 0).toFixed(1)} ms`;

        // Check if finished
        if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
          clearInterval(state.pollInterval);
          state.pollInterval = null;

          if (data.summary) {
            el.metricTime.textContent = `${data.summary.elapsed_ms} ms`;
            el.metricThroughput.textContent = `${data.summary.throughput_mb_s} MB/s`;
            el.metricRate.textContent = `${data.summary.files_per_sec} files/s`;
            el.metricMatches.textContent = data.summary.matched_files;
            el.metricClean.textContent = data.summary.clean_files;
            el.progressBarFill.style.width = '100%';
            el.progressText.textContent = `${data.summary.scanned_files} / ${data.summary.total_files} files (100%)`;
          }

          finishScanUI(data.status, data.error);
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    }, 200);
  }

  // Finish Scan UI State
  function finishScanUI(status, errorMsg) {
    el.btnStartScan.disabled = false;
    el.btnStopScan.disabled = true;
    el.btnRunBenchmark.disabled = false;

    if (status === 'completed') {
      el.scanStateBadge.textContent = 'Status: COMPLETED';
      el.scanStateBadge.className = 'progress-status ready';
      showToast('Multithreaded scan completed successfully.');
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
      el.resultsTbody.innerHTML = '<tr class="empty-row"><td colspan="7">No matching files found.</td></tr>';
      return;
    }

    el.resultsTbody.innerHTML = filtered.map((r, idx) => {
      let statusBadge = '';
      if (r.status === 'MATCH') {
        statusBadge = `<span class="badge match">MATCH (${r.signatures.length})</span>`;
      } else if (r.status === 'CLEAN') {
        statusBadge = `<span class="badge clean">CLEAN</span>`;
      } else if (r.status === 'SKIPPED') {
        statusBadge = `<span class="badge skipped">SKIPPED</span>`;
      } else {
        statusBadge = `<span class="badge error">ERROR</span>`;
      }

      let details = '-';
      if (r.status === 'MATCH') {
        details = `<span class="mono" style="color: var(--amber)">${r.signatures.join(', ')}</span>`;
      } else if (r.message) {
        details = `<span class="text-muted">${escapeHtml(r.message)}</span>`;
      }

      return `
        <tr>
          <td>${idx + 1}</td>
          <td><span class="mono">W#${r.workerId}</span></td>
          <td class="mono"><strong>${escapeHtml(r.file)}</strong></td>
          <td>${statusBadge}</td>
          <td>${details}</td>
          <td class="mono">${formatBytes(r.fileSize || 0)}</td>
          <td class="mono">${(r.durationUs / 1000).toFixed(2)} ms</td>
        </tr>
      `;
    }).join('');
  }

  // Run Benchmark Suite
  async function runBenchmark() {
    el.benchmarkPanel.style.display = 'block';
    el.benchmarkStatusBadge.textContent = 'Running Benchmark Suite...';
    el.benchmarkStatusBadge.className = 'badge purple';
    el.benchmarkTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">Executing benchmark across 1, 2, 4, and 8 worker threads...</td></tr>';

    el.btnStartScan.disabled = true;
    el.btnRunBenchmark.disabled = true;

    try {
      const res = await fetch('/api/benchmark/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Benchmark initialization failed.', true);
        el.btnStartScan.disabled = false;
        el.btnRunBenchmark.disabled = false;
        return;
      }

      showToast('Benchmark suite running across 1, 2, 4, and 8 worker threads...');
      pollBenchmarkStatus();
    } catch (e) {
      showToast(`Benchmark error: ${e.message}`, true);
      el.btnStartScan.disabled = false;
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
          el.btnStartScan.disabled = false;
          el.btnRunBenchmark.disabled = false;
          showToast('Comparative benchmark completed!');
        } else if (data.error) {
          clearInterval(state.benchmarkPollInterval);
          state.benchmarkPollInterval = null;
          el.benchmarkStatusBadge.textContent = 'Error';
          el.benchmarkStatusBadge.className = 'badge error';
          el.benchmarkTableBody.innerHTML = `<tr><td colspan="7" style="color: var(--coral);">Error: ${escapeHtml(data.error)}</td></tr>`;
          el.btnStartScan.disabled = false;
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
  el.btnModeParallel.addEventListener('click', () => setMode('parallel'));
  el.btnModeSequential.addEventListener('click', () => setMode('sequential'));

  el.workerPills.addEventListener('click', (e) => {
    if (e.target.classList.contains('pill-btn')) {
      el.workerPills.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.workers = Number(e.target.dataset.workers);
      initWorkerCards(state.workers);
    }
  });

  el.btnStartScan.addEventListener('click', startScan);
  el.btnStopScan.addEventListener('click', stopScan);
  el.btnRunBenchmark.addEventListener('click', runBenchmark);
  el.btnGenerateSamples.addEventListener('click', generateSamplesDataset);

  el.resultSearch.addEventListener('input', renderResultsTable);
  el.resultFilter.addEventListener('change', renderResultsTable);

  // Initialize
  initWorkerCards(state.workers);
  loadSystemInfo();
  loadSamplesInfo();
});

