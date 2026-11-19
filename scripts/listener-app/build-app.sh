#!/bin/bash
# Builds "Aside Listener.app" (a small launcher that toggles scripts/aside-listener.sh) and a `listener`
# command. No Xcode needed. Usage: scripts/listener-app/build-app.sh [destination-folder]  (default /Applications)
set -euo pipefail
REAL_HOME="$(eval echo "~$(id -un)")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST="${1:-/Applications}"
APP="$DEST/Aside Listener.app"
WORK="$(mktemp -d)"

# Icon: SVG -> 1024 PNG -> iconset -> icns
qlmanage -t -s 1024 -o "$WORK" "$HERE/icon.svg" >/dev/null 2>&1
PNG="$WORK/icon.svg.png"
[ -s "$PNG" ] || { echo "icon render failed"; exit 1; }
SET="$WORK/AsideListener.iconset"; mkdir -p "$SET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$PNG" --out "$SET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size*2)) $((size*2)) "$PNG" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$WORK/AsideListener.icns"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/AsideListener.icns" "$APP/Contents/Resources/AsideListener.icns"

cat > "$APP/Contents/MacOS/AsideListener" <<LAUNCHER
#!/bin/bash
# Clicking the icon toggles the listener: on if it was off, off if it was on.
exec "$REPO/scripts/aside-listener.sh" toggle
LAUNCHER
chmod +x "$APP/Contents/MacOS/AsideListener"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Aside Listener</string>
  <key>CFBundleDisplayName</key><string>Aside Listener</string>
  <key>CFBundleIdentifier</key><string>local.aside-relay.listener</string>
  <key>CFBundleExecutable</key><string>AsideListener</string>
  <key>CFBundleIconFile</key><string>AsideListener</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"

# `listener` shortcut for the terminal
mkdir -p "$REAL_HOME/.local/bin"
ln -sf "$REPO/scripts/aside-listener.sh" "$REAL_HOME/.local/bin/listener"
rm -rf "$WORK"
echo "Built: $APP"
echo "Terminal shortcut: listener [toggle|start|stop|status|log]"
