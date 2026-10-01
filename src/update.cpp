#include "update.h"

#include <winhttp.h>

#include <filesystem>
#include <vector>

#include "nlohmann/json.hpp"
#include "version.h"

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

struct Handle {
    HINTERNET h = nullptr;
    ~Handle() {
        if (h) WinHttpCloseHandle(h);
    }
};

// GET по HTTPS. Тело пишется в body или (если file задан) в файл. Редиректы WinHTTP проходит сам.
bool HttpGet(const std::string& url, const wchar_t* accept, std::string* body, HANDLE file, std::string* error,
             const std::function<void(uint64_t, uint64_t)>& progress = {}) {
    auto fail = [&](const std::string& what) {
        *error = what + " (код " + std::to_string(GetLastError()) + ")";
        return false;
    };
    std::wstring wurl = Widen(url);
    URL_COMPONENTS uc{sizeof(uc)};
    wchar_t host[256] = {}, path[2048] = {};
    uc.lpszHostName = host;
    uc.dwHostNameLength = static_cast<DWORD>(std::size(host));
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = static_cast<DWORD>(std::size(path));
    wchar_t extra[2048] = {};
    uc.lpszExtraInfo = extra;
    uc.dwExtraInfoLength = static_cast<DWORD>(std::size(extra));
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc) || uc.nScheme != INTERNET_SCHEME_HTTPS) return fail("Некорректный адрес");

    Handle session{WinHttpOpen(L"CMDManager/" CMDM_VERSION_WSTR, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session.h) return fail("Не удалось открыть HTTP-сессию");
    WinHttpSetTimeouts(session.h, 10000, 10000, 15000, 60000);
    Handle connect{WinHttpConnect(session.h, host, uc.nPort, 0)};
    if (!connect.h) return fail("Не удалось подключиться к серверу");
    std::wstring object = std::wstring(path) + extra;
    Handle request{WinHttpOpenRequest(connect.h, L"GET", object.c_str(), nullptr, WINHTTP_NO_REFERER,
                                      WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE)};
    if (!request.h) return fail("Не удалось создать запрос");
    std::wstring headers = std::wstring(L"Accept: ") + accept;
    if (!WinHttpSendRequest(request.h, headers.c_str(), static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request.h, nullptr))
        return fail("Нет связи с GitHub");

    DWORD status = 0, size = sizeof(status);
    WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                        &status, &size, WINHTTP_NO_HEADER_INDEX);
    if (status != 200) {
        *error = "Сервер ответил кодом " + std::to_string(status);
        return false;
    }
    uint64_t total = 0;
    wchar_t lenBuf[32] = {};
    DWORD lenSize = sizeof(lenBuf);
    if (WinHttpQueryHeaders(request.h, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, lenBuf, &lenSize,
                            WINHTTP_NO_HEADER_INDEX))
        total = _wcstoui64(lenBuf, nullptr, 10);

    uint64_t received = 0;
    std::vector<char> buf(64 * 1024);
    for (;;) {
        DWORD n = 0;
        if (!WinHttpReadData(request.h, buf.data(), static_cast<DWORD>(buf.size()), &n)) return fail("Обрыв загрузки");
        if (n == 0) break;
        if (file) {
            DWORD written = 0;
            if (!WriteFile(file, buf.data(), n, &written, nullptr) || written != n) return fail("Не удалось записать файл");
        } else {
            body->append(buf.data(), n);
        }
        received += n;
        if (progress) progress(received, total);
    }
    return true;
}

std::vector<int> ParseVersion(std::string v) {
    if (!v.empty() && (v[0] == 'v' || v[0] == 'V')) v.erase(0, 1);
    std::vector<int> parts;
    size_t i = 0;
    while (i < v.size() && parts.size() < 4) {
        size_t j = i;
        while (j < v.size() && isdigit(static_cast<unsigned char>(v[j]))) ++j;
        if (j == i) break;
        parts.push_back(std::stoi(v.substr(i, j - i)));
        if (j >= v.size() || v[j] != '.') break;
        i = j + 1;
    }
    while (parts.size() < 3) parts.push_back(0);
    return parts;
}

}  // namespace

int CompareVersions(const std::string& a, const std::string& b) {
    auto pa = ParseVersion(a), pb = ParseVersion(b);
    for (size_t i = 0; i < std::max(pa.size(), pb.size()); ++i) {
        int x = i < pa.size() ? pa[i] : 0, y = i < pb.size() ? pb[i] : 0;
        if (x != y) return x < y ? -1 : 1;
    }
    return 0;
}

UpdateInfo CheckForUpdate() {
    UpdateInfo info;
    std::string body;
    if (!HttpGet("https://api.github.com/repos/" CMDM_GITHUB_REPO "/releases/latest", L"application/vnd.github+json",
                 &body, nullptr, &info.error))
        return info;
    json j = json::parse(body, nullptr, false);
    if (j.is_discarded() || !j.is_object()) {
        info.error = "Неожиданный ответ GitHub";
        return info;
    }
    std::string tag = j.value("tag_name", std::string());
    info.version = tag.size() > 1 && (tag[0] == 'v' || tag[0] == 'V') ? tag.substr(1) : tag;
    info.pageUrl = j.value("html_url", std::string());
    info.notes = j.value("body", std::string());
    // Установщик — .exe в ассетах релиза (предпочитаем «...Setup...exe»).
    for (const auto& a : j.value("assets", json::array())) {
        std::string name = a.value("name", std::string());
        if (name.size() < 4 || _stricmp(name.c_str() + name.size() - 4, ".exe") != 0) continue;
        if (info.downloadUrl.empty() || name.find("Setup") != std::string::npos) {
            info.downloadUrl = a.value("browser_download_url", std::string());
            info.size = a.value("size", uint64_t{0});
        }
    }
    info.available = !info.version.empty() && !info.downloadUrl.empty() &&
                     CompareVersions(info.version, CMDM_VERSION_STR) > 0;
    return info;
}

bool DownloadUpdate(const UpdateInfo& info, std::wstring* path, std::string* error,
                    const std::function<void(uint64_t, uint64_t)>& progress) {
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    fs::path target = fs::path(tmp) / (L"CMDManager-Setup-" + Widen(info.version) + L".exe");
    fs::path part = target;
    part += L".part";

    HANDLE file = CreateFileW(part.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        *error = "Не удалось создать временный файл";
        return false;
    }
    bool ok = HttpGet(info.downloadUrl, L"application/octet-stream", nullptr, file, error, progress);
    CloseHandle(file);

    std::error_code ec;
    if (ok && info.size && fs::file_size(part, ec) != info.size) {
        *error = "Файл скачался не полностью";
        ok = false;
    }
    if (ok) {
        // Простейшая проверка, что это исполняемый файл, а не страница с ошибкой.
        char mz[2] = {};
        HANDLE f = CreateFileW(part.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        DWORD n = 0;
        if (f != INVALID_HANDLE_VALUE) {
            ReadFile(f, mz, 2, &n, nullptr);
            CloseHandle(f);
        }
        if (n != 2 || mz[0] != 'M' || mz[1] != 'Z') {
            *error = "Скачанный файл не похож на программу";
            ok = false;
        }
    }
    if (!ok || !MoveFileExW(part.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        if (ok) *error = "Не удалось сохранить файл обновления";
        fs::remove(part, ec);
        return false;
    }
    *path = target.wstring();
    return true;
}
