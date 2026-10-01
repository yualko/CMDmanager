@echo off
rem Build CMD Manager (MSVC, x64). Output: build\CMDManager.exe
setlocal
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto novs
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR goto novs
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

if not exist build mkdir build
powershell -NoProfile -ExecutionPolicy Bypass -File tools\pack-web.ps1 -Source web -Out build\web.bin || exit /b 1
rc /nologo /c 65001 /fo build\app.res src\app.rc || exit /b 1
cl /nologo /std:c++20 /EHsc /O2 /MT /utf-8 /W3 /DUNICODE /D_UNICODE /DNOMINMAX /DWIN32_LEAN_AND_MEAN ^
   /Ithird_party /Ithird_party\webview2 /Fobuild\ /Fdbuild\ ^
   src\main.cpp src\pty_session.cpp src\ssh_tools.cpp src\installer.cpp src\update.cpp build\app.res ^
   /Fe:build\CMDManager.exe ^
   /link /SUBSYSTEM:WINDOWS /MANIFEST:EMBED /MANIFESTINPUT:src\app.manifest ^
   third_party\webview2\WebView2LoaderStatic.lib user32.lib gdi32.lib ole32.lib shell32.lib dwmapi.lib advapi32.lib version.lib comctl32.lib shlwapi.lib winhttp.lib || exit /b 1

rem Release artifact: one exe that is the app, the installer and the updater at once
for /f "tokens=3" %%v in ('findstr /c:"define CMDM_VERSION_STR" src\version.h') do set "VER=%%~v"
if exist dist rmdir /s /q dist
mkdir dist
copy /y build\CMDManager.exe "dist\CMDManager-Setup-v%VER%.exe" >nul

echo.
echo Done: build\CMDManager.exe  (UI is loaded from the web\ folder)
echo Release: dist\CMDManager-Setup-v%VER%.exe
exit /b 0

:novs
echo Visual Studio with "Desktop development with C++" workload was not found.
exit /b 1
