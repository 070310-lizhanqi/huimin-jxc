@echo off
chcp 65001 >nul
title 惠民服务管理
cd /d "%~dp0"
start "" http://127.0.0.1:7742
node tools\service-manager.cjs
echo.
echo 服务管理器已启动：http://127.0.0.1:7742
echo 本窗口可以最小化；关闭本窗口不影响已启动的服务。
echo 若提示找不到 node，请先安装 Node.js。
pause
