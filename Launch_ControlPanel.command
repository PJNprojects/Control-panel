#!/bin/bash
# ===================================================================
#  PC Control Panel - one-click launcher (macOS)
#
#  Double-click this file in Finder. It will, in order:
#    1. find Python 3 (or bootstrap it via Homebrew if missing)
#    2. create a private virtual environment in ./venv if one is not
#       there yet -- so this tool's Flask/pyserial versions can never
#       collide with anything else installed on this Mac
#    3. install requirements.txt into that venv, but only when the
#       dependencies are actually missing, so a normal start-up costs
#       no network round trip
#    4. start backend/app.py, which serves the page AND opens your
#       browser at http://127.0.0.1:5000/ by itself
#
#  The panel does NOT need the gateway plugged in to start. Open the
#  page first, plug the board in, press Refresh, then Connect.
#
#  Ctrl+C in this window stops the server. The gateway and the collar
#  keep running whatever they were doing -- closing this panel is not
#  a SLEEP command and does not stop a scan loop.
#
#  FIRST RUN ONLY: macOS does not mark downloaded/copied scripts as
#  executable by default. If double-clicking this does nothing (or
#  Finder offers to open it in a text editor), open Terminal, cd into
#  this folder, and run:  chmod +x Launch_ControlPanel.command
#  then double-click it again.
#
#  Also on first run, Gatekeeper may warn "unidentified developer" --
#  right-click the file, choose Open, and confirm once. That exception
#  is remembered after that.
# ===================================================================
set -u
cd "$(dirname "$0")"

pause_and_exit() {
    echo
    read -r -p "Press Enter to close..." _
    exit 1
}

PY=""
if command -v python3 >/dev/null 2>&1; then
    PY="python3"
fi

if [ -z "$PY" ]; then
    echo
    echo "  [!] Python 3 was not found on this Mac."
    if command -v brew >/dev/null 2>&1; then
        echo "      Homebrew is installed - installing Python 3 now"
        echo "      (needs internet, one-time only) ..."
        brew install python3
        if command -v python3 >/dev/null 2>&1; then
            PY="python3"
        fi
    fi
fi

if [ -z "$PY" ]; then
    echo
    echo "  [!] Could not find or install Python 3 automatically."
    echo "      Install it yourself, either:"
    echo "        - Homebrew (recommended):"
    echo "            /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    echo "            then:  brew install python3"
    echo "        - or the official installer:"
    echo "            https://www.python.org/downloads/macos/"
    echo "      then re-run this file."
    pause_and_exit
fi

VENV_PY="$(pwd)/venv/bin/python3"

# A venv's bin/python3 is a small stub pinned to the exact base interpreter
# path it was created against -- it is NOT portable across machines. If this
# whole project folder was copied (not freshly set up) from another Mac, that
# stub can still exist and be executable as a file yet fail to actually run,
# because the base interpreter it points at isn't at that path on THIS Mac.
# Checking existence alone let that slip through as "found"; checking that it
# actually runs catches it and rebuilds instead of limping along on a dead venv.
VENV_OK=0
if [ -x "$VENV_PY" ] && "$VENV_PY" -c "import sys" >/dev/null 2>&1; then
    VENV_OK=1
fi

if [ "$VENV_OK" -eq 0 ]; then
    if [ -d "$(pwd)/venv" ]; then
        echo
        echo "  [1/3] ./venv exists but doesn't run -- likely copied from another"
        echo "        machine. Removing it and creating a fresh one ..."
        rm -rf "$(pwd)/venv"
    else
        echo
        echo "  [1/3] No virtual environment yet -- creating ./venv ..."
    fi
    "$PY" -m venv "$(pwd)/venv"
    if [ ! -x "$VENV_PY" ]; then
        echo
        echo "  [!] Could not create the virtual environment in ./venv"
        echo "      Try:  $PY -m pip install --upgrade virtualenv"
        echo "      Or run the panel without a venv:"
        echo "          pip3 install -r requirements.txt"
        echo "          python3 backend/app.py"
        pause_and_exit
    fi
else
    echo
    echo "  [1/3] Virtual environment found and working."
fi

echo
echo "  [2/3] Checking dependencies -- Flask, pyserial ..."
if ! "$VENV_PY" -c "import flask, serial" >/dev/null 2>&1; then
    echo "        Installing from requirements.txt -- this needs internet"
    echo "        the first time only ..."
    "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1
    if ! "$VENV_PY" -m pip install -r "$(pwd)/requirements.txt"; then
        echo
        echo "  [!] Dependency install failed -- see the pip errors above."
        echo "      Most common cause is no internet on this machine. You can"
        echo "      copy a working venv folder over from another Mac instead."
        pause_and_exit
    fi
else
    echo "        Already installed."
fi

echo
echo "  [3/3] Starting the control panel ..."
echo "        Your browser should open at http://127.0.0.1:5000/"
echo "        If it does not, open that address yourself."
echo
"$VENV_PY" "$(pwd)/backend/app.py"

echo
read -r -p "Press Enter to close..." _
