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
rc /nologo /fo build\app.res src\app.rc || exit /b 1
cl /nologo /std:c++20 /EHsc /O2 /MT /utf-8 /W3 /DUNICODE /D_UNICODE /DNOMINMAX /DWIN32_LEAN_AND_MEAN ^
   /Ithird_party /Ithird_party\webview2 /Fobuild\ /Fdbuild\ ^
   src\main.cpp src\pty_session.cpp build\app.res ^
   /Fe:build\CMDManager.exe ^
   /link /SUBSYSTEM:WINDOWS /MANIFEST:EMBED /MANIFESTINPUT:src\app.manifest ^
   third_party\webview2\WebView2LoaderStatic.lib user32.lib gdi32.lib ole32.lib shell32.lib dwmapi.lib advapi32.lib version.lib || exit /b 1

rem Ready-to-run portable folder: dist\CMDManager (exe + web)
if exist dist\CMDManager rmdir /s /q dist\CMDManager
mkdir dist\CMDManager
copy /y build\CMDManager.exe dist\CMDManager\ >nul
xcopy /e /i /q /y web dist\CMDManager\web >nul

echo.
echo Done: build\CMDManager.exe  (UI is loaded from the web\ folder)
echo Portable copy: dist\CMDManager\
exit /b 0

:novs
echo Visual Studio with "Desktop development with C++" workload was not found.
exit /b 1
