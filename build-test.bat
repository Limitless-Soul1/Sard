@echo off
REM ============================================================================
REM  Sard — one-step release build for direct testing (RAWY-35).
REM  Double-click this file (or run it) to rebuild the standalone app after a
REM  code change. It produces a real Windows .exe that runs WITHOUT any dev
REM  server, then copies it to:  test-build\Sard.exe  (always the same path).
REM
REM  To USE the app afterwards, just double-click:  test-build\Sard.exe
REM ============================================================================
setlocal
cd /d "%~dp0"

REM Close any running copy first so the fresh binary can overwrite test-build\Sard.exe.
taskkill /IM Sard.exe /F >nul 2>&1
taskkill /IM sard.exe /F >nul 2>&1

echo.
echo [Sard] Building the release app (this compiles Rust in release mode and may
echo        take a few minutes the first time)...
echo.

call npm run tauri build
if errorlevel 1 (
  echo.
  echo [Sard] Build FAILED. See the messages above.
  exit /b 1
)

if not exist "test-build" mkdir "test-build"
copy /Y "src-tauri\target\release\sard.exe" "test-build\Sard.exe" >nul
if errorlevel 1 (
  echo [Sard] Could not copy the binary. Is src-tauri\target\release\sard.exe present?
  exit /b 1
)

echo.
echo [Sard] Done. Launch the app by double-clicking:
echo        %~dp0test-build\Sard.exe
echo.
endlocal
