#!/usr/bin/env bash
# Creates the admin account the operator logs into over Screen Sharing.
# Needs MAC_PASSWORD in the environment.
set -euo pipefail
: "${MAC_PASSWORD:?MAC_PASSWORD is not set}"
user=tester

sudo sysadminctl -addUser "$user" -fullName "MediaFlick Tester" -password "$MAC_PASSWORD" -admin 2>&1 \
  | grep -v -e 'No clear text password' -e 'SecureToken' || true
sudo createhomedir -c -u "$user" >/dev/null
dscl . -authonly "$user" "$MAC_PASSWORD"

# Skip the first-login setup assistant the way the runner image skips it for
# its own account.
sudo cp ~/Library/Preferences/com.apple.SetupAssistant.plist "/Users/$user/Library/Preferences/"
sudo chown "$user:staff" "/Users/$user/Library/Preferences/com.apple.SetupAssistant.plist"

# Show name and password fields instead of a user list at the login window.
sudo defaults write /Library/Preferences/com.apple.loginwindow SHOWFULLNAME -bool true
