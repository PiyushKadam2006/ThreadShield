#include <iostream>
#include <string>
#include <vector>
#include <queue>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <chrono>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <filesystem>
#include <iomanip>

namespace fs = std::filesystem;

// Thread-safe generic queue for producer-consumer scanning
template <typename T>
class SafeQueue {
private:
    std::queue<T> queue_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    bool finished_ = false;

public:
    void push(T item) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            queue_.push(std::move(item));
        }
        cv_.notify_one();
    }

    bool pop(T& item) {
        std::unique_lock<std::mutex> lock(mutex_);
        while (queue_.empty() && !finished_) {
            cv_.wait(lock);
        }
        if (queue_.empty() && finished_) {
            return false;
        }
        item = std::move(queue_.front());
        queue_.pop();
        return true;
    }

    void finish() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            finished_ = true;
        }
        cv_.notify_all();
    }

    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return queue_.size();
    }
};

// Configuration options
struct ScanOptions {
    std::string target_dir;
    std::string canonical_samples_root;
    std::string mode = "parallel"; // "sequential" or "parallel"
    int worker_count = 4;
    std::vector<std::string> signatures;
    std::vector<std::string> extensions;
    uint64_t max_file_size = 10 * 1024 * 1024; // 10MB default
};

struct ScanTask {
    std::string relative_path;
    std::string full_path;
    uint64_t file_size = 0;
};

struct FileScanResult {
    int worker_id;
    std::string relative_path;
    std::string status; // "CLEAN", "MATCH", "SKIPPED", "ERROR"
    std::vector<std::string> matched_signatures;
    uint64_t bytes_scanned = 0;
    int64_t duration_us = 0;
    std::string message;
};

// Global synchronized console output
std::mutex g_cout_mutex;

std::string escape_json(const std::string& input) {
    std::ostringstream ss;
    for (char c : input) {
        switch (c) {
            case '"':  ss << "\\\""; break;
            case '\\': ss << "\\\\"; break;
            case '\b': ss << "\\b";  break;
            case '\f': ss << "\\f";  break;
            case '\n': ss << "\\n";  break;
            case '\r': ss << "\\r";  break;
            case '\t': ss << "\\t";  break;
            default:
                if ('\x00' <= c && c <= '\x1f') {
                    ss << "\\u" << std::hex << std::setw(4) << std::setfill('0') << (int)c;
                } else {
                    ss << c;
                }
        }
    }
    return ss.str();
}

void emit_json_line(const std::string& json_str) {
    std::lock_guard<std::mutex> lock(g_cout_mutex);
    std::cout << json_str << "\n" << std::flush;
}

// Normalize path with forward slashes for clean JSON display
std::string normalize_path_display(const std::string& p) {
    std::string res = p;
    std::replace(res.begin(), res.end(), '\\', '/');
    return res;
}

// Scans an individual file safely in read-only chunks
FileScanResult scan_single_file(int worker_id, const ScanTask& task, const ScanOptions& options) {
    auto start_time = std::chrono::high_resolution_clock::now();
    FileScanResult result;
    result.worker_id = worker_id;
    result.relative_path = normalize_path_display(task.relative_path);
    result.bytes_scanned = 0;

    // 1. Check size limit
    if (task.file_size > options.max_file_size) {
        auto end_time = std::chrono::high_resolution_clock::now();
        result.status = "SKIPPED";
        result.message = "Exceeds maximum configured file size limit";
        result.duration_us = std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time).count();
        return result;
    }

    // 2. Open file strictly read-only
    std::ifstream file(task.full_path, std::ios::binary);
    if (!file.is_open()) {
        auto end_time = std::chrono::high_resolution_clock::now();
        result.status = "ERROR";
        result.message = "Failed to open file for read access";
        result.duration_us = std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time).count();
        return result;
    }

    // Determine max signature length to maintain overlap boundary
    size_t max_sig_len = 0;
    for (const auto& sig : options.signatures) {
        if (sig.length() > max_sig_len) {
            max_sig_len = sig.length();
        }
    }

    const size_t CHUNK_SIZE = 64 * 1024; // 64 KB
    std::vector<char> buffer(CHUNK_SIZE);
    std::string carry_over = "";
    std::vector<std::string> found_signatures;

    while (file) {
        file.read(buffer.data(), CHUNK_SIZE);
        std::streamsize bytes_read = file.gcount();
        if (bytes_read <= 0) break;

        result.bytes_scanned += static_cast<uint64_t>(bytes_read);

        // Build search chunk including carry-over from previous block to avoid missing boundary splits
        std::string current_chunk = carry_over;
        current_chunk.append(buffer.data(), bytes_read);

        // Scan chunk for all enabled signatures
        for (const auto& sig : options.signatures) {
            if (std::find(found_signatures.begin(), found_signatures.end(), sig) == found_signatures.end()) {
                if (current_chunk.find(sig) != std::string::npos) {
                    found_signatures.push_back(sig);
                }
            }
        }

        // Maintain carry-over buffer for next chunk
        if (current_chunk.length() > max_sig_len) {
            carry_over = current_chunk.substr(current_chunk.length() - max_sig_len);
        } else {
            carry_over = current_chunk;
        }
    }

    auto end_time = std::chrono::high_resolution_clock::now();
    result.duration_us = std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time).count();

    if (!found_signatures.empty()) {
        result.status = "MATCH";
        result.matched_signatures = found_signatures;
        result.message = "Educational test detection: matched test signature pattern(s)";
    } else {
        result.status = "CLEAN";
        result.message = "No test signatures detected";
    }

    return result;
}

// Worker thread routine
void worker_thread_func(int worker_id, 
                        SafeQueue<ScanTask>& queue, 
                        const ScanOptions& options,
                        std::atomic<uint64_t>& scanned_count,
                        std::atomic<uint64_t>& clean_count,
                        std::atomic<uint64_t>& match_count,
                        std::atomic<uint64_t>& skipped_count,
                        std::atomic<uint64_t>& error_count,
                        std::atomic<uint64_t>& total_bytes,
                        size_t total_tasks) 
{
    ScanTask task;
    while (queue.pop(task)) {
        // Emit file_start event
        {
            std::ostringstream ss;
            ss << "{\"type\":\"file_start\","
               << "\"worker_id\":" << worker_id << ","
               << "\"file\":\"" << escape_json(normalize_path_display(task.relative_path)) << "\","
               << "\"file_size\":" << task.file_size
               << "}";
            emit_json_line(ss.str());
        }

        // Perform actual scanning
        FileScanResult res = scan_single_file(worker_id, task, options);

        // Update statistics
        scanned_count.fetch_add(1, std::memory_order_relaxed);
        total_bytes.fetch_add(res.bytes_scanned, std::memory_order_relaxed);

        if (res.status == "MATCH") {
            match_count.fetch_add(1, std::memory_order_relaxed);
        } else if (res.status == "CLEAN") {
            clean_count.fetch_add(1, std::memory_order_relaxed);
        } else if (res.status == "SKIPPED") {
            skipped_count.fetch_add(1, std::memory_order_relaxed);
        } else {
            error_count.fetch_add(1, std::memory_order_relaxed);
        }

        // Emit file_done event
        {
            std::ostringstream ss;
            ss << "{\"type\":\"file_done\","
               << "\"worker_id\":" << worker_id << ","
               << "\"file\":\"" << escape_json(res.relative_path) << "\","
               << "\"file_size\":" << task.file_size << ","
               << "\"status\":\"" << res.status << "\","
               << "\"bytes_scanned\":" << res.bytes_scanned << ","
               << "\"duration_us\":" << res.duration_us << ","
               << "\"message\":\"" << escape_json(res.message) << "\",\"signatures\":[";
            for (size_t i = 0; i < res.matched_signatures.size(); ++i) {
                if (i > 0) ss << ",";
                ss << "\"" << escape_json(res.matched_signatures[i]) << "\"";
            }
            ss << "]}";
            emit_json_line(ss.str());
        }

        // Emit periodic progress event
        uint64_t current_scanned = scanned_count.load(std::memory_order_relaxed);
        double pct = (total_tasks > 0) ? (static_cast<double>(current_scanned) / total_tasks * 100.0) : 100.0;
        {
            std::ostringstream ss;
            ss << "{\"type\":\"progress\","
               << "\"scanned_files\":" << current_scanned << ","
               << "\"total_files\":" << total_tasks << ","
               << "\"percentage\":" << std::fixed << std::setprecision(1) << pct
               << "}";
            emit_json_line(ss.str());
        }
    }

    // Worker idle / stopped
    {
        std::ostringstream ss;
        ss << "{\"type\":\"worker_stopped\",\"worker_id\":" << worker_id << "}";
        emit_json_line(ss.str());
    }
}

// Argument parsing helper
std::vector<std::string> split_comma(const std::string& s) {
    std::vector<std::string> tokens;
    std::stringstream ss(s);
    std::string token;
    while (std::getline(ss, token, ',')) {
        // trim whitespace
        token.erase(0, token.find_first_not_of(" \t\r\n"));
        token.erase(token.find_last_not_of(" \t\r\n") + 1);
        if (!token.empty()) {
            tokens.push_back(token);
        }
    }
    return tokens;
}

int main(int argc, char* argv[]) {
    ScanOptions options;
    std::string input_dir = "samples";

    // Default test signatures
    options.signatures = {
        "TEST_SIGNATURE_ALPHA",
        "TEST_SIGNATURE_BETA",
        "TEST_SIGNATURE_GAMMA",
        "TEST_SIGNATURE_DELTA"
    };

    // Default target extensions
    options.extensions = { ".txt", ".log", ".csv" };

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--dir" && i + 1 < argc) {
            input_dir = argv[++i];
        } else if (arg == "--mode" && i + 1 < argc) {
            options.mode = argv[++i];
        } else if (arg == "--workers" && i + 1 < argc) {
            options.worker_count = std::stoi(argv[++i]);
        } else if (arg == "--signatures" && i + 1 < argc) {
            std::vector<std::string> parsed = split_comma(argv[++i]);
            if (!parsed.empty()) options.signatures = parsed;
        } else if (arg == "--extensions" && i + 1 < argc) {
            options.extensions = split_comma(argv[++i]);
        } else if (arg == "--max-size" && i + 1 < argc) {
            options.max_file_size = std::stoull(argv[++i]);
        }
    }

    // Clamp workers
    if (options.mode == "sequential") {
        options.worker_count = 1;
    } else {
        if (options.worker_count <= 0) options.worker_count = 1;
        if (options.worker_count > 32) options.worker_count = 32;
    }

    // Security Verification: Target must strictly reside within dedicated samples/ directory
    try {
        fs::path samples_root = fs::current_path() / "samples";
        if (!fs::exists(samples_root)) {
            fs::create_directories(samples_root);
        }
        std::string canonical_root = fs::weakly_canonical(samples_root).string();
        options.canonical_samples_root = canonical_root;

        fs::path requested_path = fs::path(input_dir);
        if (!requested_path.is_absolute()) {
            requested_path = fs::current_path() / requested_path;
        }
        std::string canonical_requested = fs::weakly_canonical(requested_path).string();

        // Check if canonical_requested starts with canonical_root
        if (canonical_requested.rfind(canonical_root, 0) != 0) {
            std::ostringstream ss;
            ss << "{\"type\":\"error\",\"message\":\"Security violation: Scan target path '"
               << escape_json(input_dir)
               << "' is outside the dedicated samples/ directory. Scans are strictly restricted to samples/.\"}";
            emit_json_line(ss.str());
            return 1;
        }
        options.target_dir = canonical_requested;
    } catch (const std::exception& e) {
        std::ostringstream ss;
        ss << "{\"type\":\"error\",\"message\":\"Filesystem security check failed: "
           << escape_json(e.what()) << "\"}";
        emit_json_line(ss.str());
        return 1;
    }

    // Collect all candidate files
    std::vector<ScanTask> tasks;
    try {
        if (fs::exists(options.target_dir) && fs::is_directory(options.target_dir)) {
            for (const auto& entry : fs::recursive_directory_iterator(options.target_dir)) {
                if (entry.is_regular_file()) {
                    std::string ext = entry.path().extension().string();
                    // Lowercase extension
                    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

                    // Check extension filter
                    bool ext_matched = false;
                    if (options.extensions.empty()) {
                        ext_matched = true;
                    } else {
                        for (const auto& target_ext : options.extensions) {
                            std::string lext = target_ext;
                            std::transform(lext.begin(), lext.end(), lext.begin(), ::tolower);
                            if (lext == ext) {
                                ext_matched = true;
                                break;
                            }
                        }
                    }

                    if (ext_matched) {
                        ScanTask task;
                        task.full_path = entry.path().string();
                        // Relative path from samples root
                        task.relative_path = fs::relative(entry.path(), options.canonical_samples_root).string();
                        task.file_size = static_cast<uint64_t>(entry.file_size());
                        tasks.push_back(task);
                    }
                }
            }
        }
    } catch (const std::exception& e) {
        std::ostringstream ss;
        ss << "{\"type\":\"error\",\"message\":\"Error traversing target directory: "
           << escape_json(e.what()) << "\"}";
        emit_json_line(ss.str());
        return 1;
    }

    // Emit startup initialization event
    {
        std::ostringstream ss;
        ss << "{\"type\":\"init\","
           << "\"mode\":\"" << options.mode << "\","
           << "\"worker_count\":" << options.worker_count << ","
           << "\"total_files\":" << tasks.size() << ","
           << "\"target_dir\":\"" << escape_json(normalize_path_display(input_dir)) << "\","
           << "\"max_size\":" << options.max_file_size << ","
           << "\"signatures\":[";
        for (size_t i = 0; i < options.signatures.size(); ++i) {
            if (i > 0) ss << ",";
            ss << "\"" << escape_json(options.signatures[i]) << "\"";
        }
        ss << "],\"extensions\":[";
        for (size_t i = 0; i < options.extensions.size(); ++i) {
            if (i > 0) ss << ",";
            ss << "\"" << escape_json(options.extensions[i]) << "\"";
        }
        ss << "]}";
        emit_json_line(ss.str());
    }

    // Shared counters
    std::atomic<uint64_t> scanned_count{0};
    std::atomic<uint64_t> clean_count{0};
    std::atomic<uint64_t> match_count{0};
    std::atomic<uint64_t> skipped_count{0};
    std::atomic<uint64_t> error_count{0};
    std::atomic<uint64_t> total_bytes{0};

    SafeQueue<ScanTask> task_queue;

    auto global_start_time = std::chrono::high_resolution_clock::now();

    // Spawn worker threads
    std::vector<std::thread> workers;
    workers.reserve(options.worker_count);
    for (int i = 0; i < options.worker_count; ++i) {
        workers.emplace_back(worker_thread_func,
                             i + 1, // 1-indexed worker ID
                             std::ref(task_queue),
                             std::cref(options),
                             std::ref(scanned_count),
                             std::ref(clean_count),
                             std::ref(match_count),
                             std::ref(skipped_count),
                             std::ref(error_count),
                             std::ref(total_bytes),
                             tasks.size());
    }

    // Enqueue tasks
    for (auto& task : tasks) {
        task_queue.push(std::move(task));
    }

    // Signal completion of work queue
    task_queue.finish();

    // Join all worker threads
    for (auto& worker : workers) {
        if (worker.joinable()) {
            worker.join();
        }
    }

    auto global_end_time = std::chrono::high_resolution_clock::now();
    double elapsed_ms = std::chrono::duration<double, std::milli>(global_end_time - global_start_time).count();
    double elapsed_sec = elapsed_ms / 1000.0;
    if (elapsed_sec <= 0.0) elapsed_sec = 0.0001;

    double total_mb = static_cast<double>(total_bytes.load()) / (1024.0 * 1024.0);
    double throughput_mb_s = total_mb / elapsed_sec;
    double files_per_sec = static_cast<double>(scanned_count.load()) / elapsed_sec;

    // Emit final summary JSON line
    {
        std::ostringstream ss;
        ss << "{\"type\":\"summary\","
           << "\"mode\":\"" << options.mode << "\","
           << "\"worker_count\":" << options.worker_count << ","
           << "\"total_files\":" << tasks.size() << ","
           << "\"scanned_files\":" << scanned_count.load() << ","
           << "\"clean_files\":" << clean_count.load() << ","
           << "\"matched_files\":" << match_count.load() << ","
           << "\"skipped_files\":" << skipped_count.load() << ","
           << "\"error_files\":" << error_count.load() << ","
           << "\"total_bytes\":" << total_bytes.load() << ","
           << "\"elapsed_ms\":" << std::fixed << std::setprecision(2) << elapsed_ms << ","
           << "\"throughput_mb_s\":" << std::fixed << std::setprecision(2) << throughput_mb_s << ","
           << "\"files_per_sec\":" << std::fixed << std::setprecision(1) << files_per_sec
           << "}";
        emit_json_line(ss.str());
    }

    return 0;
}

