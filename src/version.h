#pragma once

// Версия программы. При выпуске релиза меняется только здесь (тег на GitHub: v<CMDM_VERSION_STR>).
// Для тестовой сборки обновлений: /DCMDM_VERSION_OVERRIDE плюс свои CMDM_VERSION_* (MAJOR, MINOR, PATCH, STR, WSTR).
#ifndef CMDM_VERSION_OVERRIDE
#define CMDM_VERSION_MAJOR 1
#define CMDM_VERSION_MINOR 2
#define CMDM_VERSION_PATCH 0
#define CMDM_VERSION_STR "1.2.0"
#define CMDM_VERSION_WSTR L"1.2.0"
#endif

#define CMDM_GITHUB_REPO "yualko/CMDmanager"
#define CMDM_HOMEPAGE "https://github.com/" CMDM_GITHUB_REPO
