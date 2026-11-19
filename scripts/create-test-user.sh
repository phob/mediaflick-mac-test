#!/usr/bin/env bash
# Creates the admin account "tester" that the operator signs in as over Screen
# Sharing, and puts the given files on its desktop. The runner's own account has
# a password nobody knows, and a fresh account also gets a fresh login keychain.
# Needs MAC_PASSWORD in the environment. Usage: create-test-user.sh FILE...
set -euo pipefail
: "${MAC_PASSWORD:?MAC_PASSWORD is not set}"
user=tester

sudo sysadminctl -addUser "$user" -fullName "MediaFlick Tester" -password "$MAC_PASSWORD" -admin 2>/dev/null
sudo createhomedir -c -u "$user" >/dev/null
dscl . -authonly "$user" "$MAC_PASSWORD"

# Skip the first-login setup assistant (Apple Account, Siri, Screen Time...).
prefs="/Users/$user/Library/Preferences/com.apple.SetupAssistant.plist"
for key in DidSeeAccessibility DidSeeActivationLock DidSeeApplePaySetup DidSeeAppearanceSetup \
  DidSeeCloudSetup DidSeeiCloudLoginForStorageServices DidSeeIntelligence DidSeeLockdownMode \
  DidSeePrivacy DidSeeScreenTime DidSeeSiriSetup DidSeeSyncSetup DidSeeSyncSetup2 \
  DidSeeTermsOfAddress DidSeeTouchIDSetup DidSeeTrueTonePrivacy DidSeeWallpaperSetup; do
  sudo defaults write "$prefs" "$key" -bool true
done
sudo defaults write "$prefs" LastSeenCloudProductVersion "$(sw_vers -productVersion)"
sudo defaults write "$prefs" LastSeenBuddyBuildVersion "$(sw_vers -buildVersion)"
sudo defaults write "$prefs" LastPrivacyBundleVersion -string 9999
sudo chown "$user:staff" "$prefs"

desktop="/Users/$user/Desktop"
sudo mkdir -p "$desktop"
for file in "$@"; do
  sudo cp "$file" "$desktop/"
done
sudo chown -R "$user:staff" "$desktop"
sudo ls -l "$desktop"
