#!/bin/zsh
# Release 1.1.1 #43: installs the weekly live database backup on Danny's Mac.
# Run once from the repo:  zsh scripts/install-backup.sh
# Needs: brew install libpq, and the keychain item mojialand-live-db (see
# Mojialand-Services.md, Database backup). The first run shows one macOS
# prompt: "Mojialand Backup" would like to access iCloud Drive. Click Allow.
#
# Why an app: macOS blocks background jobs from reading the Desktop folder and
# from writing to iCloud Drive. A small signed app holds that one permission.
setopt ERR_EXIT
REPO=${0:A:h:h}
SUP="$HOME/Library/Application Support/Mojialand"
APP="$HOME/Applications/Mojialand Backup.app"
PLIST="$HOME/Library/LaunchAgents/com.mojialand.backup.plist"

mkdir -p "$SUP" "$HOME/Applications" "$HOME/Library/LaunchAgents"
cp "$REPO/scripts/backup-live.sh" "$SUP/backup-live.sh"; chmod 700 "$SUP/backup-live.sh"
rm -rf "$APP"
osacompile -o "$APP" \
  -e 'set s to POSIX path of (path to library folder from user domain) & "Application Support/Mojialand/backup-live.sh"' \
  -e 'do shell script "/bin/zsh " & quoted form of s'
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.mojialand.backup-app" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.mojialand.backup-app" "$APP/Contents/Info.plist"
codesign --force --deep -s - "$APP"
sed "s#__APP__#$APP#" "$REPO/scripts/com.mojialand.backup.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.mojialand.backup" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/com.mojialand.backup"
print "Installed. Click Allow if macOS asks about iCloud Drive. Check backup-log.txt in the Backups folder."
