@echo off
title Deploy Production
node scripts/deploy.js
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Deploy bit loi!
    pause
    exit /b %ERRORLEVEL%
)
pause
