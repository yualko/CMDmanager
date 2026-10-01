#pragma once

#include <windows.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// Один процесс (PowerShell), подключённый к псевдоконсоли ConPTY.
// Вывод читается в отдельном потоке и копится в буфере; владелец забирает его через TakeOutput().
class PtySession {
public:
    using NotifyFn = std::function<void()>;  // вызывается из фонового потока: «есть новый вывод» / «процесс завершился»

    PtySession(int id, NotifyFn onOutput, NotifyFn onExit);
    ~PtySession();

    PtySession(const PtySession&) = delete;
    PtySession& operator=(const PtySession&) = delete;

    // commandLine — полная командная строка, cwd — рабочая папка (может быть пустой).
    // extraEnv — переменные окружения поверх текущих (например, папка аккаунта агента).
    bool Start(const std::wstring& commandLine, const std::wstring& cwd, short cols, short rows, HANDLE job,
               std::wstring* error, const std::vector<std::pair<std::wstring, std::wstring>>& extraEnv = {});

    void Write(const std::string& utf8);
    void Resize(short cols, short rows);
    void Terminate();

    // Забирает накопленный вывод (UTF-8, всегда целыми символами).
    std::string TakeOutput();

    int Id() const { return id_; }
    bool Exited() const { return exited_; }
    DWORD ExitCode() const { return exitCode_; }

private:
    void ReadLoop();
    void WaitLoop();

    int id_;
    NotifyFn onOutput_;
    NotifyFn onExit_;

    HPCON pc_ = nullptr;
    HANDLE inWrite_ = nullptr;   // мы пишем -> ввод консоли
    HANDLE outRead_ = nullptr;   // вывод консоли -> мы читаем
    HANDLE process_ = nullptr;

    std::thread reader_;
    std::thread waiter_;

    std::mutex outMutex_;
    std::string outBuf_;
    std::string partial_;        // хвост незавершённого UTF-8 символа между чтениями
    bool notifyPending_ = false;

    std::mutex pcMutex_;
    std::atomic<bool> exited_{false};
    std::atomic<DWORD> exitCode_{0};
};
