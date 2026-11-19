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

# Show name and password fields instead of a user list at the login window.
sudo defaults write /Library/Preferences/com.apple.loginwindow SHOWFULLNAME -bool true
