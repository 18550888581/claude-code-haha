@echo off
chcp 65001 >nul
title Claude Code Haha - Qwen3.7 Max
cd /d "%~dp0"

set CLAUDE_CODE_SYNTAX_HIGHLIGHT=0
set CLAUDE_CODE_FORCE_RECOVERY_CLI=1
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
set DISABLE_TELEMETRY=1
set ANTHROPIC_API_KEY=

echo ==========================================
echo 正在启动 Qwen3.7 Max
echo ==========================================
echo.

bun --env-file=.env.qwen .\src\entrypoints\cli.tsx --permission-mode bypassPermissions

if errorlevel 1 (
    echo.
    echo Qwen 启动失败，尝试备用全权限参数...
    bun --env-file=.env.qwen .\src\entrypoints\cli.tsx --dangerously-skip-permissions
)

pause