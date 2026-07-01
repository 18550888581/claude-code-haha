@echo off
chcp 65001 >nul
title Claude Code Haha Launcher
cd /d "%~dp0"
setlocal EnableExtensions

:MENU
cls
echo.
echo ==========================================
echo        Claude Code Haha 启动器
echo ==========================================
echo.
echo 当前目录:
echo %cd%
echo.
echo 请选择要使用的模型:
echo.
echo [1] Qwen3.7 Max - 阿里百炼 / 多模态 / 看图 / 综合任务
echo [2] DeepSeek V4 Pro - 代码开发 / 低成本 / 长文本
echo.
set /p MODEL_CHOICE=请输入 1 或 2 后按回车:

if "%MODEL_CHOICE%"=="1" goto QWEN
if "%MODEL_CHOICE%"=="2" goto DEEPSEEK

echo.
echo 输入无效，请重新选择。
pause
goto MENU

:QWEN
set "ENV_FILE=.env.qwen"
set "MODEL_NAME=Qwen3.7 Max"
goto CHECK_ENV

:DEEPSEEK
set "ENV_FILE=.env.deepseek"
set "MODEL_NAME=DeepSeek V4 Pro"
goto CHECK_ENV

:CHECK_ENV
echo.
echo 正在切换到 %MODEL_NAME%...

if not exist "%ENV_FILE%" (
    echo.
    echo [错误] 找不到 %ENV_FILE% 文件。
    echo 请确认当前目录下已经创建了 %ENV_FILE%。
    echo.
    pause
    exit /b
)

copy /Y "%ENV_FILE%" ".env" >nul

echo.
echo 已切换模型: %MODEL_NAME%
echo.

goto START

:START
set CLAUDE_CODE_SYNTAX_HIGHLIGHT=0
set CLAUDE_CODE_FORCE_RECOVERY_CLI=1
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
set DISABLE_TELEMETRY=1

REM 清除可能残留的 ANTHROPIC_API_KEY，避免和 ANTHROPIC_AUTH_TOKEN 冲突
set ANTHROPIC_API_KEY=

where bun >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 未检测到 bun 命令。
    echo 请确认 Bun 已安装，并重新打开终端。
    echo.
    pause
    exit /b
)

echo 正在以全权限模式启动 Claude Code Haha...
echo 当前模型: %MODEL_NAME%
echo.
echo 如果仍然频繁询问权限，说明当前版本不支持 bypassPermissions，将自动尝试备用参数。
echo.

bun --env-file=.env .\src\entrypoints\cli.tsx --permission-mode bypassPermissions

if errorlevel 1 (
    echo.
    echo 第一次启动方式失败，正在尝试备用全权限参数...
    echo.
    bun --env-file=.env .\src\entrypoints\cli.tsx --dangerously-skip-permissions
)

echo.
echo Claude Code 已退出。
pause