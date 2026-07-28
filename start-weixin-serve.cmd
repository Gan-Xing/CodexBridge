@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=C:\Users\Owner\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined CODEX_REAL_BIN for /f "delims=" %%I in ('where codex.exe 2^>nul') do if not defined CODEX_REAL_BIN set "CODEX_REAL_BIN=%%I"
if not defined CODEX_REAL_BIN set "CODEX_REAL_BIN=codex.exe"
set "CODEX_APP_SERVER_TRANSPORT=stdio"
set "CODEXBRIDGE_DEFAULT_CWD=C:\Users\Owner\Documents\New project"
set "CODEXBRIDGE_LOCALE=zh-CN"
"%NODE_EXE%" node_modules\tsx\dist\cli.mjs src\cli.ts weixin serve --state-dir ".codexbridge" --cwd "C:\Users\Owner\Documents\New project"
