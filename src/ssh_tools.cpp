#include "ssh_tools.h"

#include <shellapi.h>
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

bool Contains(const std::string& s, const char* needle) { return s.find(needle) != std::string::npos; }

fs::path UserSshDir() {
    PWSTR raw = nullptr;
    fs::path result;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &raw))) result = fs::path(raw) / L".ssh";
    CoTaskMemFree(raw);
    return result;
}

// Имя файла ключа по схеме id_ed25519_<host>, с заменой недопустимых символов.
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

bool IsValidHost(const std::string& host) {
    if (host.empty() || host.size() > 253 || host[0] == '-') return false;
    return std::all_of(host.begin(), host.end(), [](char c) {
        return isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_' || c == ':';
    });
}

bool IsValidUser(const std::string& user) {
    if (user.empty() || user.size() > 64 || user[0] == '-') return false;
    return std::all_of(user.begin(), user.end(), [](char c) {
        return isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_' || c == '\\' || c == '@';
    });
}

// Пустая строка — параметры корректны, иначе текст ошибки.
std::string ValidateTarget(const SshTarget& t) {
    if (!IsValidHost(t.host)) return "Некорректный адрес сервера";
    if (!IsValidUser(t.user)) return "Некорректное имя пользователя";
    if (t.port < 1 || t.port > 65535) return "Некорректный порт";
    if (!OpenSshAvailable()) return "Не найден OpenSSH-клиент (ssh.exe). Установите компонент Windows «Клиент OpenSSH».";
    return {};
}

// Строка в одинарных кавычках для POSIX-шелла на сервере.
std::string ShQuote(const std::string& s) {
    std::string out = "'";
    for (char c : s) out += c == '\'' ? std::string("'\\''") : std::string(1, c);
    return out + "'";
}

// Путь для `cd`: «~» и «~/...» раскрываются на сервере, остальное — в кавычках.
std::string RemotePathExpr(const std::string& path) {
    if (path.empty() || path == "~") return "~";
    if (path.rfind("~/", 0) == 0) return "~/" + ShQuote(path.substr(2));
    return ShQuote(path);
}

std::vector<std::wstring> SshBaseArgs(const SshTarget& t) {
    return {OpenSshTool(L"ssh.exe"), L"-p", std::to_wstring(t.port), L"-o", L"StrictHostKeyChecking=accept-new",
            L"-o", L"ConnectTimeout=10"};
}

// Команда на сервере по ключу, без какого-либо ввода.
RunResult RunRemote(const SshTarget& t, const std::string& keyPath, const std::string& remoteCommand, DWORD timeoutMs) {
    std::vector<std::wstring> args = SshBaseArgs(t);
    args.insert(args.end(), {L"-i", Widen(keyPath), L"-o", L"BatchMode=yes", L"-o", L"IdentitiesOnly=yes", L"-l",
                             Widen(t.user), Widen(t.host), Widen(remoteCommand)});
    return RunHidden(JoinCommandLine(args), timeoutMs);
}

// Понятное сообщение по выводу ssh.
std::string DescribeSshFailure(const RunResult& r, const std::string& host) {
    if (r.timedOut) return "Сервер не ответил вовремя";
    const std::string out = Trim(r.output);
    if (Contains(out, "REMOTE HOST IDENTIFICATION HAS CHANGED") || Contains(out, "Host key verification failed"))
        return "Ключ сервера изменился по сравнению с known_hosts. Проверьте сервер и удалите старую запись (ssh-keygen -R " +
               host + ").";
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
        if (Contains(out, h.needle)) return std::string(h.text) + "\n(" + out + ")";
    return out.empty() ? "Не удалось подключиться (код " + std::to_string(r.exitCode) + ")" : out;
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

RunResult RunHidden(const std::wstring& commandLine, DWORD timeoutMs,
                    const std::vector<std::pair<std::wstring, std::wstring>>& extraEnv) {
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

    // Окружение: текущее + дополнительные переменные (блок строк "ИМЯ=значение\0...\0\0").
    std::wstring envBlock;
    if (!extraEnv.empty()) {
        if (LPWCH cur = GetEnvironmentStringsW()) {
            for (LPWCH p = cur; *p; p += wcslen(p) + 1) envBlock.append(p).push_back(L'\0');
            FreeEnvironmentStringsW(cur);
        }
        for (const auto& [name, value] : extraEnv) envBlock.append(name + L"=" + value).push_back(L'\0');
        envBlock.push_back(L'\0');
    }

    std::wstring cmd = commandLine;
    PROCESS_INFORMATION pi{};
    r.started = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE,
                               CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                               envBlock.empty() ? nullptr : envBlock.data(), nullptr, &si.StartupInfo, &pi) != FALSE;
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

json SshConnect(const SshTarget& t, const std::string& password, const std::wstring& askpassExe) {
    json res = {{"keyCreated", false}, {"keyInstalled", false}};
    auto fail = [&res](const std::string& message) {
        res["error"] = message;
        return res;
    };
    if (std::string err = ValidateTarget(t); !err.empty()) return fail(err);

    // 1. Ключ: берём существующий id_ed25519_<host> или создаём новый без парольной фразы.
    const fs::path dir = UserSshDir();
    std::error_code ec;
    fs::create_directories(dir, ec);
    const fs::path key = dir / KeyFileName(t.host);
    fs::path pub = key;
    pub += L".pub";
    const std::string keyPath = Narrow(key.wstring());
    res["keyPath"] = keyPath;

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
        if (y.exitCode != 0) return fail("Не удалось прочитать ключ " + keyPath);
        std::ofstream(pub, std::ios::binary) << Trim(y.output) << "\n";
    }
    std::string publicKey;
    {
        std::ifstream f(pub, std::ios::binary);
        std::stringstream ss;
        ss << f.rdbuf();
        publicKey = Trim(ss.str());
    }

    // 2. Пускает ли сервер по ключу?
    RunResult test = RunRemote(t, keyPath, "exit", 25000);
    if (test.exitCode == 0 && !test.timedOut) return res;
    if (!Contains(test.output, "Permission denied")) return fail(DescribeSshFailure(test, t.host));

    // 3. Сервер доступен, но ключ не знает — ставим его, войдя по паролю.
    if (password.empty()) {
        res["needsPassword"] = true;
        return res;
    }
    const std::string pk = ShQuote(publicKey);
    const std::string script = "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF " + pk +
                               " ~/.ssh/authorized_keys || echo " + pk + " >> ~/.ssh/authorized_keys)";
    std::vector<std::wstring> args = SshBaseArgs(t);
    args.insert(args.end(), {L"-o", L"PubkeyAuthentication=no", L"-o",
                             L"PreferredAuthentications=keyboard-interactive,password", L"-o", L"NumberOfPasswordPrompts=1",
                             L"-l", Widen(t.user), Widen(t.host), Widen(script)});
    RunResult install = RunHidden(JoinCommandLine(args), 30000,
                                  {{L"SSH_ASKPASS", askpassExe},
                                   {L"SSH_ASKPASS_REQUIRE", L"force"},
                                   {L"CMDM_ASKPASS", L"1"},
                                   {L"CMDM_ASKPASS_PW", Widen(password)}});
    if (install.exitCode != 0 || install.timedOut) {
        if (Contains(install.output, "Permission denied"))
            return fail("Неверный пароль, или сервер не разрешает вход по паролю.");
        return fail("Не удалось установить ключ: " + DescribeSshFailure(install, t.host));
    }

    // 4. Проверяем, что теперь пускает по ключу.
    RunResult check = RunRemote(t, keyPath, "exit", 25000);
    if (check.exitCode != 0) {
        return fail("Ключ добавлен в authorized_keys, но сервер его не принимает (проверьте права на ~/.ssh и настройки sshd).\n" +
                    Trim(check.output));
    }
    res["keyInstalled"] = true;
    return res;
}

json SshListDir(const SshTarget& t, const std::string& keyPath, const std::string& path) {
    if (std::string err = ValidateTarget(t); !err.empty()) return {{"error", err}};
    // Первая строка — абсолютный путь, дальше содержимое (у папок на конце «/»).
    RunResult r = RunRemote(t, keyPath, "cd " + RemotePathExpr(path) + " && pwd && LC_ALL=C ls -1Ap", 25000);
    if (r.exitCode != 0 || r.timedOut) {
        if (Contains(r.output, "No such file") || Contains(r.output, "Not a directory"))
            return {{"error", "Папка не найдена: " + path}};
        if (Contains(r.output, "Permission denied") && !Contains(r.output, "publickey"))
            return {{"error", "Нет доступа к папке: " + path}};
        return {{"error", DescribeSshFailure(r, t.host)}};
    }
    std::istringstream lines(r.output);
    std::string line, cwd;
    json dirs = json::array();
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (cwd.empty()) {
            cwd = line;
            continue;
        }
        if (line.size() > 1 && line.back() == '/') dirs.push_back(line.substr(0, line.size() - 1));
    }
    if (cwd.empty() || cwd[0] != '/') return {{"error", "Неожиданный ответ сервера:\n" + Trim(r.output)}};
    return {{"path", cwd}, {"dirs", dirs}};
}

json SshMakeDir(const SshTarget& t, const std::string& keyPath, const std::string& parent, const std::string& name) {
    if (std::string err = ValidateTarget(t); !err.empty()) return {{"error", err}};
    if (name.empty() || name == "." || name == ".." || name.find('/') != std::string::npos)
        return {{"error", "Недопустимое имя папки"}};
    RunResult r = RunRemote(t, keyPath,
                            "cd " + RemotePathExpr(parent) + " && mkdir -- " + ShQuote(name) + " && cd -- " +
                                ShQuote(name) + " && pwd",
                            25000);
    if (r.exitCode != 0 || r.timedOut) {
        if (Contains(r.output, "File exists")) return {{"error", "Папка «" + name + "» уже существует"}};
        if (Contains(r.output, "Permission denied") && !Contains(r.output, "publickey"))
            return {{"error", "Нет прав на создание папки здесь"}};
        return {{"error", DescribeSshFailure(r, t.host)}};
    }
    return {{"path", Trim(r.output)}};
}

bool RunAsAskpassIfRequested(int* exitCode) {
    wchar_t flag[4];
    if (GetEnvironmentVariableW(L"CMDM_ASKPASS", flag, 4) == 0) return false;
    // ssh передаёт текст запроса первым аргументом. Отвечаем только на запрос пароля.
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::wstring prompt = argc > 1 ? argv[1] : L"";
    LocalFree(argv);
    std::transform(prompt.begin(), prompt.end(), prompt.begin(), towlower);
    *exitCode = 1;
    if (prompt.find(L"password") == std::wstring::npos) return true;

    std::wstring pw(1024, L'\0');
    DWORD n = GetEnvironmentVariableW(L"CMDM_ASKPASS_PW", pw.data(), static_cast<DWORD>(pw.size()));
    pw.resize(n < pw.size() ? n : 0);
    std::string out = Narrow(pw) + "\n";
    DWORD written = 0;
    HANDLE stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
    if (stdOut && stdOut != INVALID_HANDLE_VALUE &&
        WriteFile(stdOut, out.data(), static_cast<DWORD>(out.size()), &written, nullptr))
        *exitCode = 0;
    return true;
}
