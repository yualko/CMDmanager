#include "installer.h"

#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl.h>

#include <algorithm>
#include <filesystem>
#include <vector>

#include "i18n.h"
#include "version.h"

namespace fs = std::filesystem;
using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kAppName[] = L"CMD Manager";
constexpr wchar_t kPublisher[] = L"ООО «Аутсорсинг трейд»";
constexpr wchar_t kPublisherUrl[] = L"https://itradmin.ru";
constexpr wchar_t kWindowClass[] = L"CMDManagerWindow";
constexpr wchar_t kUninstallKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CMDManager";
constexpr wchar_t kShortcutName[] = L"CMD Manager.lnk";
constexpr int kBtnInstall = 101;
constexpr int kBtnPortable = 102;

fs::path KnownFolder(REFKNOWNFOLDERID id) {
    PWSTR raw = nullptr;
    fs::path result;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &raw))) result = raw;
    CoTaskMemFree(raw);
    return result;
}

fs::path SelfPath() {
    wchar_t buf[MAX_PATH * 2];
    DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
    return fs::path(std::wstring(buf, n));
}

fs::path InstallDir() { return KnownFolder(FOLDERID_LocalAppData) / L"Programs" / L"CMDManager"; }

bool SamePath(const fs::path& a, const fs::path& b) {
    std::error_code ec;
    std::wstring x = fs::weakly_canonical(a, ec).wstring(), y = fs::weakly_canonical(b, ec).wstring();
    return _wcsicmp(x.c_str(), y.c_str()) == 0;
}

void ShowError(HWND owner, const std::wstring& text) {
    MessageBoxW(owner, text.c_str(), kAppName, MB_ICONERROR | MB_OK);
}

// ---------- работающие копии программы ----------

struct Instance {
    HWND hwnd;
    DWORD pid;
};

std::vector<Instance> RunningInstances(const fs::path& exe) {
    struct Ctx {
        fs::path exe;
        std::vector<Instance> found;
    } ctx{exe, {}};
    EnumWindows(
        [](HWND hwnd, LPARAM lp) -> BOOL {
            auto* c = reinterpret_cast<Ctx*>(lp);
            wchar_t cls[64];
            if (!GetClassNameW(hwnd, cls, 64) || wcscmp(cls, kWindowClass) != 0) return TRUE;
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);
            if (pid == GetCurrentProcessId()) return TRUE;
            HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if (!p) return TRUE;
            wchar_t path[MAX_PATH * 2];
            DWORD size = static_cast<DWORD>(std::size(path));
            if (QueryFullProcessImageNameW(p, 0, path, &size) && SamePath(path, c->exe)) c->found.push_back({hwnd, pid});
            CloseHandle(p);
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&ctx));
    return ctx.found;
}

bool WaitForPids(const std::vector<Instance>& list, DWORD timeoutMs) {
    const ULONGLONG deadline = GetTickCount64() + timeoutMs;
    for (const auto& inst : list) {
        HANDLE p = OpenProcess(SYNCHRONIZE, FALSE, inst.pid);
        if (!p) continue;
        ULONGLONG now = GetTickCount64();
        DWORD left = now < deadline ? static_cast<DWORD>(deadline - now) : 0;
        DWORD r = WaitForSingleObject(p, left);
        CloseHandle(p);
        if (r != WAIT_OBJECT_0) return false;
    }
    return true;
}

// Закрывает запущенную установленную копию (с согласия пользователя), чтобы можно было заменить exe.
bool CloseRunningInstances(const fs::path& exe, HWND owner) {
    auto list = RunningInstances(exe);
    if (list.empty()) return true;
    if (MessageBoxW(owner,
                    Tr(L"CMD Manager сейчас запущен.\n\nЗакрыть его, чтобы продолжить? Открытые консоли и ИИ-агенты в них будут закрыты.").c_str(),
                    kAppName, MB_ICONQUESTION | MB_YESNO | MB_DEFBUTTON1) != IDYES)
        return false;
    for (const auto& inst : list) PostMessageW(inst.hwnd, QuitForUpdateMessage(), 0, 0);
    if (WaitForPids(list, 5000)) return true;
    // Старые версии не знают «тихого» сообщения — просим закрыться обычным способом.
    for (const auto& inst : list) PostMessageW(inst.hwnd, WM_CLOSE, 0, 0);
    if (WaitForPids(list, 120000)) return true;
    ShowError(owner, Tr(L"Не удалось закрыть запущенный CMD Manager. Закройте его вручную и повторите."));
    return false;
}

// ---------- файлы, ярлыки, реестр ----------

bool CopySelfTo(const fs::path& target, std::wstring* error) {
    std::error_code ec;
    fs::create_directories(target.parent_path(), ec);
    fs::path tmp = target;
    tmp += L".new";
    if (!CopyFileW(SelfPath().c_str(), tmp.c_str(), FALSE)) {
        *error = TrF(L"Не удалось скопировать программу в {0}", {target.parent_path().wstring()});
        return false;
    }
    // exe может ещё несколько мгновений быть занят закрывающимся процессом.
    for (int attempt = 0; attempt < 40; ++attempt) {
        if (MoveFileExW(tmp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
        Sleep(250);
    }
    fs::remove(tmp, ec);
    *error = TrF(L"Файл {0} занят. Закройте CMD Manager и повторите.", {target.wstring()});
    return false;
}

bool CreateShortcut(const fs::path& lnk, const fs::path& target) {
    ComPtr<IShellLinkW> link;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) return false;
    link->SetPath(target.c_str());
    link->SetWorkingDirectory(target.parent_path().c_str());
    link->SetDescription(Tr(L"Консоли проектов ИИ-агентов в одном окне").c_str());
    link->SetIconLocation(target.c_str(), 0);
    ComPtr<IPersistFile> file;
    if (FAILED(link.As(&file))) return false;
    std::error_code ec;
    fs::create_directories(lnk.parent_path(), ec);
    return SUCCEEDED(file->Save(lnk.c_str(), TRUE));
}

void SetString(HKEY key, const wchar_t* name, const std::wstring& value) {
    RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                   static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
}

void SetDword(HKEY key, const wchar_t* name, DWORD value) {
    RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof(value));
}

// Запись в «Параметры → Приложения → Установленные приложения».
void WriteUninstallEntry(const fs::path& exe) {
    HKEY key;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kUninstallKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) !=
        ERROR_SUCCESS)
        return;
    std::error_code ec;
    SetString(key, L"DisplayName", kAppName);
    SetString(key, L"DisplayVersion", CMDM_VERSION_WSTR);
    SetString(key, L"Publisher", kPublisher);
    SetString(key, L"URLInfoAbout", kPublisherUrl);
    SetString(key, L"HelpLink", L"" CMDM_HOMEPAGE);
    SetString(key, L"DisplayIcon", exe.wstring());
    SetString(key, L"InstallLocation", exe.parent_path().wstring());
    SetString(key, L"UninstallString", L"\"" + exe.wstring() + L"\" --uninstall");
    SetDword(key, L"NoModify", 1);
    SetDword(key, L"NoRepair", 1);
    SetDword(key, L"EstimatedSize", static_cast<DWORD>(fs::file_size(exe, ec) / 1024));
    RegCloseKey(key);
}

std::wstring InstalledVersion() {
    wchar_t buf[64];
    DWORD size = sizeof(buf);
    if (RegGetValueW(HKEY_CURRENT_USER, kUninstallKey, L"DisplayVersion", RRF_RT_REG_SZ, nullptr, buf, &size) !=
        ERROR_SUCCESS)
        return {};
    return buf;
}

fs::path StartMenuShortcut() { return KnownFolder(FOLDERID_Programs) / kShortcutName; }
fs::path DesktopShortcut() { return KnownFolder(FOLDERID_Desktop) / kShortcutName; }

bool DoInstall(bool desktopShortcut, bool isUpdate, HWND owner) {
    const fs::path target = InstalledExePath();
    if (!SamePath(SelfPath(), target)) {
        if (!CloseRunningInstances(target, owner)) return false;
        std::wstring error;
        if (!CopySelfTo(target, &error)) {
            ShowError(owner, error);
            return false;
        }
    }
    WriteUninstallEntry(target);
    CreateShortcut(StartMenuShortcut(), target);
    std::error_code ec;
    if (desktopShortcut || (isUpdate && fs::exists(DesktopShortcut(), ec))) CreateShortcut(DesktopShortcut(), target);
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return true;
}

void LaunchInstalled() {
    const fs::path target = InstalledExePath();
    ShellExecuteW(nullptr, L"open", target.c_str(), nullptr, target.parent_path().c_str(), SW_SHOWNORMAL);
}

// ---------- диалоги ----------

HRESULT CALLBACK TaskDialogLinks(HWND, UINT msg, WPARAM, LPARAM lp, LONG_PTR) {
    if (msg == TDN_HYPERLINK_CLICKED)
        ShellExecuteW(nullptr, L"open", reinterpret_cast<LPCWSTR>(lp), nullptr, nullptr, SW_SHOWNORMAL);
    return S_OK;
}

int ShowInstallDialog(HINSTANCE hInst, bool* desktopShortcut) {
    const std::wstring installed = InstalledVersion();
    std::wstring title = installed.empty() ? TrF(L"Установить CMD Manager {0}", {CMDM_VERSION_WSTR})
                                           : TrF(L"Обновить CMD Manager до версии {0}", {CMDM_VERSION_WSTR});
    std::wstring content =
        installed.empty()
            ? Tr(L"Консоли проектов ИИ-агентов в одном окне: вкладки, сетка, проекты в один клик, работа с серверами по SSH.") +
                  L"\n\n" + TrF(L"Программа будет установлена в\n{0}\nПрава администратора не нужны.", {InstallDir().wstring()})
            : TrF(L"Сейчас установлена версия {0}. Список проектов и настройки сохранятся.", {installed});
    const std::wstring footer = Tr(L"Разработка ООО «Аутсорсинг трейд»") + L" · <a href=\"" + kPublisherUrl + L"\">itradmin.ru</a>";
    const std::wstring installText = installed.empty() ? Tr(L"Установить") : Tr(L"Обновить");
    const std::wstring portableText = Tr(L"Запустить без установки");
    const std::wstring windowTitle = Tr(L"Установка CMD Manager");
    const std::wstring desktopText = Tr(L"Создать ярлык на рабочем столе");
    const std::wstring cancelText = Tr(L"Отмена");  // стандартная кнопка Windows была бы на языке системы

    TASKDIALOG_BUTTON buttons[] = {
        {kBtnInstall, installText.c_str()},
        {kBtnPortable, portableText.c_str()},
        {IDCANCEL, cancelText.c_str()},
    };
    TASKDIALOGCONFIG cfg{sizeof(cfg)};
    cfg.hInstance = hInst;
    cfg.dwFlags = TDF_USE_HICON_MAIN | TDF_ENABLE_HYPERLINKS | TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
    if (installed.empty()) cfg.dwFlags |= TDF_VERIFICATION_FLAG_CHECKED;
    cfg.pszWindowTitle = windowTitle.c_str();
    cfg.hMainIcon = static_cast<HICON>(LoadImageW(hInst, MAKEINTRESOURCEW(1), IMAGE_ICON, 64, 64, 0));
    cfg.pszMainInstruction = title.c_str();
    cfg.pszContent = content.c_str();
    cfg.pButtons = buttons;
    cfg.cButtons = static_cast<UINT>(std::size(buttons));
    cfg.nDefaultButton = kBtnInstall;
    cfg.pszVerificationText = installed.empty() ? desktopText.c_str() : nullptr;
    cfg.pszFooter = footer.c_str();
    cfg.pfCallback = TaskDialogLinks;

    int button = IDCANCEL;
    BOOL verification = FALSE;
    if (FAILED(TaskDialogIndirect(&cfg, &button, nullptr, &verification))) button = kBtnPortable;
    *desktopShortcut = verification != FALSE;
    return button;
}

int RunUninstall() {
    if (MessageBoxW(nullptr, Tr(L"Удалить CMD Manager с этого компьютера?").c_str(), kAppName, MB_ICONQUESTION | MB_YESNO) != IDYES)
        return 0;
    const fs::path target = InstalledExePath();
    if (!CloseRunningInstances(target, nullptr)) return 1;

    std::error_code ec;
    fs::remove(StartMenuShortcut(), ec);
    fs::remove(DesktopShortcut(), ec);
    RegDeleteTreeW(HKEY_CURRENT_USER, kUninstallKey);

    const fs::path data = KnownFolder(FOLDERID_RoamingAppData) / L"CMDManager";
    if (fs::exists(data, ec) &&
        MessageBoxW(nullptr,
                    TrF(L"Удалить также список проектов и настройки?\n\n{0}\n\nSSH-ключи в папке .ssh не затрагиваются.",
                        {data.wstring()})
                        .c_str(),
                    kAppName, MB_ICONQUESTION | MB_YESNO | MB_DEFBUTTON2) == IDYES)
        fs::remove_all(data, ec);

    // Папку с программой удаляем после выхода: запущенный exe сам себя удалить не может.
    const fs::path dir = InstallDir();
    if (fs::exists(dir, ec)) {
        std::wstring cmd = L"cmd.exe /d /c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir.wstring() + L"\"";
        STARTUPINFOW si{sizeof(si)};
        PROCESS_INFORMATION pi{};
        wchar_t sysDir[MAX_PATH];
        GetSystemDirectoryW(sysDir, MAX_PATH);
        if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, sysDir, &si, &pi)) {
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
    }
    MessageBoxW(nullptr, Tr(L"CMD Manager удалён.").c_str(), kAppName, MB_ICONINFORMATION | MB_OK);
    return 0;
}

// Обновление из работающей программы: ждём, пока она закроется, ставим себя и запускаем заново.
int RunUpdate(DWORD parentPid) {
    if (HANDLE p = OpenProcess(SYNCHRONIZE, FALSE, parentPid)) {
        WaitForSingleObject(p, 60000);
        CloseHandle(p);
    }
    if (!DoInstall(false, true, nullptr)) return 1;
    LaunchInstalled();
    return 0;
}

}  // namespace

UINT QuitForUpdateMessage() {
    static const UINT msg = RegisterWindowMessageW(L"CMDManager.QuitForUpdate");
    return msg;
}

std::wstring InstalledExePath() { return (InstallDir() / L"CMDManager.exe").wstring(); }

bool RunInstallerIfNeeded(HINSTANCE hInst, bool hasWebFolder, int* exitCode) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<std::wstring> args(argv + std::min(argc, 1), argv + argc);
    LocalFree(argv);
    auto has = [&](const wchar_t* flag) {
        return std::any_of(args.begin(), args.end(), [&](const std::wstring& a) { return _wcsicmp(a.c_str(), flag) == 0; });
    };

    if (has(L"--uninstall")) {
        *exitCode = RunUninstall();
        return true;
    }
    for (size_t i = 0; i + 1 < args.size(); ++i) {
        if (_wcsicmp(args[i].c_str(), L"--update-from") == 0) {
            *exitCode = RunUpdate(static_cast<DWORD>(_wtoi(args[i + 1].c_str())));
            return true;
        }
    }
    // Запуск из репозитория (рядом папка web), явный портативный режим или уже установленная копия — просто работаем.
    if (hasWebFolder || has(L"--portable") || SamePath(SelfPath(), InstalledExePath())) return false;

    bool desktop = false;
    switch (ShowInstallDialog(hInst, &desktop)) {
        case kBtnPortable:
            return false;
        case kBtnInstall:
            *exitCode = DoInstall(desktop, false, nullptr) ? 0 : 1;
            if (*exitCode == 0) LaunchInstalled();
            return true;
        default:
            *exitCode = 0;
            return true;
    }
}

bool LaunchUpdater(const std::wstring& setupPath, std::wstring* error) {
    std::wstring cmd = L"\"" + setupPath + L"\" --update-from " + std::to_wstring(GetCurrentProcessId());
    STARTUPINFOW si{sizeof(si)};
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
        *error = TrF(L"Не удалось запустить установщик (код {0})", {std::to_wstring(GetLastError())});
        return false;
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return true;
}
