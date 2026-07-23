@echo off
REM ============================================================================
REM  Sard — one-step TEST build (RAWY-35 / RAWY-TOOLING).
REM  Double-click this to rebuild the standalone app from the CURRENT source
REM  (INCLUDING uncommitted changes) into:  test-build\Sard.exe
REM
REM  It just runs `npm run build:test`, which:
REM    1. checks cargo is resolvable (falls back to %USERPROFILE%\.cargo\bin, or aborts
REM       loudly telling you to install Rust / fix PATH — see BUILD.md),
REM    2. closes any running Sard (incl. "Sard-standalone.exe") — or aborts loudly,
REM    3. does a FAST `tauri build --no-bundle` (NO installer — the Share/release
REM       bundle is a SEPARATE full build; see BUILD.md / SHARE-RELEASE.md),
REM    4. copies the exe + piper engine to test-build\.
REM
REM  To USE the app afterwards, double-click:  test-build\Sard.exe
REM ============================================================================
setlocal
cd /d "%~dp0"

call npm run build:test
if errorlevel 1 (
  echo.
  echo [Sard] TEST BUILD FAILED. See the messages above.
  pause
  exit /b 1
)

echo.
echo [Sard] Done. Launch the app by double-clicking:
echo        %~dp0test-build\Sard.exe
echo.
pause
endlocal
