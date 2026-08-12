#!/bin/bash
# ===================================================================
#  PC Control Panel - PORTABLE one-click launcher (macOS)
#
#  This is the zero-install version: it does NOT need Python, Homebrew,
#  or anything else pre-installed on this Mac. It builds its own private
#  Python interpreter inside this project folder (./python-portable),
#  then always uses that copy. Nothing is touched outside this folder,
#  nothing installed system-wide, no admin password needed.
#
#  FIRST RUN (needs internet, once):
#    1. Detects this Mac's CPU (Apple Silicon vs Intel) via `uname -m`.
#    2. Downloads the matching prebuilt CPython 3.12 from
#       astral-sh/python-build-standalone (a relocatable, self-contained
#       Python distribution - the macOS equivalent of the Windows
#       "embeddable" zip; there is no python.org equivalent for macOS,
#       this project is the closest thing) into ./python-portable.
#       Roughly 60-80MB depending on architecture.
#    3. Installs Flask + pyserial into that copy from requirements.txt.
#    4. Starts the panel, same as every other launcher in this folder.
#
#  EVERY RUN AFTER THAT is fully offline - step 1-3 are skipped once
#  ./python-portable already has a working interpreter in it.
#
#  OFFLINE-TO-OFFLINE HANDOFF: if the TARGET Mac has no internet at all,
#  run this once on any Mac of the SAME CPU family (Apple Silicon or
#  Intel) that does have internet, then copy the whole project folder
#  (including the now-populated ./python-portable) via USB/AirDrop/etc.
#  to the offline Mac. python-portable is self-contained and does not
#  depend on anything from the machine that built it.
#
#  Ctrl+C in this window stops the server. The gateway and the collar
#  keep running whatever they were doing.
#
#  FIRST RUN ONLY (this file itself): macOS does not preserve the
#  executable bit across a copy/download/git-clone. If double-clicking
#  does nothing, open Terminal, cd into this folder, and run:
#      chmod +x Launch_ControlPanel_Portable.command
#  then double-click again. Gatekeeper will also ask you to confirm
#  opening it once (right-click -> Open) since it isn't signed.
# ===================================================================
set -u
cd "$(dirname "$0")"

PORTABLE_DIR="$(pwd)/python-portable"
PY_RELEASE_TAG="20260807"
PY_VERSION="3.12.13"

pause_and_exit() {
    echo
    read -r -p "Press Enter to close..." _
    exit 1
}

# ---------------------------------------------------------------------
# Step 0: is there already a working interpreter in ./python-portable
# from a previous run? Search rather than assume a hardcoded path, since
# that keeps this script working even if a future python-build-standalone
# release changes its internal folder layout.
# ---------------------------------------------------------------------
find_bundled_python() {
    find "$PORTABLE_DIR" -type f -name 'python3*' -perm -u+x 2>/dev/null \
        | grep -v '\-config' | sort | head -n 1
}

PYBIN="$(find_bundled_python)"

if [ -z "$PYBIN" ]; then
    echo
    echo "  [1/4] No portable Python found yet -- building one now."
    echo "        This step needs internet and only happens once."
    echo

    ARCH="$(uname -m)"
    case "$ARCH" in
        arm64)   PBS_ARCH="aarch64" ;;   # Apple Silicon (M1/M2/M3/M4...)
        x86_64)  PBS_ARCH="x86_64"  ;;   # Intel Mac
        *)
            echo "  [!] Unrecognised CPU architecture: $ARCH"
            echo "      This script only knows arm64 (Apple Silicon) and x86_64 (Intel)."
            pause_and_exit
            ;;
    esac

    ASSET="cpython-${PY_VERSION}+${PY_RELEASE_TAG}-${PBS_ARCH}-apple-darwin-install_only.tar.gz"
    URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE_TAG}/${ASSET}"

    echo "        Detected CPU: $ARCH  ->  fetching $ASSET"
    mkdir -p "$PORTABLE_DIR"
    TARBALL="$(pwd)/${ASSET}"

    if ! curl -fL --progress-bar -o "$TARBALL" "$URL"; then
        echo
        echo "  [!] Download failed. Check this Mac's internet connection and"
        echo "      try again, or download that file yourself from:"
        echo "        $URL"
        echo "      and extract it into: $PORTABLE_DIR"
        rm -f "$TARBALL"
        pause_and_exit
    fi

    echo
    echo "  [2/4] Extracting ..."
    if ! tar -xzf "$TARBALL" -C "$PORTABLE_DIR"; then
        echo "  [!] Extraction failed - the download may be corrupt. Delete"
        echo "      $TARBALL and ./python-portable, then run this again."
        pause_and_exit
    fi
    rm -f "$TARBALL"

    PYBIN="$(find_bundled_python)"
    if [ -z "$PYBIN" ]; then
        echo "  [!] Extracted the archive but couldn't find a python3 binary"
        echo "      inside $PORTABLE_DIR - the release layout may have"
        echo "      changed. Have a look inside that folder by hand."
        pause_and_exit
    fi
    chmod +x "$PYBIN"

    echo
    echo "  [3/4] Installing Flask + pyserial into the portable interpreter ..."
    if ! "$PYBIN" -m pip --version >/dev/null 2>&1; then
        "$PYBIN" -m ensurepip --upgrade >/dev/null 2>&1
    fi
    "$PYBIN" -m pip install --upgrade pip >/dev/null 2>&1
    if ! "$PYBIN" -m pip install -r "$(pwd)/requirements.txt"; then
        echo
        echo "  [!] Dependency install failed -- see the pip errors above."
        pause_and_exit
    fi
else
    echo
    echo "  [1/4] Portable Python found -- fully offline from here."
fi

echo
echo "  [4/4] Starting the control panel ..."
echo "        Your browser should open at http://127.0.0.1:5000/"
echo "        If it does not, open that address yourself."
echo
"$PYBIN" "$(pwd)/backend/app.py"

echo
read -r -p "Press Enter to close..." _
