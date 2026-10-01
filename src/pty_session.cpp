#include "pty_session.h"

#include <algorithm>
#include <map>
#include <vector>

namespace {

// Сколько байт в конце буфера образуют незавершённую UTF-8 последовательность.
size_t IncompleteUtf8Tail(const std::string& s) {
    const size_t n = s.size();
    for (size_t back = 1; back <= 3 && back <= n; ++back) {
        const unsigned char c = static_cast<unsigned char>(s[n - back]);
        if ((c & 0xC0) == 0x80) continue;  // байт продолжения — идём дальше назад
        size_t need = 1;
        if ((c & 0xE0) == 0xC0) need = 2;
        else if ((c & 0xF0) == 0xE0) need = 3;
        else if ((c & 0xF8) == 0xF0) need = 4;
        return need > back ? back : 0;
    }
    return 0;
}

// Блок окружения для CreateProcessW: текущее окружение, поверх него extra (имена без учёта регистра).
std::wstring BuildEnvironmentBlock(const std::vector<std::pair<std::wstring, std::wstring>>& extra) {
    auto upper = [](std::wstring s) {
        std::transform(s.begin(), s.end(), s.begin(), towupper);
        return s;
    };
    std::map<std::wstring, std::wstring> vars;  // ключ в верхнем регистре → «ИМЯ=значение»
    if (LPWCH cur = GetEnvironmentStringsW()) {
        for (LPWCH p = cur; *p; p += wcslen(p) + 1) {
            std::wstring entry = p;
            size_t eq = entry.find(L'=', 1);  // у служебных переменных вида «=C:» имя начинается с «=»
            if (eq != std::wstring::npos) vars[upper(entry.substr(0, eq))] = entry;
        }
        FreeEnvironmentStringsW(cur);
    }
    for (const auto& [name, value] : extra) vars[upper(name)] = name + L"=" + value;
    std::wstring block;
    for (const auto& [key, entry] : vars) block.append(entry).push_back(L'\0');
    block.push_back(L'\0');
    return block;
}

}  // namespace

PtySession::PtySession(int id, NotifyFn onOutput, NotifyFn onExit)
    : id_(id), onOutput_(std::move(onOutput)), onExit_(std::move(onExit)) {}

PtySession::~PtySession() {
    if (process_ && !exited_) Terminate();
    if (waiter_.joinable()) waiter_.join();
    if (reader_.joinable()) reader_.join();  // если waiter так и не стартовал
    {
        std::lock_guard<std::mutex> lock(pcMutex_);
        if (pc_) ClosePseudoConsole(pc_);
        pc_ = nullptr;
    }
    if (inWrite_) CloseHandle(inWrite_);
    if (outRead_) CloseHandle(outRead_);
    if (process_) CloseHandle(process_);
}

bool PtySession::Start(const std::wstring& commandLine, const std::wstring& cwd, short cols, short rows, HANDLE job,
                       std::wstring* error, const std::vector<std::pair<std::wstring, std::wstring>>& extraEnv) {
    auto fail = [&](const wchar_t* what) {
        if (error) *error = std::wstring(what) + L" (код " + std::to_wstring(GetLastError()) + L")";
        return false;
    };

    HANDLE ptyIn = nullptr, ptyOut = nullptr;
    if (!CreatePipe(&ptyIn, &inWrite_, nullptr, 0)) return fail(L"CreatePipe (ввод)");
    if (!CreatePipe(&outRead_, &ptyOut, nullptr, 0)) {
        CloseHandle(ptyIn);
        return fail(L"CreatePipe (вывод)");
    }

    HRESULT hr = CreatePseudoConsole(COORD{cols, rows}, ptyIn, ptyOut, 0, &pc_);
    // Псевдоконсоль дублирует себе эти концы каналов — наши копии больше не нужны.
    CloseHandle(ptyIn);
    CloseHandle(ptyOut);
    if (FAILED(hr)) {
        SetLastError(hr);
        return fail(L"CreatePseudoConsole");
    }

    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
    std::vector<BYTE> attrBuf(attrSize);
    auto attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize)) return fail(L"InitializeProcThreadAttributeList");
    if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pc_, sizeof(pc_), nullptr,
                                   nullptr)) {
        DeleteProcThreadAttributeList(attrs);
        return fail(L"UpdateProcThreadAttribute");
    }

    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof(si);
    // Без этого дочерний процесс может унаследовать std-хэндлы родителя вместо псевдоконсоли.
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.lpAttributeList = attrs;

    std::wstring cmd = commandLine;  // CreateProcessW может модифицировать буфер
    std::wstring envBlock = extraEnv.empty() ? std::wstring() : BuildEnvironmentBlock(extraEnv);
    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                             EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                             envBlock.empty() ? nullptr : envBlock.data(),
                             cwd.empty() ? nullptr : cwd.c_str(), &si.StartupInfo, &pi);
    DeleteProcThreadAttributeList(attrs);
    if (!ok) return fail(L"Не удалось запустить процесс");

    // Задание (job) убивает всё дерево процессов, когда закрывается приложение.
    if (job) AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    process_ = pi.hProcess;

    reader_ = std::thread(&PtySession::ReadLoop, this);
    waiter_ = std::thread(&PtySession::WaitLoop, this);
    return true;
}

void PtySession::ReadLoop() {
    std::vector<char> buf(64 * 1024);
    for (;;) {
        DWORD read = 0;
        if (!ReadFile(outRead_, buf.data(), static_cast<DWORD>(buf.size()), &read, nullptr) || read == 0) break;

        bool notify = false;
        {
            std::lock_guard<std::mutex> lock(outMutex_);
            partial_.append(buf.data(), read);
            const size_t tail = IncompleteUtf8Tail(partial_);
            outBuf_.append(partial_, 0, partial_.size() - tail);
            partial_.erase(0, partial_.size() - tail);
            if (!outBuf_.empty() && !notifyPending_) {
                notifyPending_ = true;
                notify = true;
            }
        }
        if (notify) onOutput_();
    }
}

void PtySession::WaitLoop() {
    WaitForSingleObject(process_, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(process_, &code);
    exitCode_ = code;

    // Закрытие псевдоконсоли завершает оставшихся клиентов (например, claude) и даёт EOF читателю.
    {
        std::lock_guard<std::mutex> lock(pcMutex_);
        if (pc_) ClosePseudoConsole(pc_);
        pc_ = nullptr;
    }
    if (reader_.joinable()) reader_.join();

    exited_ = true;
    onExit_();
}

std::string PtySession::TakeOutput() {
    std::lock_guard<std::mutex> lock(outMutex_);
    notifyPending_ = false;
    std::string out;
    out.swap(outBuf_);
    return out;
}

void PtySession::Write(const std::string& utf8) {
    if (!inWrite_ || exited_ || utf8.empty()) return;
    DWORD written = 0;
    WriteFile(inWrite_, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
}

void PtySession::Resize(short cols, short rows) {
    if (cols < 2 || rows < 1) return;
    std::lock_guard<std::mutex> lock(pcMutex_);
    if (pc_) ResizePseudoConsole(pc_, COORD{cols, rows});
}

void PtySession::Terminate() {
    if (process_ && !exited_) TerminateProcess(process_, 1);
}
