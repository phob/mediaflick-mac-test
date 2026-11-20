#!/usr/bin/env bash
# Starts MediaFlick from each given DMG the ways a user does and checks it stays
# up with a window. For each DMG: copy the app to /Applications, then
#   1. `open` the installed app (Finder / Launchpad / Dock path),
#   2. run the inner binary from a shell (what the operator did in Terminal),
#   3. run the inner binary under lldb and keep the crashing backtrace.
# Each launch must still be running after WAIT seconds and own a window. The
# opened app is then quit with the quit Apple event (the Dock's Quit) and the
# shell-started one with Cmd+Q; each must take MediaFlick's orderly exit (its
# log says "exit requested") and end by itself, the shell one with status 0.
# Crash reports, app logs, stdout/stderr and screenshots land in OUT.
# Runs as the logged-in runner account, which owns the console GUI session.
# Usage: launch-check.sh OUT DMG...
set -uo pipefail
out="$1"; shift
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wait_seconds="${WAIT:-40}"
app_name="MediaFlick Desktop.app"
installed="/Applications/$app_name"
binary="$installed/Contents/MacOS/mediaflick-desktop"
data="$HOME/Library/Application Support/mediaflick-desktop"
reports="$HOME/Library/Logs/DiagnosticReports"
mkdir -p "$out"
summary="$out/summary.txt"
: > "$summary"
failures=0

# Compile once; the interpreter takes seconds per call.
swiftc -O -o "$out/.window-count" "$here/window-count.swift" || exit 1

with_timeout() { perl -e '$t = shift; $SIG{ALRM} = sub { kill "KILL", $pid; exit 124 }; $pid = fork; if (!$pid) { exec @ARGV } alarm $t; waitpid $pid, 0; exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"; }

# The browser process; CEF subprocesses run the same binary with --type=.
main_pid() {
  local pid
  for pid in $(pgrep -x mediaflick-desktop); do
    ps -o args= -p "$pid" | grep -q -- '--type=' || { echo "$pid"; return; }
  done
}

stop_app() {
  pkill -x mediaflick-desktop 2>/dev/null
  sleep 2
  pkill -9 -x mediaflick-desktop 2>/dev/null
  true
}

# Judges a launch whose main process should now be running.
judge() {
  local label="$1" dir="$2" pid windows
  pid="$(main_pid)"
  if [[ -z "$pid" ]]; then
    echo "$label: FAIL - no MediaFlick process after ${wait_seconds}s" | tee -a "$summary"
    failures=$((failures + 1)); return 1
  fi
  windows="$("$out/.window-count" "$pid")"
  screencapture -x "$dir/screen.png" 2>/dev/null
  if (( windows < 1 )); then
    echo "$label: FAIL - pid $pid running but owns no on-screen window" | tee -a "$summary"
    failures=$((failures + 1)); return 1
  fi
  echo "$label: PASS - pid $pid running with $windows window(s) after ${wait_seconds}s" | tee -a "$summary"
}

# Asks the running app to quit (HOW: apple-event or cmd-q) and checks that it
# takes the orderly exit and ends by itself within 30 seconds.
quit_check() {
  local label="$1" how="$2" dir="$3" bundle_id waited=0
  bundle_id="$(defaults read "$installed/Contents/Info" CFBundleIdentifier)"
  case "$how" in
    apple-event)
      with_timeout 30 osascript -e "tell application id \"$bundle_id\" to quit" > "$dir/quit.txt" 2>&1 ;;
    cmd-q)
      with_timeout 30 osascript -e "tell application id \"$bundle_id\" to activate" -e 'delay 2' \
        -e 'tell application "System Events" to keystroke "q" using command down' > "$dir/quit.txt" 2>&1 ;;
  esac
  echo "osascript exit $?" >> "$dir/quit.txt"
  while [[ -n "$(main_pid)" ]] && (( waited < 30 )); do sleep 1; waited=$((waited + 1)); done
  if [[ -n "$(main_pid)" ]]; then
    echo "$label: FAIL - still running 30s after the quit request ($(tr '\n' ' ' < "$dir/quit.txt"))" | tee -a "$summary"
    failures=$((failures + 1)); return 1
  fi
  if ! grep -q 'exit requested' "$data/mediaflick-desktop.log" 2>/dev/null; then
    echo "$label: FAIL - ended after ${waited}s without the orderly exit (no \"exit requested\" in the log)" | tee -a "$summary"
    failures=$((failures + 1)); return 1
  fi
  echo "$label: PASS - orderly exit logged, process ended after ${waited}s" | tee -a "$summary"
}

collect() {
  local dir="$1"
  sleep 8 # ReportCrash writes the .ips a few seconds after the crash.
  mkdir -p "$dir/crash-reports" "$dir/app-data"
  find "$reports" -newer "$dir/.start" \( -name 'mediaflick*' -o -name 'MediaFlick*' -o -name 'Chromium*' \) -exec cp {} "$dir/crash-reports/" \; 2>/dev/null
  [[ -d "$data" ]] && find "$data" -maxdepth 1 -name '*.log' -exec cp {} "$dir/app-data/" \;
  ls "$dir/crash-reports" | sed "s|^|  crash report: |" | tee -a "$summary"
}

for dmg in "$@"; do
  name="$(basename "$dmg" .dmg)"
  echo "== $name" | tee -a "$summary"
  mount_point="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$dmg" >/dev/null
  rm -rf "$installed"
  ditto "$mount_point/$app_name" "$installed"
  hdiutil detach "$mount_point" >/dev/null
  echo "  version: $("$binary" --version 2>&1)" | tee -a "$summary"
  codesign -dv "$installed" 2>&1 | grep -E '^(Signature|TeamIdentifier|Identifier)' | sed 's/^/  /' | tee -a "$summary"
  codesign --verify --deep --strict "$installed" > "$out/.codesign" 2>&1 && echo "  codesign --verify --deep --strict: ok" | tee -a "$summary" \
    || sed 's/^/  codesign: /' "$out/.codesign" | tee -a "$summary"
  xattr -lr "$installed" 2>/dev/null | grep -c quarantine | sed 's/^/  quarantine xattrs: /' | tee -a "$summary"

  # 1. open, as from Finder.
  dir="$out/$name/open"; mkdir -p "$dir"; touch "$dir/.start"
  rm -rf "$data"; stop_app
  open -n "$installed" --stdout "$dir/stdout.txt" --stderr "$dir/stderr.txt"
  sleep "$wait_seconds"
  judge "  open" "$dir" && quit_check "  open, quit by Apple event" apple-event "$dir"
  stop_app; collect "$dir"

  # 2. The inner binary from a shell, as the operator ran it.
  dir="$out/$name/direct"; mkdir -p "$dir"; touch "$dir/.start"
  rm -rf "$data"
  ( cd "$installed/Contents/MacOS" && ./mediaflick-desktop > "$dir/stdout.txt" 2> "$dir/stderr.txt"; echo "exit status $?" > "$dir/exit.txt" ) &
  sleep "$wait_seconds"
  quit_status=1
  judge "  direct" "$dir" && quit_check "  direct, quit by Cmd+Q" cmd-q "$dir" && quit_status=0
  stop_app; wait
  sed 's/^/  /' "$dir/exit.txt" | tee -a "$summary"
  if (( quit_status == 0 )) && [[ "$(cat "$dir/exit.txt")" != "exit status 0" ]]; then
    echo "  direct, quit by Cmd+Q: FAIL - the process did not exit with status 0" | tee -a "$summary"
    failures=$((failures + 1))
  fi
  collect "$dir"

  # 3. Under lldb, for a symbolic backtrace of any crash.
  dir="$out/$name/lldb"; mkdir -p "$dir"; touch "$dir/.start"
  rm -rf "$data"
  with_timeout $((wait_seconds + 60)) lldb --batch \
    -o 'process handle SIGPIPE -n true -p true -s false' \
    -o run \
    -k 'thread backtrace all' -k 'register read' -k 'image list' -k 'disassemble --pc' -k quit \
    -- "$binary" > "$dir/lldb.txt" 2>&1
  echo "  lldb exit: $?" | tee -a "$summary"
  grep -m3 -E 'stop reason|exited with status' "$dir/lldb.txt" | sed 's/^/  lldb: /' | tee -a "$summary"
  stop_app
  collect "$dir"
done

rm -f "$out/.window-count"
echo "failures: $failures" | tee -a "$summary"
(( failures == 0 ))
