#pragma once

#include <windows.h>

#include <string>
#include <utility>
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

// Запускает консольную программу без окна и ждёт завершения. extraEnv добавляется к окружению.
RunResult RunHidden(const std::wstring& commandLine, DWORD timeoutMs,
                    const std::vector<std::pair<std::wstring, std::wstring>>& extraEnv = {});

struct SshTarget {
    std::string host;
    int port = 22;
    std::string user;
};

// Подключение к серверу: создаёт ключ ~/.ssh/id_ed25519_<host> (или берёт существующий),
// проверяет вход по ключу и, если сервер его ещё не знает, устанавливает ключ, войдя по паролю.
// Пароль передаётся ssh через SSH_ASKPASS (askpassExe — наш же exe) и нигде не сохраняется.
// Результат: { keyPath, keyCreated, keyInstalled } | { needsPassword, keyPath } | { error }.
nlohmann::json SshConnect(const SshTarget& target, const std::string& password, const std::wstring& askpassExe);

// Список подпапок на сервере: { path (абсолютный), dirs: [...] } | { error }.
nlohmann::json SshListDir(const SshTarget& target, const std::string& keyPath, const std::string& path);

// Создаёт подпапку name в parent: { path } | { error }.
nlohmann::json SshMakeDir(const SshTarget& target, const std::string& keyPath, const std::string& parent,
                          const std::string& name);

// Какие из команд names установлены на сервере (проверка через login-оболочку пользователя): { found: [...] } | { error }.
nlohmann::json SshDetectCommands(const SshTarget& target, const std::string& keyPath,
                                 const std::vector<std::string>& names);

// Режим SSH_ASKPASS: если процесс запущен ssh как askpass-программа, печатает пароль и возвращает true.
bool RunAsAskpassIfRequested(int* exitCode);
