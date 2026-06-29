@echo off
rem ===========================================================================
rem  build-all.bat - Windows build of the Carbon desktop installers.
rem
rem  Tauri cannot cross-compile, so this produces only the Windows bundles:
rem      .msi  and  NSIS .exe (setup)
rem  Run build-all.sh on Linux/macOS for the .deb/.rpm/.AppImage/.dmg + Android.
rem
rem  Prerequisites on the Windows host:
rem    - Node.js + npm, and `npm install` already run at the repo root
rem    - Rust (rustup, MSVC toolchain) and the MSVC C++ Build Tools
rem    - WebView2 runtime (present on Win10/11 by default)
rem
rem  Usage (from the repo root, in cmd or PowerShell):
rem      build-all.bat
rem ===========================================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "RELEASE_DIR=%CD%\release"
set "BUNDLE_DIR=%CD%\apps\desktop\src-tauri\target\release\bundle"

rem --- version (single-sourced from repo-root package.json) ------------------
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VERSION=%%v"
echo ==^> Carbon v%VERSION% ^(Windows^)

if not exist "%RELEASE_DIR%" mkdir "%RELEASE_DIR%"

rem --- prerequisite: Rust toolchain (Tauri compiles a native binary) --------
where cargo >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Rust ^(cargo^) was not found on PATH.
  echo Tauri needs the Rust MSVC toolchain to compile the desktop app.
  echo.
  echo   1. Install Rust:  https://rustup.rs
  echo      ^(pick the default host triple x86_64-pc-windows-msvc^)
  echo   2. Install the "Desktop development with C++" workload from the
  echo      Visual Studio Build Tools ^(provides the MSVC linker^).
  echo   3. WebView2 runtime ^(already present on current Win10/11^).
  echo.
  echo Then open a NEW terminal ^(so PATH refreshes^) and re-run build-all.bat.
  exit /b 1
)

rem --- desktop (Tauri) ------------------------------------------------------
echo ==^> Building desktop bundle ^(npm run -w @carbon/desktop build^)
call npm run -w @carbon/desktop build
if errorlevel 1 (
  echo Desktop build failed.
  exit /b 1
)

rem --- collect --------------------------------------------------------------
echo ==^> Collecting Windows artifacts for v%VERSION%
copy /Y "%BUNDLE_DIR%\msi\Carbon_%VERSION%_*.msi" "%RELEASE_DIR%\" >nul 2>&1 && echo     + msi || echo     ! msi: no artifact found
copy /Y "%BUNDLE_DIR%\nsis\Carbon_%VERSION%_*-setup.exe" "%RELEASE_DIR%\" >nul 2>&1 && echo     + nsis exe || echo     ! nsis: no artifact found

echo.
echo ==^> Done. Artifacts in %RELEASE_DIR%:
dir /b "%RELEASE_DIR%"
echo.
echo Note: Tauri cannot cross-compile. Build the Linux/macOS desktop bundles and
echo the Android APK on those OSes via build-all.sh.

endlocal
