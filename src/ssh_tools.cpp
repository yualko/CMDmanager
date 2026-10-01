#include "ssh_tools.h"

#include <shlobj.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

std::wstring Widen(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string Narrow(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::string Trim(std::string s) {
    while (!s.empty() && (s.back() == '\r' || s.back() == '\n' || s.back() == ' ')) s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == '\r' || s[i] == '\n' || s[i] == ' ')) ++i;
    return s.substr(i);
}

fs::path UserSshDir() {
    PWSTR raw = nullptr;
    fs::path result;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &raw))) result = fs::path(raw) / L".ssh";
    CoTaskMemFree(raw);
    return result;
}

// Имя файла ключа по вашей схеме: id_ed25519_<host>, с заменой недопустимых символов.
std::wstring KeyFileName(const std::string& host) {
    std::wstring name = L"id_ed25519_" + Widen(host);
    for (auto& c : name)
        if (wcschr(L"\\/:*?\"<>|", c)) c = L'_';
    return name;
}

std::string ComputerTag() {
    wchar_t buf[MAX_COMPUTERNAME_LENGTH + 1];
    DWORD n = MAX_COMPUTERNAME_LENGTH + 1;
    std::string tag = GetComputerNameW(buf, &n) ? Narrow(std::wstring(buf, n)) : "pc";
    for (auto& c : tag)
        if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') c = '-';
    return tag;
}

}  // namespace

std::wstring QuoteArg(const std::wstring& arg) {
    if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) return arg;
    std::wstring out = L"\"";
    for (auto it = arg.begin();; ++it) {
        size_t backslashes = 0;
        while (it != arg.end() && *it == L'\\') ++it, ++backslashes;
        if (it == arg.end()) {
            out.append(backslashes * 2, L'\\');
            break;
        }
        if (*it == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(L'"');
        } else {
            out.append(backslashes, L'\\');
            out.push_back(*it);
        }
    }
    out.push_back(L'"');
    return out;
}

std::wstring JoinCommandLine(const std::vector<std::wstring>& args) {
    std::wstring cl;
    for (const auto& a : args) {
        if (!cl.empty()) cl.push_back(L' ');
        cl += QuoteArg(a);
    }
    return cl;
}

std::wstring OpenSshTool(const wchar_t* name) {
    wchar_t sys[MAX_PATH];
    if (GetSystemDirectoryW(sys, MAX_PATH)) {
        fs::path p = fs::path(sys) / L"OpenSSH" / name;
        std::error_code ec;
        if (fs::exists(p, ec)) return p.wstring();
    }
    return name;
}

bool OpenSshAvailable() {
    std::wstring p = OpenSshTool(L"ssh.exe");
    if (p.find(L'\\') != std::wstring::npos) return true;
    wchar_t buf[MAX_PATH];
    return SearchPathW(nullptr, L"ssh.exe", nullptr, MAX_PATH, buf, nullptr) > 0;
}

bool IsValidSshHost(const std::string& host) {
    if (host.empty() || host.size() > 253 || host[0] == '-') return false;
    return std::all_of(host.begin(), host.end(), [](char c) {
        return isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_' || c == ':';
    });
}

bool IsValidSshUser(const std::string& user) {
    if (user.empty() || user.size() > 64 || user[0] == '-') return false;
    return std::all_of(user.begin(), user.end(), [](char c) {
        return isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_' || c == '\\' || c == '@';
    });
}

RunResult RunHidden(const std::wstring& commandLine, DWORD timeoutMs) {
    RunResult r;
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE readEnd = nullptr, writeEnd = nullptr;
    if (!CreatePipe(&readEnd, &writeEnd, &sa, 0)) return r;
    SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);

    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof(si);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nul;
    si.StartupInfo.hStdOutput = writeEnd;
    si.StartupInfo.hStdError = writeEnd;

    // Наследуем ребёнку только эти два хэндла, а не всё подряд.
    HANDLE inherit[] = {nul, writeEnd};
    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
    std::vector<BYTE> attrBuf(attrSize);
    auto attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
    InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize);
    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit), nullptr, nullptr);
    si.lpAttributeList = attrs;

    std::wstring cmd = commandLine;
    PROCESS_INFORMATION pi{};
    r.started = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE,
                               CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo,
                               &pi) != FALSE;
    DeleteProcThreadAttributeList(attrs);
    CloseHandle(writeEnd);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!r.started) {
        CloseHandle(readEnd);
        return r;
    }

    std::thread reader([&] {
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(readEnd, buf, sizeof(buf), &n, nullptr) && n > 0) r.output.append(buf, n);
    });
    if (WaitForSingleObject(pi.hProcess, timeoutMs) == WAIT_TIMEOUT) {
        r.timedOut = true;
        TerminateProcess(pi.hProcess, 1);
        WaitForSingleObject(pi.hProcess, 5000);
    }
    GetExitCodeProcess(pi.hProcess, &r.exitCode);
    reader.join();
    CloseHandle(readEnd);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return r;
}

json PrepareSshKey(const std::string& host, int port, const std::string& user) {
    json res = {{"authOk", false}, {"needsInstall", false}, {"keyCreated", false}};
    auto fail = [&res](const std::string& message) {
        res["error"] = message;
        return res;
    };
    if (!IsValidSshHost(host)) return fail("Некорректный адрес сервера");
    if (!IsValidSshUser(user)) return fail("Некорректное имя пользователя");
    if (port < 1 || port > 65535) return fail("Некорректный порт");
    if (!OpenSshAvailable())
        return fail("Не найден OpenSSH-клиент (ssh.exe). Установите компонент Windows «Клиент OpenSSH».");

    const fs::path dir = UserSshDir();
    std::error_code ec;
    fs::create_directories(dir, ec);
    const fs::path key = dir / KeyFileName(host);
    fs::path pub = key;
    pub += L".pub";
    res["keyPath"] = Narrow(key.wstring());

    if (!fs::exists(key, ec)) {
        RunResult gen = RunHidden(JoinCommandLine({OpenSshTool(L"ssh-keygen.exe"), L"-q", L"-t", L"ed25519", L"-N", L"",
                                                   L"-C", Widen("cmdmanager@" + ComputerTag()), L"-f", key.wstring()}),
                                  30000);
        if (!gen.started || gen.exitCode != 0 || !fs::exists(key, ec))
            return fail("Не удалось создать ключ: " + Trim(gen.output));
        res["keyCreated"] = true;
    }
    if (!fs::exists(pub, ec)) {
        // Есть приватный ключ без .pub — восстанавливаем публичную часть.
        RunResult y = RunHidden(JoinCommandLine({OpenSshTool(L"ssh-keygen.exe"), L"-y", L"-f", key.wstring()}), 15000);
        if (y.exitCode != 0) return fail("Не удалось прочитать ключ " + Narrow(key.wstring()));
        std::ofstream(pub, std::ios::binary) << Trim(y.output) << "\n";
    }
    {
        std::ifstream f(pub, std::ios::binary);
        std::stringstream ss;
        ss << f.rdbuf();
        res["publicKey"] = Trim(ss.str());
    }

    // Пробуем войти по ключу без какого-либо ввода.
    RunResult test = RunHidden(
        JoinCommandLine({OpenSshTool(L"ssh.exe"), L"-i", key.wstring(), L"-p", std::to_wstring(port), L"-o",
                         L"BatchMode=yes", L"-o", L"StrictHostKeyChecking=accept-new", L"-o", L"ConnectTimeout=10", L"-o",
                         L"IdentitiesOnly=yes", L"-l", Widen(user), Widen(host), L"exit"}),
        25000);
    if (test.timedOut) return fail("Сервер не ответил вовремя");
    if (test.exitCode == 0) {
        res["authOk"] = true;
        return res;
    }

    const std::string out = Trim(test.output);
    if (out.find("Permission denied") != std::string::npos) {
        res["needsInstall"] = true;  // сервер доступен, но ключ ещё не установлен
        return res;
    }
    if (out.find("REMOTE HOST IDENTIFICATION HAS CHANGED") != std::string::npos ||
        out.find("Host key verification failed") != std::string::npos)
        return fail("Ключ сервера изменился по сравнению с known_hosts. Проверьте сервер и удалите старую запись (ssh-keygen -R " + host + ").");
    struct Hint {
        const char* needle;
        const char* text;
    };
    static const Hint hints[] = {
        {"Connection refused", "Сервер отказал в подключении — проверьте адрес и порт (запущен ли SSH на сервере?)"},
        {"Could not resolve hostname", "Не удалось найти сервер с таким адресом"},
        {"timed out", "Сервер не отвечает — проверьте адрес, порт и сеть"},
        {"No route to host", "Сервер недоступен — нет маршрута до хоста"},
        {"Connection reset", "Сервер разорвал соединение"},
    };
    for (const auto& h : hints)
        if (out.find(h.needle) != std::string::npos) return fail(std::string(h.text) + "\n(" + out + ")");
    return fail(out.empty() ? "Не удалось подключиться (код " + std::to_string(test.exitCode) + ")" : out);
}
