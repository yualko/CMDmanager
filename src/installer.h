#pragma once

#include <windows.h>

#include <string>

// Сообщение «закройся без вопросов» — его шлёт установщик работающей копии программы,
// когда пользователь уже согласился на обновление.
UINT QuitForUpdateMessage();

// Куда ставится программа: %LOCALAPPDATA%\Programs\CMDManager\CMDManager.exe (права администратора не нужны).
std::wstring InstalledExePath();

// Режимы установщика. Вызывается в начале wWinMain.
// Возвращает true, если процесс должен завершиться с кодом *exitCode (установка/обновление/удаление/отмена).
// hasWebFolder — рядом лежит папка web (запуск из репозитория): тогда установщик не предлагается.
bool RunInstallerIfNeeded(HINSTANCE hInst, bool hasWebFolder, int* exitCode);

// Запустить скачанный установщик в режиме обновления этого процесса.
bool LaunchUpdater(const std::wstring& setupPath, std::wstring* error);
