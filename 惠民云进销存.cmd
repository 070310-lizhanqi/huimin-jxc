@echo off
chcp 65001 >nul
title 惠民云进销存
rem 双击启动：拉起本地服务并自动打开浏览器；本窗口可最小化，关闭不影响已启动的服务。
cd /d "%~dp0"
"%~dp0node\node.exe" "%~dp0launcher.cjs"
echo.
echo 惠民云进销存已退出。数据保存在：%APPDATA%\huimin-yun
pause
