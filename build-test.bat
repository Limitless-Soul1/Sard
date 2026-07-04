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

REM RAWY-108: copy the bundled TTS engine (piper.exe + DLLs + espeak-ng-data + tashkeel model) beside
REM the exe. It is an EXTERNAL resource (not embedded in the exe), so without this read-aloud fails
REM in the standalone test-build with "piper engine not found at ...\test-build\piper\piper.exe".
if not exist "src-tauri\target\release\piper\piper.exe" (
  echo [Sard] TTS engine missing at src-tauri\target\release\piper — read-aloud will fail. Check bundle.resources.
  exit /b 1
)
if exist "test-build\piper" rmdir /S /Q "test-build\piper"
xcopy /E /I /Y "src-tauri\target\release\piper" "test-build\piper" >nul
if errorlevel 1 (
  echo [Sard] Could not copy the TTS engine to test-build\piper.
  exit /b 1
)

echo.
echo [Sard] Done. Launch the app by double-clicking:
echo        %~dp0test-build\Sard.exe
echo.
endlocal
