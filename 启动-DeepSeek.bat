@echo off
chcp 65001 >nul
title Claude Code Haha - DeepSeek V4 Pro
cd /d "%~dp0"

set CLAUDE_CODE_SYNTAX_HIGHLIGHT=0
set CLAUDE_CODE_FORCE_RECOVERY_CLI=1
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
set DISABLE_TELEMETRY=1
set ANTHROPIC_API_KEY=

echo ==========================================
echo 正在启动 DeepSeek V4 Pro
echo ==========================================
echo.

bun --env-file=.env.deepseek .\src\entrypoints\cli.tsx --permission-mode bypassPermissions

if errorlevel 1 (
    echo.
    echo DeepSeek 启动失败，尝试备用全权限参数...
    bun --env-file=.env.deepseek .\src\entrypoints\cli.tsx --dangerously-skip-permissions
)

pause