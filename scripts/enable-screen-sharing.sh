#!/usr/bin/env bash
# Turns on macOS Screen Sharing for the tester account only, with Apple's
# username-and-password authentication (no 8-character VNC password), and
# accepts connections only from loopback and the Tailscale network.
set -euo pipefail

# Since macOS 12.1 kickstart cannot grant Screen Recording, so the agent could
# serve a black screen. The runner image has SIP disabled, so pre-approve the
# Screen Sharing agent in the system TCC database instead.
tcc_db="/Library/Application Support/com.apple.TCC/TCC.db"
now="$(date +%s)"
for service in kTCCServiceScreenCapture kTCCServicePostEvent kTCCServiceAccessibility; do
  sudo sqlite3 "$tcc_db" "INSERT OR REPLACE INTO access
    (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags, last_modified)
    VALUES ('$service', 'com.apple.screensharing.agent', 0, 2, 4, 1, 'UNUSED', 0, $now);"
done

# Accept only loopback and Tailscale (100.64.0.0/10) on the Screen Sharing and
# Remote Management ports, whatever other interfaces the runner has.
{
  cat /etc/pf.conf
  echo 'pass in quick on lo0 all'
  echo 'pass in quick proto tcp from 100.64.0.0/10 to any port { 5900, 3283 }'
  echo 'block drop in quick proto { tcp, udp } from any to any port { 5900, 3283 }'
} | sudo pfctl -q -f - 2>/dev/null
sudo pfctl -q -E 2>/dev/null || true

kickstart=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart
sudo "$kickstart" -activate -configure -allowAccessFor -specifiedUsers >/dev/null
sudo "$kickstart" -configure -users tester -access -on -privs -all >/dev/null
sudo "$kickstart" -configure -clientopts -setvnclegacy -vnclegacy no >/dev/null
sudo "$kickstart" -restart -agent -menu >/dev/null

for _ in $(seq 1 30); do
  if nc -z 127.0.0.1 5900 2>/dev/null; then
    echo "Screen Sharing is listening on port 5900."
    exit 0
  fi
  sleep 2
done
echo "Screen Sharing did not start listening on port 5900." >&2
exit 1
