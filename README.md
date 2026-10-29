# ThreadShield — Interactive Multithreaded File Scanner
**Operating Systems Laboratory Project • Concurrent Computing & System Architecture**

ThreadShield is a high-performance, multithreaded file scanning engine built in **C++17** coupled with an interactive real-time cybersecurity dashboard powered by **Node.js, Express, and Vanilla JavaScript**.

Designed specifically as an Operating Systems lab project, ThreadShield illustrates core principles of concurrent programming, process scheduling, synchronization primitives, shared-memory safety, inter-process communication (IPC), and Amdahl's Law in practice.

---

## ⚠️ Academic Simulation & Safety Notice
> **Important**: ThreadShield is strictly an educational tool.
> - Pattern matches are labeled **"Educational Test Detections"**, never real malware verdicts.
> - The scanner searches only for known literal test strings (`TEST_SIGNATURE_ALPHA`, `TEST_SIGNATURE_BETA`, `TEST_SIGNATURE_GAMMA`, `TEST_SIGNATURE_DELTA`).
> - The engine runs with **read-only** permissions (`std::ios::binary | std::ios::in`) and **never deletes, modifies, quarantines, or executes** scanned files.
> - Scanning is strictly sandboxed to the project-owned `samples/` directory; all path traversal attempts (`..`, absolute external paths) are rejected by both C++ and Node.js security layers.

---

## 🧠 Core Operating Systems Concepts Demonstrated

1. **Multithreading & Thread Pool Architecture (`std::thread`, `join()`)**:
   - The scanner initializes a configurable pool of worker threads (1, 2, 4, or 8 workers).
   - The main thread collects eligible tasks, pushes them to the queue, calls `queue.finish()`, and waits for all workers using `join()` to ensure clean thread termination.

2. **Thread-Safe Work Queue (Producer-Consumer Pattern)**:
   - Implemented via a generic `SafeQueue<T>` class using `std::queue`, `std::mutex`, and `std::condition_variable`.
   - Prevents busy waiting: idle workers sleep on `cv_.wait()` until tasks are enqueued or shutdown is signaled.

3. **Mutual Exclusion & Concurrency Control (`std::mutex`, `std::lock_guard`, `std::atomic`)**:
   - `std::mutex g_cout_mutex` protects standard output to guarantee that JSON Lines events emitted by concurrent threads do not interleave or tear characters.
   - Lock-free `std::atomic<uint64_t>` counters track scanned files, clean files, detections, and byte throughput without mutex contention.

4. **Speedup & Amdahl's Law ($S = T_{\text{seq}} / T_{\text{par}}$)**:
   - Measures real-world execution time across 1, 2, 4, and 8 worker threads over the identical sample set.
   - Evaluates parallel efficiency ($E = S / N \times 100\%$) and demonstrates diminishing returns due to synchronization overhead and I/O bottlenecks.

5. **Inter-Process Communication (IPC via `child_process.spawn()`)**:
   - The Express backend spawns the native C++ executable using argument arrays (preventing shell injection).
   - Asynchronous line-by-line streaming of structured JSON Lines (`stdout`) enables live dashboard updates.

6. **Directory Traversal & Path Sandboxing**:
   - Uses `std::filesystem::weakly_canonical` to resolve true paths and guarantees that the target path prefix matches `samples/`.

---

## 🏗️ Architecture

```
+-------------------------------------------------------------------+
|               Browser Dashboard (HTML5 / CSS3 / Vanilla JS)       |
|  - Real-time worker cards    - Throughput / Elapsed time metrics  |
|  - Speedup benchmark graph   - Filterable results table           |
+---------------------------------+---------------------------------+
                                  | Polling HTTP REST API
                                  v
+-------------------------------------------------------------------+
|                     Node.js / Express Server                      |
|                  (Strictly bound to 127.0.0.1:3000)               |
|  - Validates inputs (mode, workers, max-size, signatures)         |
|  - Rejects path traversal                                         |
|  - child_process.spawn("bin/scanner.exe", [args])                 |
+---------------------------------+---------------------------------+
                                  | child_process stdout (JSON Lines)
                                  v
+-------------------------------------------------------------------+
|               ThreadShield Native Engine (C++17)                  |
|                                                                   |
|   [Main Thread] ---> Discovers files in ./samples/                |
|                      Pushes tasks to SafeQueue                    |
|                                                                   |
|   [SafeQueue]    ---> Synchronized with std::mutex & std::cv      |
|                      Producer-Consumer Work Distribution          |
|                                                                   |
|   [Worker 1]     [Worker 2]     [Worker 3]     [Worker 4]         |
|   (std::thread)  (std::thread)  (std::thread)  (std::thread)      |
|   Reads chunk    Reads chunk    Reads chunk    Reads chunk        |
|   Pattern match  Pattern match  Pattern match  Pattern match      |
|                                                                   |
|   [Atomic Stats] ---> Scanned, Matches, Clean, Bytes, Rate        |
|   [JSON Emitter] ---> Synchronized line-by-line output            |
+-------------------------------------------------------------------+
```

---

## 📁 Project Directory Structure

```
OsLabProject/
├── bin/
│   └── scanner.exe               # Compiled C++ scanning executable
├── public/
│   ├── index.html                # Cybersecurity dark theme dashboard
│   ├── style.css                 # Responsive stylesheet
│   └── app.js                    # Vanilla JS dashboard controller
├── samples/                      # Dedicated project-owned samples directory
│   ├── clean_readme.txt
│   ├── test_detection_alpha.txt
│   ├── security_alert.log
│   ├── archives/
│   │   ├── huge_payload.log      # Oversized test file (tests --max-size)
│   │   └── backup_data.bin       # Non-target extension (tests filter)
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
│   └── test_suite.js             # Automated 48-point test suite
├── src/
│   └── scanner.cpp               # C++17 multithreaded scanning engine
├── .gitignore                    # Git ignore file
├── package.json                  # Dependencies & npm scripts
└── README.md                     # Documentation & project manual
```

---

## 🚀 Quick Start Guide

### Prerequisites
1. **Node.js**: v16+ (tested on Node.js v24.7.0).
2. **C++17 Compiler**: GCC (`g++`) 7+, Clang++, or MSVC.
   - A portable GCC 16.2.0 toolchain (`w64devkit`) is automatically detected if extracted to `%LOCALAPPDATA%\w64devkit\bin\g++.exe`.

### 1. Build the C++ Engine
Run the build script to compile the native scanning binary:
```cmd
scripts\build.bat
```
*Or via npm:*
```cmd
npm run build:cpp
```
This compiles `src/scanner.cpp` into `bin/scanner.exe` with `-std=c++17 -O3 -pthread`.

### 2. Generate Test Samples
Generate the initial harmless test dataset inside `samples/`:
```cmd
npm run generate:samples
```

### 3. Run the Dashboard
Start the application:
```cmd
scripts\run.bat
```
*Or via npm:*
```cmd
npm start
```
The server will bind strictly to `http://127.0.0.1:3000` and launch in your default web browser.

---

## 🧪 Automated Testing

ThreadShield includes a 48-assertion automated test suite that verifies:
- C++ compilation and binary existence.
- Sample dataset generation (nested directories, clean files, signatures, oversized files, filtered extensions).
- Correct sequential and parallel execution across 1, 2, 4, and 8 worker threads.
- Deterministic detection of test signatures (`ALPHA`, `BETA`, `GAMMA`, `DELTA`).
- Automatic skipping of files exceeding `--max-size`.
- Path traversal and security jail verification (`..`, `../..`, `C:\Windows`).
- Express REST API endpoints (`/api/system/info`, `/api/samples/info`, `/api/scan/start`, `/api/scan/status`, `/api/benchmark/run`).

To run the full test suite:
```cmd
scripts\test.bat
```
*Or via npm:*
```cmd
npm test
```

### Sample Benchmark Results
Run on AMD Ryzen 8-Core Processor:
| Mode | Workers | Elapsed Time | Throughput | Speedup | Efficiency |
|---|---|---|---|---|---|
| **Sequential** | 1 | 8.77 ms | 327.8 MB/s | **1.00x** | 100.0% |
| **Parallel** | 2 | 7.03 ms | 409.0 MB/s | **1.25x** | 62.4% |
| **Parallel** | 4 | 4.72 ms | 609.8 MB/s | **1.86x** | 46.5% |
| **Parallel** | 8 | 5.69 ms | 505.0 MB/s | **1.54x** | 19.3% |

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/system/info` | Reports detected compiler, binary status, CPU core count, and memory |
| `GET` | `/api/samples/info` | Returns count and total bytes of files in `./samples/` |
| `POST` | `/api/samples/generate` | Regenerates harmless test dataset in `./samples/` |
| `POST` | `/api/scan/start` | Initiates a scan with payload `{ mode, workers, signatures, extensions, maxSize }` |
| `GET` | `/api/scan/status` | Polling endpoint returning progress, worker cards, logs, and results |
| `POST` | `/api/scan/stop` | Terminates an active scan process safely |
| `POST` | `/api/benchmark/run` | Executes sequential vs parallel benchmark across 1, 2, 4, and 8 workers |
| `GET` | `/api/benchmark/status` | Returns progress and comparative metrics for the benchmark run |

---

## 🛡️ License
MIT License. Created for educational and Operating Systems academic demonstration purposes.

