#pragma once

#include <windows.h>

#include <string>

// Связь агентов с CMD Manager по MCP.
//
// Агент запускает «CMDManager.exe --mcp» как обычный stdio MCP-сервер. Этот процесс-мост пересылает
// JSON-RPC сообщения в работающую программу через TCP 127.0.0.1 (порт и секрет — в переменных окружения
// консоли: CMDM_MCP_ADDR, CMDM_MCP_SECRET, CMDM_MCP_TOKEN). Программа отвечает от имени роли консоли
// (оркестратор, разработчик, проверяющий) — логика команды живёт в интерфейсе.

// Запуск приёма подключений. Каждое входящее сообщение уходит окну notifyWnd сообщением msgId
// (lParam = std::string* с JSON: {"type":"mcp","conn":N,"token":"…","msg":{…}} или {"type":"mcpClosed","conn":N}).
bool McpHubStart(HWND notifyWnd, UINT msgId);
std::string McpHubAddress();  // "127.0.0.1:порт"
std::string McpHubSecret();
void McpHubSend(int conn, const std::string& jsonLine);

// Режим моста: если программа запущена с --mcp — работает как stdio MCP-сервер и возвращает true.
bool RunMcpBridgeIfRequested(int* exitCode);
