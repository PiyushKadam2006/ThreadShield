# ThreadShield — Interactive Multithreaded File Scanner
**Operating Systems Laboratory Project • Concurrent Computing & Systems Architecture**

ThreadShield is a high-performance, multithreaded file scanning engine written in **C++17** coupled with an interactive real-time cybersecurity dashboard powered by **Node.js, Express, and Vanilla JavaScript**.

Designed specifically as an Operating Systems lab project and viva presentation system, ThreadShield illustrates core principles of concurrent programming, process scheduling, synchronization primitives, shared-memory safety, inter-process communication (IPC), browser sandbox boundaries, and Amdahl's Law in practice.

---

## ⚠️ Academic Simulation & Safety Limitations
> **Educational Disclaimer**: ThreadShield is strictly an academic demonstration tool.
> - Pattern matches are labeled **"Test signature matched"** or **"No configured test signature matched"**. A clean status does **NOT** indicate a file is safe or free of real malware, and a match does not indicate a security threat.
> - ThreadShield searches strictly for configured literal test strings (`TEST_SIGNATURE_ALPHA`, `TEST_SIGNATURE_BETA`, `TEST_SIGNATURE_GAMMA`, `TEST_SIGNATURE_DELTA`).
> - ThreadShield is **not an antivirus solution**. It does not possess a real virus definitions database or heuristic detection capabilities.
> - The native engine operates in **strict read-only binary mode** (`std::ios::binary | std::ios::in`) and **never executes, modifies, deletes, or quarantines** user files.
> - Scanning is sandboxed to project boundaries (`samples/` and temporary per-scan `temp_uploads/`). All path traversal attempts (`..`, `../..`, external drives) are rejected at both the Express and C++ layers.

---

## 📂 User File Upload Architecture & Browser Sandbox

### Why File Upload is Required
Web browsers execute web applications inside an isolated security sandbox. Browsers do **not** provide client-side web pages with arbitrary, direct access to files on the host's local filesystem (such as reading `C:\Users\...`). 

To scan any file of the user's choosing:
1. The user explicitly selects a local file through an HTML5 `<input type="file">` file picker or drag-and-drop zone.
2. The browser transmits a copy of the selected file via a multipart HTTP `POST` request directly to the local ThreadShield server running exclusively on **`127.0.0.1`** (localhost).
3. The server assigns a cryptographically unique Scan ID (e.g., `upload_1730000000_a1b2c3d4`) and creates a dedicated, isolated temporary folder inside `temp_uploads/`.
4. The uploaded file is saved using a sanitized internal name (e.g. `payload.dat`) to prevent arbitrary file execution and client path injection.
5. The Node.js server spawns the native C++ engine (`bin/scanner.exe`) with safe argument arrays (`child_process.spawn()`), targeting the isolated upload path with `--allowed-root` set strictly to the per-scan directory.
6. The C++ engine processes the file in 64 KB chunks across worker threads and emits real-time JSON Lines events over stdout.
7. **Immediate Cleanup**: As soon as the C++ process terminates (or in the event of an error/abort), the temporary folder and copy inside `temp_uploads/` are completely removed. The user's original file is never touched.

---

## 🧠 Core Operating Systems Concepts for Viva

### 1. Multithreading vs. Multiprocessing
- **Process**: An executing instance of a program with its own private virtual memory space, file handles, and security context.
- **Thread**: The smallest unit of execution scheduled by the OS kernel. Multiple threads of the same process share code, global variables, and heap memory, but each thread has its own private stack and CPU register state.
- **Advantage in ThreadShield**: Creating and switching between threads incurs significantly lower overhead than creating full OS processes.

### 2. Thread Pool & Thread Lifecycle (`std::thread`, `join()`)
- Creating threads on the fly for every single task introduces latency and system thrashing.
- ThreadShield uses a **Thread Pool pattern**: A fixed number of worker threads ($N \in \{1, 2, 4, 8\}$) are instantiated at scan start.
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
- **Producer**: The main thread traverses the target directory or file and pushes `ScanTask` structs into `SafeQueue`.
- **Consumers**: Worker threads continuously pop tasks from `SafeQueue`.
- **Condition Variables (`std::condition_variable`)**: Rather than spinning in a CPU-intensive busy-wait loop (`while(queue.empty())`), idle worker threads call `cv_.wait(lock)`. The OS puts the thread into a sleeping state until the producer calls `cv_.notify_one()` or `cv_.notify_all()`.

### 4. Mutual Exclusion (`std::mutex`, `std::lock_guard`, `std::unique_lock`)
- **Race Condition**: Occurs when multiple threads attempt to read and write shared data concurrently, leading to unpredictable results.
- **Critical Sections**: Protected using `std::mutex`:
  - `g_cout_mutex` serializes console stdout writes so that multi-threaded JSON Lines output never tears or interleaves characters.
  - Queue operations are synchronized with `std::lock_guard<std::mutex>`.

### 5. Lock-Free Atomic Operations (`std::atomic<uint64_t>`)
- High-frequency counters (`scanned_count`, `clean_count`, `match_count`, `skipped_count`, `total_bytes`) are implemented using `std::atomic`.
- Atomic instructions leverage hardware-level CPU primitives (`LOCK CMPXCHG` on x86/x64) to update counters without the overhead of mutex acquisition and context switching.

### 6. Amdahl's Law, Speedup, and Efficiency
- **Speedup ($S$)**: Ratio of sequential execution time to parallel execution time:
  $$S = \frac{T_{\text{sequential}}}{T_{\text{parallel}}}$$
- **Parallel Efficiency ($E$)**: Percentage of theoretical linear scaling achieved per thread:
  $$E = \frac{S}{N} \times 100\%$$
- **Diminishing Returns**: According to Amdahl's Law, the maximum speedup of a program is limited by its serial fraction (e.g. directory traversal, thread creation overhead, filesystem disk I/O latency). Beyond the CPU's physical core count (or when bound by disk read speeds), adding more threads introduces scheduling contention without proportional throughput gains.

### 7. Inter-Process Communication (IPC via Unnamed Pipes)
- Express launches the native binary via `child_process.spawn()` with structured argument arrays (immune to shell injection).
- The C++ engine emits newline-delimited JSON objects over its standard output pipe (`stdout`).
- Node.js reads the stdout stream using `readline`, parses events asynchronously, updates the in-memory state, and surfaces them to the client via an HTTP polling API (`/api/scan/status`).

---

## 🏗️ Architecture Diagram

```
+-------------------------------------------------------------------------+
|                  Browser UI (HTML5, CSS3, Vanilla JS)                   |
|  [Scan Your Own File (Drag & Drop)]   [Samples Speedup Benchmark]       |
|  - Real-time worker cards             - Live throughput & elapsed time  |
|  - Amdahl's Law scaling graph         - Filterable results table        |
+------------------------------------+------------------------------------+
                                     | Multipart HTTP POST / Polling REST
                                     v
+-------------------------------------------------------------------------+
|                    Node.js Express Controller Server                    |
|                    (Strictly bound to 127.0.0.1:3000)                   |
|  - Multipart file upload validation (multer, 25 MB limit)               |
|  - Isolated temp directory creation (temp_uploads/<scanId>/)            |
|  - Path Traversal Guard (validates allowed-root boundaries)             |
|  - child_process.spawn("bin/scanner.exe", [args])                       |
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
│   └── test_suite.js             # Automated 61-point test suite
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

ThreadShield includes an extensive **61-assertion test suite** covering:
- C++ binary existence and compilation integrity.
- Sample dataset generation across nested subdirectories.
- Standalone C++ engine execution across Sequential and Parallel modes (1, 2, 4, 8 workers).
- Deterministic detection of literal test strings (`ALPHA`, `BETA`, `GAMMA`, `DELTA`).
- Automatic skipping of files exceeding `--max-size`.
- Path traversal and security jail verification (`..`, `../..`, external roots).
- User file upload of text files matching `TEST_SIGNATURE_ALPHA`.
- User file upload of clean text files with no matches.
- User file upload of raw binary files (`.bin`) with embedded null bytes and `TEST_SIGNATURE_BETA`.
- Verification of immediate temporary file cleanup in `temp_uploads/`.
- File size rejection when exceeding limits.
- Preservation of comparative benchmark metrics and Amdahl's Law calculations.

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
| **Sequential** | 1 | 9.13 ms | 314.8 MB/s | **1.00x** | 100.0% |
| **Parallel** | 2 | 6.89 ms | 417.3 MB/s | **1.33x** | 66.3% |
| **Parallel** | 4 | 5.11 ms | 563.1 MB/s | **1.79x** | 44.7% |
| **Parallel** | 8 | 5.77 ms | 498.0 MB/s | **1.58x** | 19.8% |

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/scan/upload` | Multipart upload and scan endpoint for user-selected local files (up to 25 MB) |
| `POST` | `/api/scan/start` | Initiates scan over `samples/` with `{ mode, workers, signatures, extensions, maxSize }` |
| `GET` | `/api/scan/status` | Polling endpoint returning progress, active worker cards, live results, and summary |
| `POST` | `/api/scan/stop` | Gracefully cancels an active scan and purges temporary files |
| `POST` | `/api/benchmark/run` | Runs comparative speedup benchmark across 1, 2, 4, and 8 worker threads |
| `GET` | `/api/benchmark/status` | Polling endpoint for benchmark execution state and scaling graph |
| `GET` | `/api/system/info` | Reports detected compiler, executable status, CPU core count, and memory |
| `GET` | `/api/samples/info` | Returns file count and size in `./samples/` |
| `POST` | `/api/samples/generate` | Regenerates harmless test dataset in `./samples/` |

---

## 🛡️ License
MIT License. Created for educational and Operating Systems academic laboratory demonstration purposes.
