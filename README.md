# ThreadShield — Multithreaded File Security Scanner
**Operating Systems Laboratory Project • Concurrent Computing & Systems Architecture**

ThreadShield is a high-performance multithreaded file scanner written in **C++17** with a real-time cybersecurity dashboard powered by **Node.js, Express, and Vanilla JavaScript**.

Designed for OS lab demonstration and viva presentation, ThreadShield illustrates concurrent programming, process scheduling, synchronization primitives, shared-memory safety, inter-process communication (IPC), and Amdahl's Law in practice.

---

## 🎯 Detection Modes & Core Features

1. **Mode A: C++ Multithreaded Engine (OS Lab Core)**
   - C++17 thread pool using `std::thread`, `std::mutex`, `std::condition_variable`, and dynamic `SafeQueue` scheduling.
   - Worker selection: `Auto` (matches hardware logical cores), `1`, `2`, `4`, or `8` threads.
   - Dynamic scheduling: Free workers continuously pull tasks from the queue.
   - Real idle worker reporting: When files < workers, unassigned threads are accurately reported as **Idle (0 tasks)** rather than falsely claiming activity.
   - Stream scanning: 64 KB chunks with boundary overlap buffers to catch patterns spanning chunk edges.
   - Educational test patterns (`TEST_SIGNATURE_ALPHA..DELTA`) with a 1-click **"Load Harmless Test Fixture"** button.

2. **Mode B: Microsoft Defender Engine (Real Antivirus CLI)**
   - Integrates with Windows Defender CLI:
     `MpCmdRun.exe -Scan -ScanType 3 -File <path> -DisableRemediation`
   - Scans against real definitions with **`-DisableRemediation`** so files are **never quarantined, modified, or deleted**.
   - Captures return codes (Code 0 = Clean, Code 2 = Threat Detected) and CLI detection logs.

3. **Multi-File Upload & Queue Management**
   - Supports selecting multiple files via `<input type="file" multiple>` and drag-and-drop.
   - Batch limits: Up to 50 files per batch, 25 MB per file, and 100 MB total batch size.
   - Batch controls: "Start Scan", "Clear All", "Add More", and per-file "Remove".

4. **Samples Benchmark Mode (Amdahl's Law Scaling)**
   - Comparative benchmark running sequential (1 thread) vs parallel (2, 4, 8 threads) over preloaded datasets.
   - Computes Speedup Factor ($S = T_1 / T_N$) and Parallel Efficiency ($E = S / N \times 100\%$).

---

## ⚠️ Academic Notice & Safety Controls
- **Educational Pattern Matching**: In Mode A, detections identify configured literal test strings (`TEST_SIGNATURE_ALPHA..DELTA`). A clean verdict means no test pattern matched; it is not a real-world malware guarantee.
- **Strict Read-Only Mode**: Native C++ engine opens files with `std::ios::binary | std::ios::in`. Scanned files are never executed, modified, or quarantined.
- **Path Traversal Protection**: Scans are bounded to authorized roots (`samples/` and `temp_uploads/`). Traversal attempts (`..`, `../..`, external drives) are rejected by both Express and C++ layers.
- **Automatic Cleanup**: Uploaded temporary files in `temp_uploads/` are purged immediately upon scan completion.

---

## 🧠 Core Operating Systems Concepts for Viva

### 1. Multithreading vs. Multiprocessing
- **Process**: Program instance with its own virtual address space, file handles, and security context.
- **Thread**: Smallest schedulable execution unit sharing code, heap, and globals within a process, with a private stack and registers.
- **Advantage**: Thread creation and context switching incur significantly lower overhead than creating full processes.

### 2. Thread Pool & Thread Lifecycle (`std::thread`, `join()`)
- Creating threads per task introduces allocation latency and OS thrashing.
- ThreadShield instantiates $N$ worker threads at scan start. When tasks are exhausted, the producer signals completion and calls `.join()` on each thread to block until all workers exit cleanly, preventing zombie threads.

### 3. Producer-Consumer Queue (`std::condition_variable`)
- Implemented via `SafeQueue<ScanTask>` in `src/scanner.cpp`:
  - **Producer**: Main thread enqueues tasks and calls `cv_.notify_one()`.
  - **Consumers**: Worker threads pop tasks. When the queue is empty, workers sleep on `cv_.wait(lock)` to avoid CPU-wasting busy loops.

### 4. Dynamic Task Scheduling & Idle Worker Detection
- **Files > Workers**: Tasks are load-balanced dynamically as free workers pop the next available item.
- **Files < Workers**: Threads finding the queue empty upon notification exit immediately with `tasks_processed: 0`. ThreadShield marks these workers as `was_active: false` and displays them as **"Unassigned / Idle (0 tasks)"**.

### 5. Mutual Exclusion & Lock-Free Atomics
- **Race Condition Prevention**: `std::mutex` protects shared queue access and serializes stdout console writes (`g_cout_mutex`).
- **High-Frequency Counters**: File counts and byte totals use `std::atomic<uint64_t>` (`fetch_add`) to leverage hardware CPU atomic instructions without mutex locking overhead.

### 6. Amdahl's Law & Parallel Efficiency
- **Speedup**: $S = \frac{T_1}{T_N}$
- **Efficiency**: $E = \frac{S}{N} \times 100\%$
- **Serial Bottlenecks**: Maximum speedup is constrained by sequential operations (directory traversal, task dispatching, I/O latency). Beyond physical core limits, additional threads introduce scheduling overhead.

### 7. Inter-Process Communication (IPC) & Sandbox Architecture
- Express launches `bin/scanner.exe` via `child_process.spawn()` with structured argument arrays (immune to shell injection).
- C++ emits newline-delimited JSON Lines over `stdout`, which Node.js parses asynchronously and surfaces to the web dashboard via polling.
- Web browsers cannot directly access local filesystem paths; file selection securely transmits a temporary local copy to `127.0.0.1` for analysis.

---

## 🏗️ Architecture Diagram

```
+-------------------------------------------------------------------------+
|                  Browser UI (HTML5, CSS3, Vanilla JS)                   |
|  [Multi-File Upload (Drag & Drop)]    [Samples Speedup Benchmark]       |
|  - Mode A (C++ Thread Pool)           - Mode B (Microsoft Defender CLI) |
|  - Real-time worker cards             - Live queue metrics & throughput |
+------------------------------------+------------------------------------+
                                     | Multipart HTTP POST / Polling REST
                                     v
+-------------------------------------------------------------------------+
|                    Node.js Express Controller Server                    |
|                    (Strictly bound to 127.0.0.1:3000)                   |
|  - Multer upload validation (max 50 files, 100 MB batch)                |
|  - Bounded temp directory creation & post-scan cleanup                  |
|  - Path Traversal Guard (validates allowed-root boundaries)             |
|  - Spawns C++ engine or Defender CLI via child_process.spawn()          |
+------------------------------------+------------------------------------+
                                     | stdout (JSON Lines Stream)
                                     v
+-------------------------------------------------------------------------+
|                  ThreadShield Native Engine (C++17)                     |
|                                                                         |
|   [Target Resolver]  ---> Validates path inside allowed-root            |
|   [SafeQueue]        ---> Synchronized Producer-Consumer queue          |
|   [Worker Pool]      ---> N threads (64 KB chunk stream + overlap)      |
|   [Atomic Stats]     ---> Scanned, Matches, Clean, Bytes (lock-free)    |
|   [Worker Join]      ---> Clean thread termination via join()           |
+-------------------------------------------------------------------------+
```

---

## 📁 Project Directory Structure

```
OsLabProject/
├── bin/
│   └── scanner.exe               # Compiled C++ scanning engine binary
├── public/
│   ├── index.html                # Dark-themed cybersecurity dashboard
│   ├── style.css                 # Responsive stylesheet & animations
│   └── app.js                    # Vanilla JS client controller
├── samples/                      # Dedicated preloaded test dataset
├── scripts/
│   ├── build.bat                 # Windows batch script to compile C++ engine
│   ├── run.bat                   # Script to launch ThreadShield dashboard
│   └── test.bat                  # Script to run automated test suite
├── server/
│   ├── sample_generator.js       # Generator for test files
│   ├── server.js                 # Express server & process manager
│   └── test_suite.js             # Automated 73-point test suite
├── src/
│   └── scanner.cpp               # C++17 multithreaded scanning engine
├── temp_uploads/                 # Isolated per-scan temp uploads (gitignored)
├── package.json                  # Dependencies & npm scripts
└── README.md                     # Documentation & viva manual
```

---

## 🚀 Setup & Run Instructions

### Prerequisites
1. **Node.js**: v16+ (tested on Node.js v24).
2. **C++17 Compiler**: GCC (`g++`) 7+, Clang++, or MSVC.
   - Recommended on Windows: `w64devkit` (GCC 16.2.0), auto-detected at `%LOCALAPPDATA%\w64devkit\bin\g++.exe`.

### 1. Build the C++ Scanning Engine
```cmd
npm run build:cpp
```
*Or directly via script:*
```cmd
scripts\build.bat
```
Compiles `src/scanner.cpp` to `bin/scanner.exe` with `-std=c++17 -O3 -pthread`.

### 2. Generate Test Samples (For Benchmark Mode)
```cmd
npm run generate:samples
```

### 3. Launch ThreadShield
```cmd
npm start
```
*Or directly via script:*
```cmd
scripts\run.bat
```
Opens the dashboard at `http://127.0.0.1:3000`.

---

## 🧪 Automated Testing

ThreadShield includes a **73-assertion automated test suite** validating:
- C++ binary compilation and environment detection.
- Sample dataset generation across nested subdirectories.
- Sequential and parallel modes (1, 2, 4, 8 workers, and auto).
- Pattern matching accuracy and oversized file skipping.
- Path traversal rejection (`..`, `../..`, external roots).
- Multi-file batch uploads with dynamic queue scheduling.
- Idle worker reporting when files < workers.
- Raw binary stream scanning with embedded null bytes.
- Post-scan temporary directory cleanup.
- Microsoft Defender CLI non-destructive execution.
- Comparative speedup benchmark metrics.

Run tests:
```cmd
npm test
```
*Or directly via script:*
```cmd
scripts\test.bat
```

### Measured Benchmark Results (AMD Ryzen 6-Core / 12-Thread)
| Mode | Workers ($N$) | Elapsed Time | Throughput | Speedup ($S$) | Efficiency ($E$) |
|---|---|---|---|---|---|
| **Sequential** | 1 | 9.28 ms | 310.0 MB/s | **1.00x** | 100.0% |
| **Parallel** | 2 | 6.08 ms | 472.8 MB/s | **1.53x** | 76.3% |
| **Parallel** | 4 | 6.21 ms | 463.4 MB/s | **1.49x** | 37.4% |
| **Parallel** | 8 | 4.93 ms | 583.9 MB/s | **1.88x** | 23.5% |

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/scan/upload` | Multipart upload and scan endpoint (up to 50 files, 100 MB batch) supporting C++ or Defender engine |
| `POST` | `/api/scan/start` | Initiates scan over `samples/` with `{ mode, workers, signatures, extensions, maxSize }` |
| `GET` | `/api/scan/status` | Polling endpoint returning progress, active worker cards, live results, and summary |
| `POST` | `/api/scan/stop` | Cancels an active scan and purges temporary files |
| `POST` | `/api/benchmark/run` | Runs comparative speedup benchmark across 1, 2, 4, and 8 worker threads |
| `GET` | `/api/benchmark/status` | Polling endpoint for benchmark execution state and scaling graph |
| `GET` | `/api/system/info` | Reports detected compiler, Defender status, CPU cores, memory, and batch limits |
| `GET` | `/api/samples/test-fixture` | Returns harmless educational test fixture payload |
| `GET` | `/api/samples/info` | Returns file count and size in `./samples/` |
| `POST` | `/api/samples/generate` | Regenerates harmless test dataset in `./samples/` |

---

## 🛡️ License
MIT License. Created for educational and Operating Systems academic laboratory demonstration purposes.
