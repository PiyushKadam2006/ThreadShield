# ThreadShield — Multithreaded File Security Scanner
**Operating Systems Laboratory Project • Concurrent Computing & Systems Architecture**

ThreadShield is a high-performance, multithreaded file security scanner written in **C++17** coupled with an interactive real-time cybersecurity dashboard powered by **Node.js, Express, and Vanilla JavaScript**.

Designed specifically as an Operating Systems lab project and viva presentation system, ThreadShield illustrates core principles of concurrent programming, process scheduling, synchronization primitives, shared-memory safety, inter-process communication (IPC), browser sandbox boundaries, and Amdahl's Law in practice.

---

## 🎯 Key Capabilities & Detection Modes

ThreadShield supports two distinct inspection modes:

1. **Mode A: C++ Multithreaded Scanning Engine (OS Lab Core)**
   - Genuine C++17 thread pool using `std::thread`, `std::mutex`, `std::condition_variable`, and dynamic `SafeQueue` scheduling.
   - Configurable worker count: `Auto` (matches host logical CPU cores via `hardware_concurrency`), `1`, `2`, `4`, or `8` threads.
   - Dynamic task distribution: Each worker thread takes the next available file from the synchronized queue as soon as it becomes free.
   - Real thread monitoring: When files < workers, unassigned threads are accurately reported as **Idle (0 tasks)** rather than falsely claiming all threads are working.
   - Chunk-based stream scanning with boundary overlap matching to reliably detect test patterns spanning chunk edges.
   - Harmless educational test patterns (`TEST_SIGNATURE_ALPHA..DELTA`) with a 1-click **"Load Harmless Test Fixture"** button.

2. **Mode B: Microsoft Defender Engine (Real Antivirus CLI)**
   - Integrates directly with the host's native Windows Defender command-line utility:
     `"C:\Program Files\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File <path> -DisableRemediation`
   - Scans uploaded files against Microsoft's real antivirus signature database.
   - Enforces **`-DisableRemediation`** to guarantee that files are **never quarantined, modified, or deleted**.
   - Accurately captures CLI return codes (Code 0 = Clean, Code 2 = Threat Detected) and CLI detection output.

3. **Multi-File Upload & Queue Management**
   - Supports selecting multiple files at once via `<input type="file" multiple>` and drag-and-drop.
   - File queue displays filename, size, MIME type, per-file status badge, and individual "Remove File" controls.
   - Batch limits: Up to 50 files per batch, 25 MB per file, and 100 MB total batch size.
   - Batch controls: "Start Scan", "Clear All", "Add More", and "Load Harmless Test Fixture".

4. **Samples Benchmark Mode (Amdahl's Law Scaling)**
   - Preserved comparative benchmark running sequential (1 thread) vs parallel (2, 4, 8 threads) over preloaded sample datasets.
   - Computes Speedup Factor ($S = T_1 / T_N$) and Parallel Efficiency ($E = S / N \times 100\%$).

---

## ⚠️ Academic Simulation & Safety Limitations
> **Educational Disclaimer**: ThreadShield is strictly an academic demonstration tool.
> - In Mode A, pattern matches are labeled **"Test signature matched"** or **"No configured test signature matched"**. A clean status does **NOT** indicate a file is safe or free of real malware, and a match does not indicate a security threat.
> - ThreadShield Mode A searches strictly for configured literal test strings (`TEST_SIGNATURE_ALPHA`, `TEST_SIGNATURE_BETA`, `TEST_SIGNATURE_GAMMA`, `TEST_SIGNATURE_DELTA`).
> - The native engine operates in **strict read-only binary mode** (`std::ios::binary | std::ios::in`) and **never executes, modifies, deletes, or quarantines** user files.
> - Scanning is sandboxed to project boundaries (`samples/` and temporary per-scan `temp_uploads/`). All path traversal attempts (`..`, `../..`, external drives) are rejected at both the Express and C++ layers.
> - Temporary uploaded files are automatically deleted immediately after scanning finishes.

---

## 📂 User File Upload Architecture & Browser Sandbox

### Why File Upload is Required
Web browsers execute web applications inside an isolated security sandbox. Browsers do **not** provide client-side web pages with arbitrary, direct access to files on the host's local filesystem (such as reading `C:\Users\...`). 

To scan any file of the user's choosing:
1. The user explicitly selects local files through an HTML5 `<input type="file" multiple>` file picker or drag-and-drop zone.
2. The browser transmits a copy of the selected files via a multipart HTTP `POST` request directly to the local ThreadShield server running exclusively on **`127.0.0.1`** (localhost).
3. The server assigns a cryptographically unique Scan ID (e.g., `upload_1730000000_a1b2c3d4`) and creates a dedicated, isolated temporary folder inside `temp_uploads/`.
4. Uploaded files are saved using sanitized internal names (`file_0.ext`, `file_1.ext`) to prevent arbitrary file execution and client path injection, while maintaining an in-memory mapping to the original filenames.
5. The Node.js server spawns the native C++ engine (`bin/scanner.exe`) with safe argument arrays (`child_process.spawn()`), targeting the isolated upload path with `--allowed-root` set strictly to the per-scan directory.
6. The C++ engine processes files across worker threads and emits real-time JSON Lines events over stdout.
7. **Immediate Cleanup**: As soon as the scanning process terminates (or in the event of an error/abort), the temporary folder and copies inside `temp_uploads/` are completely removed. The user's original files are never touched.

---

## 🧠 Core Operating Systems Concepts for Viva

### 1. Multithreading vs. Multiprocessing
- **Process**: An executing instance of a program with its own private virtual memory space, file descriptors, and security token.
- **Thread**: The smallest unit of execution scheduled by the OS kernel. Multiple threads of the same process share code, global variables, and heap memory, but each thread has its own private stack and CPU register state.
- **Advantage in ThreadShield**: Creating and switching between threads incurs significantly lower overhead than creating full OS processes.

### 2. Thread Pool & Thread Lifecycle (`std::thread`, `join()`)
- Creating threads on the fly for every single task introduces latency and system thrashing.
- ThreadShield uses a **Thread Pool pattern**: A fixed number of worker threads ($N \in \{1, 2, 4, 8, \text{Auto}\}$) are instantiated at scan start.
- When all tasks have been enqueued, the main thread signals completion and invokes `.join()` on each thread. The `join()` call blocks the main thread until the target thread finishes execution, preventing zombie threads and guaranteeing that all file I/O has flushed.

### 3. Producer-Consumer Paradigm & Thread-Safe Work Queue
- Implemented in `src/scanner.cpp` via the `SafeQueue<T>` class:
  ```cpp
  template <typename T>
  class SafeQueue {
      std::queue<T> queue_;
      mutable std::mutex mutex_;
      std::condition_variable cv_;
      bool finished_ = false;
  };
  ```
- **Producer**: The main thread traverses the target directory and pushes `ScanTask` structs into `SafeQueue`.
- **Consumers**: Worker threads continuously pop tasks from `SafeQueue`.
- **Condition Variables (`std::condition_variable`)**: Rather than spinning in a CPU-intensive busy-wait loop (`while(queue.empty())`), idle worker threads call `cv_.wait(lock)`. The OS puts the thread into a sleeping state until the producer calls `cv_.notify_one()` or `cv_.notify_all()`.

### 4. Dynamic Task Scheduling & Idle Worker Detection
- When files > workers: Each worker processes a file and immediately pops the next file from the queue. Tasks are naturally load-balanced across threads.
- When files < workers: Threads that find the queue empty upon notification immediately exit with `tasks_processed: 0`. ThreadShield flags these workers as `was_active: false` and explicitly displays them in the UI as **"Unassigned / Idle (0 tasks)"** with dashed styling, rather than falsely claiming all configured threads were active.

### 5. Mutual Exclusion (`std::mutex`, `std::lock_guard`, `std::unique_lock`)
- **Race Condition**: Occurs when multiple threads attempt to read and write shared data concurrently, leading to unpredictable results.
- **Critical Sections**: Protected using `std::mutex`:
  - `g_cout_mutex` serializes console stdout writes so that multi-threaded JSON Lines output never tears or interleaves characters.
  - Queue operations are synchronized with `std::lock_guard<std::mutex>`.

### 6. Lock-Free Atomic Operations (`std::atomic<uint64_t>`)
- High-frequency counters (`scanned_count`, `clean_count`, `match_count`, `skipped_count`, `total_bytes`) are implemented using `std::atomic`.
- Atomic instructions leverage hardware-level CPU primitives (`LOCK CMPXCHG` on x86/x64) to update counters without the overhead of mutex acquisition and context switching.

### 7. Amdahl's Law, Speedup, and Efficiency
- **Speedup ($S$)**: Ratio of sequential execution time to parallel execution time:
  $$S = \frac{T_{\text{sequential}}}{T_{\text{parallel}}}$$
- **Parallel Efficiency ($E$)**: Percentage of theoretical linear scaling achieved per thread:
  $$E = \frac{S}{N} \times 100\%$$
- **Diminishing Returns**: According to Amdahl's Law, the maximum speedup of a program is limited by its serial fraction (e.g. directory traversal, thread creation overhead, filesystem disk I/O latency). Beyond the CPU's physical core count (or when bound by disk read speeds), adding more threads introduces scheduling contention without proportional throughput gains.

### 8. Inter-Process Communication (IPC via Unnamed Pipes)
- Express launches the native binary via `child_process.spawn()` with structured argument arrays (immune to shell injection).
- The C++ engine emits newline-delimited JSON objects over its standard output pipe (`stdout`).
- Node.js reads the stdout stream using `readline`, parses events asynchronously, updates the in-memory state, and surfaces them to the client via an HTTP polling API (`/api/scan/status`).

---

## 🏗️ Architecture Diagram

```
+-------------------------------------------------------------------------+
|                  Browser UI (HTML5, CSS3, Vanilla JS)                   |
|  [Multi-File Upload (Drag & Drop)]    [Samples Speedup Benchmark]       |
|  - Mode A (C++ Thread Pool)           - Mode B (Microsoft Defender CLI) |
|  - Real-time worker cards             - Live queue metrics & throughput |
|  - Amdahl's Law scaling graph         - Filterable results table        |
+------------------------------------+------------------------------------+
                                     | Multipart HTTP POST / Polling REST
                                     v
+-------------------------------------------------------------------------+
|                    Node.js Express Controller Server                    |
|                    (Strictly bound to 127.0.0.1:3000)                   |
|  - Multipart file upload validation (multer: max 50 files, 100 MB batch)|
|  - Isolated temp directory creation (temp_uploads/<scanId>/)            |
|  - Path Traversal Guard (validates allowed-root boundaries)             |
|  - Mode A: child_process.spawn("bin/scanner.exe", [args])               |
|  - Mode B: child_process.spawn("MpCmdRun.exe", [-DisableRemediation])   |
|  - Automatic cleanup of temporary upload directories after scan         |
+------------------------------------+------------------------------------+
                                     | stdout (JSON Lines Stream)
                                     v
+-------------------------------------------------------------------------+
|                  ThreadShield Native Engine (C++17)                     |
|                                                                         |
|   [Target Resolver]  ---> Validates target path inside allowed-root     |
|   [SafeQueue]        ---> Synchronized Producer-Consumer queue          |
|                                                                         |
|   [Worker 1]       [Worker 2]       [Worker 3]       [Worker 4]         |
|   (std::thread)    (std::thread)    (std::thread)    (std::thread)      |
|   64 KB chunk I/O  64 KB chunk I/O  64 KB chunk I/O  64 KB chunk I/O    |
|   Overlap boundary Overlap boundary Overlap boundary Overlap boundary   |
|   Binary pattern   Binary pattern   Binary pattern   Binary pattern     |
|                                                                         |
|   [Atomic Stats]   ---> Scanned, Matches, Clean, Bytes, Rate            |
|   [Worker State]   ---> Active vs Idle worker tracking                  |
|   [JSON Emitter]   ---> Mutex-protected line-by-line event emitter      |
|   [Worker Join]    ---> main() calls join() on all active worker threads|
+-------------------------------------------------------------------------+
```

---

## 📁 Project Directory Structure

```
OsLabProject/
├── bin/
│   └── scanner.exe               # Compiled C++ scanning engine binary
├── public/
│   ├── index.html                # Cybersecurity dark-themed dashboard
│   ├── style.css                 # Responsive stylesheet & animations
│   └── app.js                    # Vanilla JS client controller
├── samples/                      # Dedicated preloaded test dataset
│   ├── clean_readme.txt
│   ├── test_detection_alpha.txt
│   ├── security_alert.log
│   ├── archives/
│   ├── logs/
│   ├── nested/deep/
│   ├── reports/
│   └── transactions/
├── scripts/
│   ├── build.bat                 # Windows batch script to compile C++ engine
│   ├── run.bat                   # Batch script to launch ThreadShield
│   └── test.bat                  # Batch script to run the automated test suite
├── server/
│   ├── sample_generator.js       # Generator for harmless test files
│   ├── server.js                 # Express server & process manager
│   └── test_suite.js             # Automated 73-point test suite
├── src/
│   └── scanner.cpp               # C++17 multithreaded scanning engine
├── temp_uploads/                 # Isolated directory for temporary user uploads (gitignored)
├── .gitignore                    # Git ignore file
├── package.json                  # Dependencies & npm scripts
└── README.md                     # Documentation & viva manual
```

---

## 🚀 Windows 11 Setup & Run Instructions

### Prerequisites
1. **Node.js**: v16 or newer (tested on Node.js v24.7.0).
2. **C++17 Compiler**: GCC (`g++`) 7+, Clang++, or MSVC.
   - Recommended on Windows: `w64devkit` (portable GCC 16.2.0), which is automatically detected if extracted to `%LOCALAPPDATA%\w64devkit\bin\g++.exe`.

### 1. Build the C++ Scanning Engine
Run the build script to compile the native engine with C++17 optimizations:
```cmd
scripts\build.bat
```
*Or via npm:*
```cmd
npm run build:cpp
```
This produces `bin\scanner.exe` compiled with `-std=c++17 -O3 -pthread`.

### 2. Generate Test Samples (For Benchmark Mode)
Generate harmless sample files for testing concurrent directory traversal:
```cmd
npm run generate:samples
```

### 3. Launch ThreadShield
Start the dashboard:
```cmd
scripts\run.bat
```
*Or via npm:*
```cmd
npm start
```
The server binds exclusively to `http://127.0.0.1:3000` and automatically opens your web browser.

---

## 🧪 Automated Testing

ThreadShield includes an extensive **73-assertion automated test suite** covering:
- C++ binary existence and compilation integrity.
- Sample dataset generation across nested subdirectories.
- Standalone C++ engine execution across Sequential and Parallel modes (1, 2, 4, 8 workers).
- Auto worker count configuration based on hardware concurrency.
- Deterministic detection of literal test strings (`ALPHA`, `BETA`, `GAMMA`, `DELTA`).
- Automatic skipping of files exceeding `--max-size`.
- Path traversal and security jail verification (`..`, `../..`, external roots).
- Multi-file upload batching (5 files with 2 workers: dynamic task queueing).
- Idle worker verification (2 files with 4 workers: exactly 2 workers marked idle/unassigned).
- User file upload of raw binary files (`.bin`) with embedded null bytes and pattern matching.
- Verification of immediate temporary file cleanup in `temp_uploads/`.
- File size rejection when exceeding limits.
- Mode B Microsoft Defender CLI scan on clean files verifying exit code 0 and non-destructive execution.
- Comparative benchmark metrics and Amdahl's Law calculations.

To run the automated tests:
```cmd
scripts\test.bat
```
*Or via npm:*
```cmd
npm test
```

### Measured Benchmark Sample Results (AMD Ryzen 6-Core / 12-Thread)
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
| `POST` | `/api/scan/upload` | Multipart upload and scan endpoint for user-selected local files (up to 50 files, 100 MB batch) supporting `engine: 'cpp'` or `engine: 'defender'` |
| `POST` | `/api/scan/start` | Initiates scan over `samples/` with `{ mode, workers, signatures, extensions, maxSize }` |
| `GET` | `/api/scan/status` | Polling endpoint returning progress, active worker cards, live results, and summary |
| `POST` | `/api/scan/stop` | Gracefully cancels an active scan and purges temporary files |
| `POST` | `/api/benchmark/run` | Runs comparative speedup benchmark across 1, 2, 4, and 8 worker threads |
| `GET` | `/api/benchmark/status` | Polling endpoint for benchmark execution state and scaling graph |
| `GET` | `/api/system/info` | Reports detected compiler, Defender status, CPU cores, memory, and batch limits |
| `GET` | `/api/samples/test-fixture` | Returns harmless educational test fixture payload |
| `GET` | `/api/samples/info` | Returns file count and size in `./samples/` |
| `POST` | `/api/samples/generate` | Regenerates harmless test dataset in `./samples/` |

---

## 🛡️ License
MIT License. Created for educational and Operating Systems academic laboratory demonstration purposes.
