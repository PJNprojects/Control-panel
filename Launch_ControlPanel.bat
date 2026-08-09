@echo off
REM ===================================================================
REM  PC Control Panel - one-click launcher (Windows)
REM
REM  Double-click this file. It will, in order:
REM    1. find Python 3 on your PATH
REM    2. create a private virtual environment in .\venv\ if one is
REM       not there yet -- so this tool's Flask/pyserial versions can
REM       never collide with PlatformIO's, or anything else you have
REM       installed globally
REM    3. install requirements.txt into that venv, but only when the
REM       dependencies are actually missing, so a normal start-up
REM       costs no network round trip
REM    4. start backend\app.py, which serves the page AND opens your
REM       browser at http://127.0.0.1:5000/ by itself
REM
REM  The panel does NOT need the gateway plugged in to start. Open the
REM  page first, plug the board in, press Refresh, then Connect.
REM
REM  Ctrl+C in this window stops the server. The gateway and the collar
REM  keep running whatever they were doing -- closing this panel is not
REM  a SLEEP command and does not stop a scan loop.
REM
REM  NOTE ON BATCH SYNTAX: there are no raw parentheses inside any
REM  "if ( ... )" block below. cmd.exe parses a whole block before
REM  running it and an unescaped paren in a comment or echo kills the
REM  script before it reaches "pause" -- exactly the bug that hit
REM  ESP Gateway\launch.bat. Phrasing uses "--" instead.
REM ===================================================================
setlocal
cd /d "%~dp0"
title Collar PC Control Panel

set PY=
where python >nul 2>nul
if %errorlevel%==0 set PY=python
if not defined PY (
    where py >nul 2>nul
    if %errorlevel%==0 set PY=py
)

if not defined PY (
    echo.
    echo  [!] Python 3 was not found on your PATH.
    echo      Install it from https://www.python.org/downloads/
    echo      -- tick "Add python.exe to PATH" in the installer -- then
    echo      re-run this file.
    echo.
    goto done
)

set VENV_PY=%~dp0venv\Scripts\python.exe

if not exist "%VENV_PY%" (
    echo.
    echo  [1/3] No virtual environment yet -- creating .\venv ...
    %PY% -m venv "%~dp0venv"
    if errorlevel 1 goto venvfail
) else (
    echo.
    echo  [1/3] Virtual environment found.
)

if not exist "%VENV_PY%" goto venvfail

echo.
echo  [2/3] Checking dependencies -- Flask, pyserial ...
"%VENV_PY%" -c "import flask, serial" >nul 2>nul
if errorlevel 1 (
    echo        Installing from requirements.txt -- this needs internet
    echo        the first time only ...
    "%VENV_PY%" -m pip install --upgrade pip >nul 2>nul
    "%VENV_PY%" -m pip install -r "%~dp0requirements.txt"
    if errorlevel 1 goto pipfail
) else (
    echo        Already installed.
)

echo.
echo  [3/3] Starting the control panel ...
echo        Your browser should open at http://127.0.0.1:5000/
echo        If it does not, open that address yourself.
echo.
"%VENV_PY%" "%~dp0backend\app.py"
goto done

:venvfail
echo.
echo  [!] Could not create the virtual environment in .\venv
echo      On some locked-down Windows installs the venv module is
echo      missing -- try:  %PY% -m pip install virtualenv
echo      Or run the panel without a venv:
echo          pip install -r requirements.txt
echo          python backend\app.py
echo.
goto done

:pipfail
echo.
echo  [!] Dependency install failed -- see the pip errors above.
echo      Most common cause is no internet on this machine. You can
echo      copy a working venv folder over from another PC instead.
echo.
goto done

:done
echo.
pause
