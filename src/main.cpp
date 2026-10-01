// CMD Manager — менеджер консолей для проектов Claude Code.
// Нативная часть: окно, WebView2, псевдоконсоли (ConPTY), диалоги, хранение состояния.
// Интерфейс (вкладки, сетка, список проектов) и эмулятор терминала (xterm.js) живут в папке web/.

#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl.h>

#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>

#include "WebView2.h"
#include "nlohmann/json.hpp"
#include "pty_session.h"
#include "ssh_tools.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

constexpr UINT WM_APP_OUTPUT = WM_APP + 1;  // wParam = id сессии
constexpr UINT WM_APP_EXIT = WM_APP + 2;    // wParam = id сессии
constexpr UINT WM_APP_WEBMSG = WM_APP + 3;  // разобрать очередь сообщений из JS
constexpr UINT WM_APP_POST = WM_APP + 4;    // lParam = std::string* с JSON для страницы (из фоновых потоков)

constexpr wchar_t kWindowClass[] = L"CMDManagerWindow";
constexpr wchar_t kAppTitle[] = L"CMD Manager";
constexpr wchar_t kVirtualHost[] = L"cmdmanager.local";
constexpr COLORREF kBackground = RGB(0x16, 0x17, 0x1c);

HWND g_hwnd = nullptr;
HANDLE g_job = nullptr;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
std::map<int, std::unique_ptr<PtySession>> g_sessions;
std::deque<std::string> g_inbox;  // сообщения из JS, обрабатываются вне колбэка WebView2
fs::path g_dataDir;               // %APPDATA%\CMDManager
fs::path g_webDir;

// ---------- утилиты ----------

std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::string PathToUtf8(const fs::path& p) { return WideToUtf8(p.wstring()); }

fs::path KnownFolder(REFKNOWNFOLDERID id) {
    PWSTR raw = nullptr;
    fs::path result;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &raw))) result = raw;
    CoTaskMemFree(raw);
    return result;
}

fs::path ExeDir() {
    wchar_t buf[MAX_PATH * 2];
    DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
    return fs::path(std::wstring(buf, n)).parent_path();
}

fs::path FindWebDir() {
    const fs::path exe = ExeDir();
    for (const fs::path& candidate : {exe / L"web", exe.parent_path() / L"web", exe.parent_path().parent_path() / L"web"}) {
        std::error_code ec;
        if (fs::exists(candidate / L"index.html", ec)) return candidate;
    }
    return exe / L"web";
}

std::string Base64(const std::string& bytes) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((bytes.size() + 2) / 3 * 4);
    size_t i = 0;
    for (; i + 2 < bytes.size(); i += 3) {
        unsigned v = (unsigned char)bytes[i] << 16 | (unsigned char)bytes[i + 1] << 8 | (unsigned char)bytes[i + 2];
        out += tbl[v >> 18 & 63], out += tbl[v >> 12 & 63], out += tbl[v >> 6 & 63], out += tbl[v & 63];
    }
    if (i + 1 == bytes.size()) {
        unsigned v = (unsigned char)bytes[i] << 16;
        out += tbl[v >> 18 & 63], out += tbl[v >> 12 & 63], out += "==";
    } else if (i + 2 == bytes.size()) {
        unsigned v = (unsigned char)bytes[i] << 16 | (unsigned char)bytes[i + 1] << 8;
        out += tbl[v >> 18 & 63], out += tbl[v >> 12 & 63], out += tbl[v >> 6 & 63], out += '=';
    }
    return out;
}

bool SearchExecutable(const std::wstring& name) {
    wchar_t buf[MAX_PATH];
    return SearchPathW(nullptr, name.c_str(), nullptr, MAX_PATH, buf, nullptr) > 0;
}

int WindowsBuildNumber() {
    wchar_t buf[32];
    DWORD size = sizeof(buf);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"CurrentBuildNumber",
                     RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS)
        return 0;
    return _wtoi(buf);
}

bool ReadFileUtf8(const fs::path& p, std::string* out) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    *out = ss.str();
    return true;
}

// Атомарная запись: сначала во временный файл, затем замена.
bool WriteFileAtomic(const fs::path& p, const std::string& data) {
    std::error_code ec;
    fs::create_directories(p.parent_path(), ec);
    fs::path tmp = p;
    tmp += L".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f.write(data.data(), static_cast<std::streamsize>(data.size()));
        if (!f) return false;
    }
    return MoveFileExW(tmp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
}

// ---------- связь с JS ----------

void PostToWeb(const json& msg) {
    if (!g_webview) return;
    std::string s = msg.dump(-1, ' ', false, json::error_handler_t::replace);
    g_webview->PostWebMessageAsJson(Utf8ToWide(s).c_str());
}

void Reply(const json& req, json payload) {
    payload["type"] = "reply";
    payload["reqId"] = req.value("reqId", 0);
    PostToWeb(payload);
}

// ---------- сессии ----------

std::wstring BuildCommandLine(const std::string& shell, const std::string& command) {
    std::wstring sh = Utf8ToWide(shell.empty() ? std::string("powershell.exe") : shell);
    std::wstring cl = L"\"" + sh + L"\" -NoLogo";
    if (!command.empty()) {
        // -EncodedCommand (base64 от UTF-16LE) избавляет от проблем с кавычками в команде.
        std::wstring wcmd = Utf8ToWide(command);
        std::string bytes(reinterpret_cast<const char*>(wcmd.data()), wcmd.size() * sizeof(wchar_t));
        cl += L" -NoExit -EncodedCommand " + Utf8ToWide(Base64(bytes));
    }
    return cl;
}

void SpawnSession(const json& m) {
    const int id = m.value("id", 0);
    const std::wstring cwd = Utf8ToWide(m.value("cwd", std::string()));
    const short cols = static_cast<short>(std::clamp(m.value("cols", 120), 2, 1000));
    const short rows = static_cast<short>(std::clamp(m.value("rows", 30), 1, 1000));

    auto error = [&](const std::wstring& text) {
        PostToWeb({{"type", "spawnError"}, {"id", id}, {"message", WideToUtf8(text)}});
    };

    std::error_code ec;
    if (!cwd.empty() && !fs::is_directory(cwd, ec)) {
        error(L"Папка не найдена: " + cwd);
        return;
    }
    if (g_sessions.count(id)) g_sessions.erase(id);

    HWND hwnd = g_hwnd;
    auto session = std::make_unique<PtySession>(
        id, [hwnd, id] { PostMessageW(hwnd, WM_APP_OUTPUT, id, 0); },
        [hwnd, id] { PostMessageW(hwnd, WM_APP_EXIT, id, 0); });

    // Либо оболочка с командой, либо программа с аргументами (например, ssh.exe — без промежуточного PowerShell).
    std::wstring cmdLine;
    const std::string program = m.value("program", std::string());
    if (program == "ssh") {
        std::vector<std::wstring> argv{OpenSshTool(L"ssh.exe")};
        for (const auto& a : m.value("args", json::array()))
            if (a.is_string()) argv.push_back(Utf8ToWide(a.get<std::string>()));
        cmdLine = JoinCommandLine(argv);
    } else if (!program.empty()) {
        error(L"Неизвестная программа: " + Utf8ToWide(program));
        return;
    } else {
        cmdLine = BuildCommandLine(m.value("shell", std::string()), m.value("command", std::string()));
    }
    std::wstring err;
    if (!session->Start(cmdLine, cwd, cols, rows, g_job, &err)) {
        error(err);
        return;
    }
    g_sessions[id] = std::move(session);
    PostToWeb({{"type", "spawned"}, {"id", id}});
}

void KillSession(int id) {
    auto it = g_sessions.find(id);
    if (it == g_sessions.end()) return;
    // Деструктор завершает процесс и дожидается фоновых потоков — делаем это вне UI-потока.
    std::unique_ptr<PtySession> s = std::move(it->second);
    g_sessions.erase(it);
    std::thread([s = std::move(s)]() mutable { s.reset(); }).detach();
}

int LiveSessionCount() {
    int n = 0;
    for (auto& [id, s] : g_sessions)
        if (!s->Exited()) ++n;
    return n;
}

// ---------- диалоги и файловая система ----------

std::wstring PickFolder(const std::wstring& title, const std::wstring& initial) {
    ComPtr<IFileOpenDialog> dlg;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return {};
    DWORD opts = 0;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dlg->SetTitle(title.c_str());
    if (!initial.empty()) {
        ComPtr<IShellItem> folder;
        if (SUCCEEDED(SHCreateItemFromParsingName(initial.c_str(), nullptr, IID_PPV_ARGS(&folder))))
            dlg->SetFolder(folder.Get());
    }
    if (dlg->Show(g_hwnd) != S_OK) return {};
    ComPtr<IShellItem> item;
    if (FAILED(dlg->GetResult(&item))) return {};
    PWSTR path = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) return {};
    std::wstring result = path;
    CoTaskMemFree(path);
    return result;
}

void CreateProjectFolder(const json& m) {
    std::wstring parent = Utf8ToWide(m.value("parent", std::string()));
    std::wstring name = Utf8ToWide(m.value("name", std::string()));
    while (!name.empty() && (name.back() == L' ' || name.back() == L'.')) name.pop_back();
    while (!name.empty() && name.front() == L' ') name.erase(0, 1);

    if (name.empty()) return Reply(m, {{"error", "Укажите имя папки"}});
    if (name.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos)
        return Reply(m, {{"error", "Имя папки не может содержать символы \\ / : * ? \" < > |"}});

    std::error_code ec;
    if (parent.empty() || !fs::is_directory(parent, ec)) return Reply(m, {{"error", "Родительская папка не найдена"}});

    fs::path target = fs::path(parent) / name;
    if (fs::exists(target, ec)) {
        if (!fs::is_directory(target, ec)) return Reply(m, {{"error", "Файл с таким именем уже существует"}});
        return Reply(m, {{"path", PathToUtf8(target)}, {"existed", true}});
    }
    if (!fs::create_directory(target, ec))
        return Reply(m, {{"error", "Не удалось создать папку: " + WideToUtf8(Utf8ToWide(ec.message()))}});
    Reply(m, {{"path", PathToUtf8(target)}, {"existed", false}});
}

json LoadState() {
    std::string text;
    if (!ReadFileUtf8(g_dataDir / L"state.json", &text)) return nullptr;
    json j = json::parse(text, nullptr, false);
    if (j.is_discarded()) {
        // Не теряем повреждённый файл молча — откладываем копию.
        std::error_code ec;
        fs::copy_file(g_dataDir / L"state.json", g_dataDir / L"state.broken.json", fs::copy_options::overwrite_existing,
                      ec);
        return nullptr;
    }
    return j;
}

// ---------- окно ----------

void SaveWindowPlacement() {
    WINDOWPLACEMENT wp{sizeof(wp)};
    if (!GetWindowPlacement(g_hwnd, &wp)) return;
    const RECT& r = wp.rcNormalPosition;
    json j = {{"left", r.left}, {"top", r.top}, {"right", r.right}, {"bottom", r.bottom},
              {"maximized", wp.showCmd == SW_SHOWMAXIMIZED || (wp.flags & WPF_RESTORETOMAXIMIZED)}};
    WriteFileAtomic(g_dataDir / L"window.json", j.dump(2));
}

int RestoreWindowPlacement() {
    std::string text;
    if (!ReadFileUtf8(g_dataDir / L"window.json", &text)) return SW_SHOWDEFAULT;
    json j = json::parse(text, nullptr, false);
    if (j.is_discarded()) return SW_SHOWDEFAULT;
    RECT r{j.value("left", 100), j.value("top", 100), j.value("right", 1500), j.value("bottom", 950)};
    // Не восстанавливаем окно за пределами текущих мониторов.
    if (!MonitorFromRect(&r, MONITOR_DEFAULTTONULL)) return SW_SHOWDEFAULT;
    WINDOWPLACEMENT wp{sizeof(wp)};
    wp.rcNormalPosition = r;
    wp.showCmd = SW_HIDE;
    SetWindowPlacement(g_hwnd, &wp);
    return j.value("maximized", false) ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL;
}

void FlashIfInactive() {
    if (GetForegroundWindow() == g_hwnd) return;
    FLASHWINFO fi{sizeof(fi), g_hwnd, FLASHW_TRAY | FLASHW_TIMERNOFG, 0, 0};
    FlashWindowEx(&fi);
}

void OpenExternally(const std::wstring& target) {
    ShellExecuteW(g_hwnd, L"open", target.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ---------- обработка сообщений из JS ----------

void HandleWebMessage(const std::string& text) {
    json m = json::parse(text, nullptr, false);
    if (m.is_discarded() || !m.is_object()) return;
    const std::string type = m.value("type", std::string());

    if (type == "input") {
        auto it = g_sessions.find(m.value("id", 0));
        if (it != g_sessions.end()) it->second->Write(m.value("data", std::string()));
    } else if (type == "resize") {
        auto it = g_sessions.find(m.value("id", 0));
        if (it != g_sessions.end())
            it->second->Resize(static_cast<short>(m.value("cols", 80)), static_cast<short>(m.value("rows", 24)));
    } else if (type == "spawn") {
        SpawnSession(m);
    } else if (type == "kill") {
        KillSession(m.value("id", 0));
    } else if (type == "ready") {
        // Страница (пере)загрузилась — старые сессии ей уже не принадлежат.
        while (!g_sessions.empty()) KillSession(g_sessions.begin()->first);
        PostToWeb({{"type", "init"},
                   {"state", LoadState()},
                   {"hasPwsh", SearchExecutable(L"pwsh.exe")},
                   {"hasClaude", SearchExecutable(L"claude.exe") || SearchExecutable(L"claude.cmd")},
                   {"home", PathToUtf8(KnownFolder(FOLDERID_Profile))},
                   {"osBuild", WindowsBuildNumber()},
                   {"hasSsh", OpenSshAvailable()},
                   {"dataDir", PathToUtf8(g_dataDir)}});
    } else if (type == "saveState") {
        WriteFileAtomic(g_dataDir / L"state.json", m["data"].dump(2, ' ', false, json::error_handler_t::replace));
    } else if (type == "pickFolder") {
        std::wstring path =
            PickFolder(Utf8ToWide(m.value("title", std::string("Выберите папку"))), Utf8ToWide(m.value("initial", std::string())));
        Reply(m, {{"path", path.empty() ? json(nullptr) : json(WideToUtf8(path))}});
    } else if (type == "sshConnect" || type == "sshListDir" || type == "sshMkdir") {
        // SSH-операции занимают секунды — выполняем в фоне, ответ присылаем через WM_APP_POST.
        SshTarget target{m.value("host", std::string()), m.value("port", 22), m.value("user", std::string())};
        std::thread([m, type, target] {
            json r;
            if (type == "sshConnect") {
                wchar_t exe[MAX_PATH * 2];
                DWORD n = GetModuleFileNameW(nullptr, exe, static_cast<DWORD>(std::size(exe)));
                r = SshConnect(target, m.value("password", std::string()), std::wstring(exe, n));
            } else if (type == "sshListDir") {
                r = SshListDir(target, m.value("keyPath", std::string()), m.value("path", std::string("~")));
            } else {
                r = SshMakeDir(target, m.value("keyPath", std::string()), m.value("parent", std::string()),
                               m.value("name", std::string()));
            }
            r["type"] = "reply";
            r["reqId"] = m.value("reqId", 0);
            auto* text = new std::string(r.dump(-1, ' ', false, json::error_handler_t::replace));
            if (!PostMessageW(g_hwnd, WM_APP_POST, 0, reinterpret_cast<LPARAM>(text))) delete text;
        }).detach();
    } else if (type == "createFolder") {
        CreateProjectFolder(m);
    } else if (type == "ensureDir") {
        fs::path dir = Utf8ToWide(m.value("path", std::string()));
        std::error_code ec;
        if (dir.empty() || !dir.is_absolute()) {
            Reply(m, {{"error", "Укажите полный путь к локальной папке"}});
        } else if (fs::is_directory(dir, ec) || fs::create_directories(dir, ec)) {
            Reply(m, {{"path", PathToUtf8(dir)}});
        } else {
            Reply(m, {{"error", "Не удалось создать папку " + PathToUtf8(dir) + ": " + WideToUtf8(Utf8ToWide(ec.message()))}});
        }
    } else if (type == "checkPaths") {
        json exists = json::array();
        for (auto& p : m.value("paths", json::array())) {
            std::error_code ec;
            exists.push_back(p.is_string() && fs::is_directory(Utf8ToWide(p.get<std::string>()), ec));
        }
        Reply(m, {{"exists", exists}});
    } else if (type == "openFolder") {
        OpenExternally(Utf8ToWide(m.value("path", std::string())));
    } else if (type == "openUrl") {
        std::wstring url = Utf8ToWide(m.value("url", std::string()));
        if (url.rfind(L"http://", 0) == 0 || url.rfind(L"https://", 0) == 0) OpenExternally(url);
    } else if (type == "attention") {
        FlashIfInactive();
    } else if (type == "setTitle") {
        std::wstring t = Utf8ToWide(m.value("title", std::string()));
        SetWindowTextW(g_hwnd, t.empty() ? kAppTitle : (t + L" — " + kAppTitle).c_str());
    }
}

// ---------- WebView2 ----------

void ShowFatal(const std::wstring& text) { MessageBoxW(g_hwnd, text.c_str(), kAppTitle, MB_ICONERROR | MB_OK); }

void ResizeWebView() {
    if (!g_controller) return;
    RECT r;
    GetClientRect(g_hwnd, &r);
    g_controller->put_Bounds(r);
}

HRESULT OnControllerCreated(HRESULT result, ICoreWebView2Controller* controller) {
    if (FAILED(result) || !controller) {
        ShowFatal(L"Не удалось создать WebView2 (код " + std::to_wstring(result) + L").");
        return S_OK;
    }
    g_controller = controller;
    g_controller->get_CoreWebView2(&g_webview);

    if (ComPtr<ICoreWebView2Controller2> c2; SUCCEEDED(g_controller.As(&c2)))
        c2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{255, GetRValue(kBackground), GetGValue(kBackground), GetBValue(kBackground)});

    const bool devTools = GetEnvironmentVariableW(L"CMDM_DEVTOOLS", nullptr, 0) > 0;
    ComPtr<ICoreWebView2Settings> settings;
    g_webview->get_Settings(&settings);
    settings->put_AreDefaultContextMenusEnabled(devTools);
    settings->put_AreDevToolsEnabled(devTools);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    if (ComPtr<ICoreWebView2Settings3> s3; SUCCEEDED(settings.As(&s3)))
        s3->put_AreBrowserAcceleratorKeysEnabled(devTools);  // F5/Ctrl+R не должны перезагружать страницу с терминалами

    if (ComPtr<ICoreWebView2_3> wv3; SUCCEEDED(g_webview.As(&wv3)))
        wv3->SetVirtualHostNameToFolderMapping(kVirtualHost, g_webDir.c_str(),
                                               COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);

    EventRegistrationToken token;
    g_webview->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                LPWSTR raw = nullptr;
                if (SUCCEEDED(args->TryGetWebMessageAsString(&raw)) && raw) {
                    const bool wasEmpty = g_inbox.empty();
                    g_inbox.push_back(WideToUtf8(raw));
                    CoTaskMemFree(raw);
                    // Обрабатываем позже: модальные диалоги внутри колбэка WebView2 приводят к реентерабельности.
                    if (wasEmpty) PostMessageW(g_hwnd, WM_APP_WEBMSG, 0, 0);
                }
                return S_OK;
            })
            .Get(),
        &token);

    // Разрешаем странице читать буфер обмена (вставка по правому клику).
    g_webview->add_PermissionRequested(
        Callback<ICoreWebView2PermissionRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_PERMISSION_KIND kind;
                args->get_PermissionKind(&kind);
                if (kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ)
                    args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                return S_OK;
            })
            .Get(),
        &token);

    // Ссылки открываем в системном браузере, а не внутри приложения.
    g_webview->add_NewWindowRequested(
        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                args->put_Handled(TRUE);
                if (uri) {
                    std::wstring u = uri;
                    CoTaskMemFree(uri);
                    if (u.rfind(L"http://", 0) == 0 || u.rfind(L"https://", 0) == 0) OpenExternally(u);
                }
                return S_OK;
            })
            .Get(),
        &token);

    g_webview->add_NavigationStarting(
        Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                if (!uri) return S_OK;
                std::wstring u = uri;
                CoTaskMemFree(uri);
                const std::wstring ours = std::wstring(L"https://") + kVirtualHost + L"/";
                if (u.rfind(ours, 0) != 0) {
                    args->put_Cancel(TRUE);
                    if (u.rfind(L"http://", 0) == 0 || u.rfind(L"https://", 0) == 0) OpenExternally(u);
                }
                return S_OK;
            })
            .Get(),
        &token);

    ResizeWebView();
    g_webview->Navigate((std::wstring(L"https://") + kVirtualHost + L"/index.html").c_str());
    g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    return S_OK;
}

void CreateWebView() {
    const fs::path userData = g_dataDir / L"WebView2";
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, userData.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result) || !env) {
                    ShowFatal(L"Не найден WebView2 Runtime. Установите его: https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                    PostQuitMessage(1);
                    return S_OK;
                }
                env->CreateCoreWebView2Controller(
                    g_hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(OnControllerCreated).Get());
                return S_OK;
            })
            .Get());
    if (FAILED(hr)) {
        ShowFatal(L"Не удалось инициализировать WebView2 (код " + std::to_wstring(hr) + L").");
        PostQuitMessage(1);
    }
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_APP_OUTPUT: {
            auto it = g_sessions.find(static_cast<int>(wp));
            if (it != g_sessions.end()) {
                std::string data = it->second->TakeOutput();
                if (!data.empty()) PostToWeb({{"type", "output"}, {"id", it->first}, {"data", data}});
            }
            return 0;
        }
        case WM_APP_EXIT: {
            auto it = g_sessions.find(static_cast<int>(wp));
            if (it != g_sessions.end()) {
                std::string rest = it->second->TakeOutput();
                if (!rest.empty()) PostToWeb({{"type", "output"}, {"id", it->first}, {"data", rest}});
                PostToWeb({{"type", "exit"}, {"id", it->first}, {"code", it->second->ExitCode()}});
            }
            return 0;
        }
        case WM_APP_POST: {
            std::unique_ptr<std::string> text(reinterpret_cast<std::string*>(lp));
            if (g_webview) g_webview->PostWebMessageAsJson(Utf8ToWide(*text).c_str());
            return 0;
        }
        case WM_APP_WEBMSG:
            while (!g_inbox.empty()) {
                std::string text = std::move(g_inbox.front());
                g_inbox.pop_front();
                HandleWebMessage(text);
            }
            return 0;
        case WM_SIZE:
            ResizeWebView();
            return 0;
        case WM_MOVE:
        case WM_MOVING:
            if (g_controller) g_controller->NotifyParentWindowPositionChanged();
            break;
        case WM_SETFOCUS:
            if (g_controller) g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            return 0;
        case WM_DPICHANGED: {
            const RECT* r = reinterpret_cast<const RECT*>(lp);
            SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_GETMINMAXINFO: {
            auto* mmi = reinterpret_cast<MINMAXINFO*>(lp);
            mmi->ptMinTrackSize = {640, 400};
            return 0;
        }
        case WM_CLOSE: {
            const int live = LiveSessionCount();
            if (live > 0) {
                std::wstring text = L"Открыто активных консолей: " + std::to_wstring(live) +
                                    L".\nВсе запущенные в них процессы (включая Claude Code) будут завершены.\n\nЗакрыть CMD Manager?";
                if (MessageBoxW(hwnd, text.c_str(), kAppTitle, MB_ICONQUESTION | MB_YESNO | MB_DEFBUTTON2) != IDYES)
                    return 0;
            }
            SaveWindowPlacement();
            DestroyWindow(hwnd);
            return 0;
        }
        case WM_DESTROY:
            g_sessions.clear();
            g_controller.Reset();
            g_webview.Reset();
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int nCmdShow) {
    // Запуск в роли SSH_ASKPASS (ssh просит пароль при установке ключа) — ответить и выйти, окно не создаём.
    if (int code = 0; RunAsAskpassIfRequested(&code)) return code;

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;

    // Каталог данных: %APPDATA%\CMDManager
    // CMDM_DATA_DIR позволяет держать отдельный профиль (например, для тестов).
    wchar_t custom[MAX_PATH];
    if (GetEnvironmentVariableW(L"CMDM_DATA_DIR", custom, MAX_PATH) > 0) {
        g_dataDir = custom;
    } else {
        const fs::path appData = KnownFolder(FOLDERID_RoamingAppData);
        g_dataDir = appData.empty() ? ExeDir() / L"data" : appData / L"CMDManager";
    }
    std::error_code ec;
    fs::create_directories(g_dataDir, ec);
    g_webDir = FindWebDir();

    // Окружение для дочерних консолей: полноцветный вывод; убираем маркеры «вложенного» Claude Code,
    // если сам менеджер был запущен из сессии Claude.
    SetEnvironmentVariableW(L"COLORTERM", L"truecolor");
    for (const wchar_t* name : {L"CLAUDECODE", L"CLAUDE_CODE_ENTRYPOINT", L"CLAUDE_CODE_CHILD_SESSION",
                                L"CLAUDE_CODE_SESSION_ID", L"CLAUDE_CODE_SESSION_ATTENDED", L"CLAUDE_CODE_EXECPATH",
                                L"CLAUDE_CODE_MESSAGING_SOCKET", L"CLAUDE_CODE_MESSAGING_TOKEN", L"CLAUDE_PID"})
        SetEnvironmentVariableW(name, nullptr);

    // Все дочерние процессы умирают вместе с приложением.
    g_job = CreateJobObjectW(nullptr, nullptr);
    if (g_job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &info, sizeof(info));
    }

    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = CreateSolidBrush(kBackground);
    wc.lpszClassName = kWindowClass;
    wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(1));
    wc.hIconSm = wc.hIcon;
    RegisterClassExW(&wc);

    g_hwnd = CreateWindowExW(0, kWindowClass, kAppTitle, WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1400, 880,
                             nullptr, nullptr, hInst, nullptr);
    if (!g_hwnd) return 1;

    BOOL dark = TRUE;
    DwmSetWindowAttribute(g_hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof(dark));

    int show = RestoreWindowPlacement();
    ShowWindow(g_hwnd, show == SW_SHOWDEFAULT ? nCmdShow : show);
    UpdateWindow(g_hwnd);

    if (!fs::exists(g_webDir / L"index.html", ec)) {
        ShowFatal(L"Не найдена папка интерфейса web\\ рядом с программой:\n" + g_webDir.wstring());
        return 1;
    }
    CreateWebView();

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_job) CloseHandle(g_job);  // KILL_ON_JOB_CLOSE завершит всё, что ещё живо
    CoUninitialize();
    return static_cast<int>(msg.wParam);
}
