#pragma once

#include <windows.h>

#include <cstdint>
#include <functional>
#include <string>

struct UpdateInfo {
    std::string error;        // пусто — проверка прошла
    bool available = false;   // на GitHub версия новее текущей
    std::string version;      // например "1.3.0"
    std::string pageUrl;      // страница релиза
    std::string notes;        // описание релиза
    std::string downloadUrl;  // установщик (.exe) из релиза
    uint64_t size = 0;
};

// Последний релиз на GitHub (синхронно, вызывать из фонового потока).
UpdateInfo CheckForUpdate();

// Скачивает установщик во временную папку. progress(получено, всего) вызывается из этого же потока.
bool DownloadUpdate(const UpdateInfo& info, std::wstring* path, std::string* error,
                    const std::function<void(uint64_t, uint64_t)>& progress);

// Сравнение версий вида "1.2.0" / "v1.2.0": <0, 0, >0.
int CompareVersions(const std::string& a, const std::string& b);
