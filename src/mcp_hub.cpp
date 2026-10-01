#include <winsock2.h>
#include <ws2tcpip.h>

#include "mcp_hub.h"

#include <bcrypt.h>
#include <shellapi.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

#include "nlohmann/json.hpp"
#include "version.h"

using json = nlohmann::json;

namespace {

// ---------- общее ----------

std::string RandomHex(size_t bytes) {
    std::string raw(bytes, '\0');
    BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(raw.data()), static_cast<ULONG>(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    static const char* hex = "0123456789abcdef";
    std::string out;
    for (unsigned char c : raw) out += hex[c >> 4], out += hex[c & 15];
    return out;
}

bool SendAll(SOCKET s, const std::string& data) {
    const char* p = data.data();
    size_t left = data.size();
    while (left > 0) {
        int n = send(s, p, static_cast<int>(left), 0);
        if (n <= 0) return false;
        p += n;
        left -= n;
    }
    return true;
}

// Читает из сокета построчно; onLine вызывается для каждой полной строки. Возвращается при закрытии.
template <typename F>
void ReadLines(SOCKET s, F onLine) {
    std::string buf;
    char chunk[16 * 1024];
    for (;;) {
        int n = recv(s, chunk, sizeof(chunk), 0);
        if (n <= 0) return;
        buf.append(chunk, n);
        for (size_t pos; (pos = buf.find('\n')) != std::string::npos;) {
            std::string line = buf.substr(0, pos);
            buf.erase(0, pos + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!line.empty()) onLine(line);
        }
    }
}

// ---------- узел в основной программе ----------

HWND g_notifyWnd = nullptr;
UINT g_notifyMsg = 0;
SOCKET g_listen = INVALID_SOCKET;
std::string g_address;
std::string g_secret;
std::mutex g_connMutex;
struct Conn {
    SOCKET s = INVALID_SOCKET;
    std::mutex m;
    std::atomic<bool> http{false};  // подключение по HTTP (Streamable HTTP MCP), а не строками от моста
};
std::map<int, std::shared_ptr<Conn>> g_conns;
std::atomic<int> g_nextConn{1};

void Notify(const json& j) {
    auto* text = new std::string(j.dump(-1, ' ', false, json::error_handler_t::replace));
    if (!PostMessageW(g_notifyWnd, g_notifyMsg, 0, reinterpret_cast<LPARAM>(text))) delete text;
}

void SendHttp(SOCKET s, int code, const char* status, const std::string& body, const std::string& extraHeaders = "") {
    std::string resp = "HTTP/1.1 " + std::to_string(code) + " " + status + "\r\n" + extraHeaders +
                       "Content-Length: " + std::to_string(body.size()) + "\r\n" +
                       (body.empty() ? "" : "Content-Type: application/json\r\n") + "Connection: keep-alive\r\n\r\n" + body;
    SendAll(s, resp);
}

// Одно соединение. Два вида клиентов:
//  * мост CMDManager.exe --mcp — строки JSON {"secret","token","msg"};
//  * MCP по HTTP (Streamable HTTP): POST /mcp/<секрет>/<токен> с JSON-RPC в теле.
//    Его используют агенты на Bun (OpenCode, MiMo): запуск нашего exe подпроцессом у них падает.
void ServeConnection(int conn, std::shared_ptr<Conn> c) {
    bool authorized = false;
    std::string buf;
    char chunk[16 * 1024];
    bool modeKnown = false;
    for (;;) {
        int n = recv(c->s, chunk, sizeof(chunk), 0);
        if (n <= 0) break;
        buf.append(chunk, n);
        if (!modeKnown && buf.size() >= 4) {
            c->http = buf.rfind("POST", 0) == 0 || buf.rfind("GET ", 0) == 0 || buf.rfind("DELE", 0) == 0 || buf.rfind("OPTI", 0) == 0;
            modeKnown = true;
        }
        if (!modeKnown) continue;

        if (!c->http) {
            for (size_t pos; (pos = buf.find('\n')) != std::string::npos;) {
                std::string line = buf.substr(0, pos);
                buf.erase(0, pos + 1);
                json j = json::parse(line, nullptr, false);
                if (j.is_discarded() || !j.is_object()) continue;
                // Посторонним (без секрета этого запуска программы) не отвечаем.
                if (j.value("secret", std::string()) != g_secret) {
                    shutdown(c->s, SD_BOTH);
                    break;
                }
                authorized = true;
                Notify({{"type", "mcp"}, {"conn", conn}, {"token", j.value("token", std::string())}, {"msg", j["msg"]}});
            }
            continue;
        }

        // HTTP: разбираем запросы по одному (заголовки + тело по Content-Length).
        for (;;) {
            const size_t headEnd = buf.find("\r\n\r\n");
            if (headEnd == std::string::npos) break;
            const std::string head = buf.substr(0, headEnd);
            size_t contentLength = 0;
            {
                std::string lower = head;
                for (auto& ch : lower) ch = static_cast<char>(tolower(static_cast<unsigned char>(ch)));
                const size_t cl = lower.find("content-length:");
                if (cl != std::string::npos) contentLength = static_cast<size_t>(atoll(head.c_str() + cl + 15));
            }
            if (buf.size() < headEnd + 4 + contentLength) break;
            const std::string body = buf.substr(headEnd + 4, contentLength);
            buf.erase(0, headEnd + 4 + contentLength);

            const std::string method = head.substr(0, head.find(' '));
            const size_t pathStart = head.find(' ') + 1;
            const std::string path = head.substr(pathStart, head.find(' ', pathStart) - pathStart);
            // /mcp/<секрет>/<токен>
            const std::string prefix = "/mcp/" + g_secret + "/";
            if (path.rfind(prefix, 0) != 0) {
                SendHttp(c->s, 404, "Not Found", "");
                continue;
            }
            const std::string token = path.substr(prefix.size());
            if (method != "POST") {
                // Поток событий от сервера (GET) не нужен — сервер отвечает только на запросы.
                SendHttp(c->s, 405, "Method Not Allowed", "", "Allow: POST\r\n");
                continue;
            }
            json msg = json::parse(body, nullptr, false);
            if (msg.is_discarded() || !msg.is_object()) {
                SendHttp(c->s, 400, "Bad Request", "");
                continue;
            }
            authorized = true;
            if (!msg.contains("id") || !msg.contains("method")) {
                SendHttp(c->s, 202, "Accepted", "");  // уведомление или ответ клиента — тела не нужно
                continue;
            }
            // Ответ придёт из интерфейса через McpHubSend и уйдёт HTTP-ответом.
            Notify({{"type", "mcp"}, {"conn", conn}, {"token", token}, {"msg", msg}});
        }
    }
    {
        std::lock_guard<std::mutex> lock(g_connMutex);
        g_conns.erase(conn);
    }
    closesocket(c->s);
    if (authorized) Notify({{"type", "mcpClosed"}, {"conn", conn}});
}

// ---------- мост (CMDManager.exe --mcp) ----------

std::mutex g_stdoutMutex;

void WriteStdout(const std::string& line) {
    std::lock_guard<std::mutex> lock(g_stdoutMutex);
    std::string data = line + "\n";
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data.data(), static_cast<DWORD>(data.size()), &written, nullptr);
}

std::string EnvA(const wchar_t* name) {
    wchar_t buf[512];
    DWORD n = GetEnvironmentVariableW(name, buf, 512);
    if (n == 0 || n >= 512) return {};
    int len = WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(n), nullptr, 0, nullptr, nullptr);
    std::string s(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(n), s.data(), len, nullptr, nullptr);
    return s;
}

// Ответы без программы: консоль не входит в команду или CMD Manager закрыт.
void AnswerOffline(const json& msg) {
    if (!msg.contains("id")) return;  // уведомления без ответа
    const std::string method = msg.value("method", std::string());
    json res = {{"jsonrpc", "2.0"}, {"id", msg["id"]}};
    if (method == "initialize") {
        res["result"] = {{"protocolVersion", msg.contains("params") ? msg["params"].value("protocolVersion", std::string("2025-06-18")) : "2025-06-18"},
                         {"capabilities", {{"tools", json::object()}}},
                         {"serverInfo", {{"name", "cmdmanager"}, {"version", CMDM_VERSION_STR}}}};
    } else if (method == "tools/list") {
        res["result"] = {{"tools", json::array()}};
    } else if (method == "ping") {
        res["result"] = json::object();
    } else {
        res["error"] = {{"code", -32000}, {"message", "CMD Manager is not running or this console is not part of a team"}};
    }
    WriteStdout(res.dump());
}

int RunBridge() {
    const std::string addr = EnvA(L"CMDM_MCP_ADDR"), secret = EnvA(L"CMDM_MCP_SECRET"), token = EnvA(L"CMDM_MCP_TOKEN");
    SOCKET s = INVALID_SOCKET;
    WSADATA wsa;
    if (!addr.empty() && WSAStartup(MAKEWORD(2, 2), &wsa) == 0) {
        const size_t colon = addr.rfind(':');
        sockaddr_in sa{};
        sa.sin_family = AF_INET;
        sa.sin_port = htons(static_cast<u_short>(atoi(addr.c_str() + colon + 1)));
        inet_pton(AF_INET, addr.substr(0, colon).c_str(), &sa.sin_addr);
        s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s != INVALID_SOCKET && connect(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) != 0) {
            closesocket(s);
            s = INVALID_SOCKET;
        }
    }

    // Ответы программы → stdout агента.
    if (s != INVALID_SOCKET) {
        std::thread([s] {
            ReadLines(s, [](const std::string& line) {
                // Программа присылает готовое JSON-RPC сообщение — передаём его агенту как есть.
                json j = json::parse(line, nullptr, false);
                if (!j.is_discarded()) WriteStdout(j.dump(-1, ' ', false, json::error_handler_t::replace));
            });
            ExitProcess(0);  // программа закрылась — завершаем и мост
        }).detach();
    }

    // Запросы агента (stdin) → программа.
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    std::string buf;
    char chunk[16 * 1024];
    for (;;) {
        DWORD n = 0;
        if (!ReadFile(in, chunk, sizeof(chunk), &n, nullptr) || n == 0) break;
        buf.append(chunk, n);
        for (size_t pos; (pos = buf.find('\n')) != std::string::npos;) {
            std::string line = buf.substr(0, pos);
            buf.erase(0, pos + 1);
            json msg = json::parse(line, nullptr, false);
            if (msg.is_discarded()) continue;
            if (s == INVALID_SOCKET) {
                AnswerOffline(msg);
                continue;
            }
            json wrapped = {{"secret", secret}, {"token", token}, {"msg", msg}};
            if (!SendAll(s, wrapped.dump(-1, ' ', false, json::error_handler_t::replace) + "\n")) {
                closesocket(s);
                s = INVALID_SOCKET;
                AnswerOffline(msg);
            }
        }
    }
    if (s != INVALID_SOCKET) closesocket(s);
    return 0;
}

}  // namespace

bool McpHubStart(HWND notifyWnd, UINT msgId) {
    g_notifyWnd = notifyWnd;
    g_notifyMsg = msgId;
    g_secret = RandomHex(16);
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
    g_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (g_listen == INVALID_SOCKET) return false;
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  // только локально — брандмауэр не спрашивает
    sa.sin_port = 0;                               // свободный порт
    if (bind(g_listen, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) != 0 || listen(g_listen, SOMAXCONN) != 0) return false;
    int len = sizeof(sa);
    getsockname(g_listen, reinterpret_cast<sockaddr*>(&sa), &len);
    g_address = "127.0.0.1:" + std::to_string(ntohs(sa.sin_port));

    std::thread([] {
        for (;;) {
            SOCKET client = accept(g_listen, nullptr, nullptr);
            if (client == INVALID_SOCKET) return;
            const int conn = g_nextConn++;
            auto c = std::make_shared<Conn>();
            c->s = client;
            {
                std::lock_guard<std::mutex> lock(g_connMutex);
                g_conns[conn] = c;
            }
            std::thread(ServeConnection, conn, c).detach();
        }
    }).detach();
    return true;
}

std::string McpHubAddress() { return g_address; }
std::string McpHubSecret() { return g_secret; }

void McpHubSend(int conn, const std::string& jsonLine) {
    std::shared_ptr<Conn> c;
    {
        std::lock_guard<std::mutex> lock(g_connMutex);
        auto it = g_conns.find(conn);
        if (it == g_conns.end()) return;
        c = it->second;
    }
    std::lock_guard<std::mutex> lock(c->m);
    if (c->http) SendHttp(c->s, 200, "OK", jsonLine);
    else SendAll(c->s, jsonLine + "\n");
}

bool RunMcpBridgeIfRequested(int* exitCode) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool bridge = false;
    for (int i = 1; i < argc; ++i) bridge |= _wcsicmp(argv[i], L"--mcp") == 0;
    LocalFree(argv);
    if (!bridge) return false;
    *exitCode = RunBridge();
    return true;
}
