// Minimal sampling profiler for one thread of another process (Windows x64).
// Suspends the thread ~1000 times a second, walks its stack with dbghelp and prints where the time
// goes: exclusive ("self") and inclusive ("total") per function. The target never runs our code;
// it is only paused for the few microseconds a stack walk takes.
//
//   sampler <pid> [thread-name-substring] [seconds] [depth]
//   sampler <pid> --threads [seconds]       CPU use of every named thread
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dbghelp.h>
#include <timeapi.h>
#include <tlhelp32.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>
#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "winmm.lib")

struct ThreadInfo {
    DWORD tid;
    std::wstring name;
    HANDLE handle;
    ULONGLONG cpu0;
};

static ULONGLONG CpuTime(HANDLE h) {
    FILETIME c, e, k, u;
    if (!GetThreadTimes(h, &c, &e, &k, &u))
        return 0;
    return (ULARGE_INTEGER{k.dwLowDateTime, k.dwHighDateTime}.QuadPart +
            ULARGE_INTEGER{u.dwLowDateTime, u.dwHighDateTime}.QuadPart);
}

static std::vector<ThreadInfo> Threads(DWORD pid) {
    std::vector<ThreadInfo> out;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    THREADENTRY32 te{sizeof(te)};
    for (BOOL ok = Thread32First(snap, &te); ok; ok = Thread32Next(snap, &te)) {
        if (te.th32OwnerProcessID != pid)
            continue;
        HANDLE h = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
                              FALSE, te.th32ThreadID);
        if (!h)
            continue;
        PWSTR desc = nullptr;
        std::wstring name;
        if (SUCCEEDED(GetThreadDescription(h, &desc)) && desc) {
            name = desc;
            LocalFree(desc);
        }
        out.push_back({te.th32ThreadID, name, h, CpuTime(h)});
    }
    CloseHandle(snap);
    return out;
}

static std::string Narrow(const std::wstring& w) {
    std::string s;
    for (wchar_t c : w)
        s += c < 128 ? char(c) : '?';
    return s;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: sampler <pid> [thread-name|--threads] [seconds] [depth]\n");
        return 2;
    }
    const DWORD pid = std::strtoul(argv[1], nullptr, 10);
    const std::string want = argc > 2 ? argv[2] : "GpuCommandProcessor";
    const double seconds = argc > 3 ? std::atof(argv[3]) : 20.0;
    const int max_depth = argc > 4 ? std::atoi(argv[4]) : 48;

    auto threads = Threads(pid);
    if (threads.empty()) {
        std::fprintf(stderr, "no threads (pid %lu not found or access denied)\n", pid);
        return 1;
    }

    if (want == "--threads") {
        const auto t0 = std::chrono::steady_clock::now();
        Sleep(DWORD(seconds * 1000));
        const double wall =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::vector<std::pair<double, std::string>> rows;
        for (auto& t : threads) {
            const double busy = (CpuTime(t.handle) - t.cpu0) / 1e7 / wall * 100.0;
            if (busy >= 1.0)
                rows.push_back({busy, Narrow(t.name.empty() ? L"(unnamed)" : t.name) + " #" +
                                          std::to_string(t.tid)});
        }
        std::sort(rows.rbegin(), rows.rend());
        for (auto& [busy, name] : rows)
            std::printf("%6.1f%%  %s\n", busy, name.c_str());
        return 0;
    }

    ThreadInfo* target = nullptr;
    for (auto& t : threads)
        if (Narrow(t.name).find(want) != std::string::npos)
            target = &t;
    if (!target) {
        std::fprintf(stderr, "no thread named *%s*\n", want.c_str());
        return 1;
    }

    HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!proc) {
        std::fprintf(stderr, "OpenProcess failed (%lu)\n", GetLastError());
        return 1;
    }
    SymSetOptions(SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES);
    if (!SymInitialize(proc, nullptr, TRUE)) {
        std::fprintf(stderr, "SymInitialize failed (%lu)\n", GetLastError());
        return 1;
    }

    timeBeginPeriod(1);
    std::vector<std::vector<DWORD64>> stacks;
    stacks.reserve(size_t(seconds * 1100));
    const ULONGLONG cpu0 = CpuTime(target->handle);
    const auto t0 = std::chrono::steady_clock::now();
    const auto until = t0 + std::chrono::duration<double>(seconds);
    size_t idle = 0;
    ULONGLONG last_cpu = cpu0;
    while (std::chrono::steady_clock::now() < until) {
        Sleep(1);
        // Skip samples where the thread did not run since the last one (waiting / blocked), so
        // the profile shows where the CPU time goes rather than where it sleeps.
        const ULONGLONG cpu = CpuTime(target->handle);
        const bool ran = cpu != last_cpu;
        last_cpu = cpu;
        if (SuspendThread(target->handle) == DWORD(-1))
            break;
        CONTEXT ctx{};
        ctx.ContextFlags = CONTEXT_FULL;
        std::vector<DWORD64> stack;
        if (GetThreadContext(target->handle, &ctx)) {
            STACKFRAME64 frame{};
            frame.AddrPC = {ctx.Rip, 0, AddrModeFlat};
            frame.AddrFrame = {ctx.Rbp, 0, AddrModeFlat};
            frame.AddrStack = {ctx.Rsp, 0, AddrModeFlat};
            while (int(stack.size()) < max_depth &&
                   StackWalk64(IMAGE_FILE_MACHINE_AMD64, proc, target->handle, &frame, &ctx,
                               nullptr, SymFunctionTableAccess64, SymGetModuleBase64, nullptr) &&
                   frame.AddrPC.Offset) {
                stack.push_back(frame.AddrPC.Offset);
            }
        }
        ResumeThread(target->handle);
        if (!ran) {
            ++idle;
            continue;
        }
        if (!stack.empty())
            stacks.push_back(std::move(stack));
    }
    timeEndPeriod(1);
    const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const double busy = (CpuTime(target->handle) - cpu0) / 1e7 / wall * 100.0;

    std::unordered_map<DWORD64, std::string> names;
    auto name_of = [&](DWORD64 addr) -> const std::string& {
        auto it = names.find(addr);
        if (it != names.end())
            return it->second;
        alignas(SYMBOL_INFO) char buf[sizeof(SYMBOL_INFO) + 512];
        auto* sym = reinterpret_cast<SYMBOL_INFO*>(buf);
        sym->SizeOfStruct = sizeof(SYMBOL_INFO);
        sym->MaxNameLen = 511;
        DWORD64 disp = 0;
        std::string n;
        if (SymFromAddr(proc, addr, &disp, sym)) {
            n = sym->Name;
        } else {
            IMAGEHLP_MODULE64 mod{sizeof(mod)};
            n = SymGetModuleInfo64(proc, addr, &mod) ? std::string(mod.ModuleName) + "!?"
                                                     : "<guest/jit>";
        }
        return names.emplace(addr, n).first->second;
    };

    std::map<std::string, size_t> self, total;
    for (auto& st : stacks) {
        self[name_of(st[0])]++;
        std::set<std::string> seen;
        for (auto a : st)
            if (seen.insert(name_of(a)).second)
                total[name_of(a)]++;
    }
    auto print = [&](const char* title, std::map<std::string, size_t>& m, int n) {
        std::vector<std::pair<size_t, std::string>> v;
        for (auto& [k, c] : m)
            v.push_back({c, k});
        std::sort(v.rbegin(), v.rend());
        std::printf("\n%s\n", title);
        for (int i = 0; i < n && i < int(v.size()); ++i)
            std::printf("%6.1f%%  %.150s\n", 100.0 * v[i].first / stacks.size(), v[i].second.c_str());
    };
    std::printf("thread %s #%lu: %.1f%% of a core busy over %.1f s, %zu samples (%zu idle skipped)\n",
                Narrow(target->name).c_str(), target->tid, busy, wall, stacks.size(), idle);
    print("SELF (time spent in the function itself)", self, 40);
    print("TOTAL (time in the function and everything it calls)", total, 60);
    SymCleanup(proc);
    return 0;
}
