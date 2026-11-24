#!/usr/bin/env bash
# Installs the cross-compiled desktop build for the current Windows user (run from WSL):
# copies it to %LOCALAPPDATA%\Programs\Kazetix, adds a Start-menu shortcut and starts it.
# ponytail: no installer yet (later phase); this is all a single-exe Tauri app needs on Windows 11 (WebView2 is built in).
set -euo pipefail
cd "$(dirname "$0")/.."
EXE=${1:-apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/kazetix.exe}
cd /mnt/c
LOCAL=$(cmd.exe /c "echo %LOCALAPPDATA%" | tr -d '\r')
DEST_WIN="$LOCAL\\Programs\\Kazetix"
DEST=$(wslpath "$DEST_WIN")
cd - >/dev/null
taskkill.exe /IM Kazetix.exe /F >/dev/null 2>&1 && sleep 1 || true
mkdir -p "$DEST"
cp "$EXE" "$DEST/Kazetix.exe"
powershell.exe -NoProfile -Command "\$s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"\$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Kazetix.lnk\"); \$s.TargetPath='$DEST_WIN\\Kazetix.exe'; \$s.WorkingDirectory='$DEST_WIN'; \$s.Save()"
powershell.exe -NoProfile -Command "Start-Process '$DEST_WIN\\Kazetix.exe'"
echo "Installed to $DEST_WIN"
