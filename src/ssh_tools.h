#pragma once

#include <windows.h>

#include <string>
#include <vector>

#include "nlohmann/json.hpp"

// Командная строка Windows из списка аргументов (правила разбора MSVCRT/CommandLineToArgvW).
std::wstring QuoteArg(const std::wstring& arg);
std::wstring JoinCommandLine(const std::vector<std::wstring>& args);

// Путь к утилите OpenSSH (System32\OpenSSH\<name>), либо просто имя — тогда её найдёт PATH.
std::wstring OpenSshTool(const wchar_t* name);
bool OpenSshAvailable();

struct RunResult {
    bool started = false;
    bool timedOut = false;
    DWORD exitCode = 0;
    std::string output;  // stdout + stderr
};

// Запускает консольную программу без окна и ждёт завершения.
RunResult RunHidden(const std::wstring& commandLine, DWORD timeoutMs);

// Готовит ключ для подключения: создаёт ~/.ssh/id_ed25519_<host> (если его нет)
// и проверяет, пускает ли сервер по этому ключу.
// Возвращает { keyPath, publicKey, keyCreated, authOk, needsInstall, error }.
nlohmann::json PrepareSshKey(const std::string& host, int port, const std::string& user);

// Проверка имени хоста / пользователя: только безопасные символы, без ведущего «-».
bool IsValidSshHost(const std::string& host);
bool IsValidSshUser(const std::string& user);
