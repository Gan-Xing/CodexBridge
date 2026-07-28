@echo off
setlocal
cd /d "%~dp0"
if not defined NODE_EXE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE set "NODE_EXE=node.exe"
if not defined CODEX_REAL_BIN for /f "delims=" %%I in ('where codex.exe 2^>nul') do if not defined CODEX_REAL_BIN set "CODEX_REAL_BIN=%%I"
if not defined CODEX_REAL_BIN set "CODEX_REAL_BIN=codex.exe"
if not defined CODEX_APP_SERVER_TRANSPORT set "CODEX_APP_SERVER_TRANSPORT=stdio"
if not defined CODEXBRIDGE_DEFAULT_CWD set "CODEXBRIDGE_DEFAULT_CWD=%USERPROFILE%\Documents"
if not defined CODEXBRIDGE_LOCALE set "CODEXBRIDGE_LOCALE=zh-CN"
"%NODE_EXE%" node_modules\tsx\dist\cli.mjs src\cli.ts weixin login --state-dir ".codexbridge" --timeout-sec 480
