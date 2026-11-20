#!/usr/bin/env bash
# Finds an mpv video output that survives on this runner and writes it to the
# runner user's ~/.config/mpv/mpv.conf, where External mpv (which loads the
# user's mpv config) picks it up. Test sessions only: the runner's VM has no
# GPU, and Homebrew mpv's default vo=gpu-next (macvk/MoltenVK on the "Apple
# Paravirtual device") crashes in vkBindImageMemory on the first frame.
# Each candidate plays a generated clip for a few seconds in a real window,
# with a screen capture taken mid-play. The first that exits cleanly wins;
# vo=null (no picture: playback control only) is the last resort.
# Usage: pick-mpv-vo.sh OUT
set -uo pipefail
out="$1"
mkdir -p "$out"
clip="$out/.clip.mp4"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440 \
  -t 8 -c:v libx264 -pix_fmt yuv420p -c:a aac "$clip" || exit 1

candidates=(
  "vo=libmpv"                                      # cocoa-cb, OpenGL
  "vo=gpu gpu-api=opengl"
  "vo=gpu hwdec=no"
  "vo=gpu-next hwdec=no gpu-api=opengl"
  "vo=gpu-next hwdec=no"
  "vo=null"
)
results="$out/vo-candidates.txt"
: > "$results"
chosen=""
index=0
for candidate in "${candidates[@]}"; do
  index=$((index + 1))
  args=()
  for option in $candidate; do args+=("--$option"); done
  log="$out/vo-$index.log"
  mpv --no-config --really-quiet=no --msg-level=all=v --length=5 --audio=no --force-window=yes "${args[@]}" "$clip" > "$log" 2>&1 &
  pid=$!
  sleep 3
  screencapture -x "$out/vo-$index.png" 2>/dev/null
  waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < 20 )); do sleep 1; waited=$((waited + 1)); done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; status="hung"; else wait "$pid"; status="exit $?"; fi
  vo="$(grep -m1 -E '^\[vo/[a-z_-]+\] |VO: \[' "$log" | head -c 160)"
  echo "$index. $candidate: $status ${vo:+($vo)}" | tee -a "$results"
  if [[ -z "$chosen" && "$status" == "exit 0" ]] && grep -q 'VO: \[' "$log"; then chosen="$candidate"; fi
  if [[ -z "$chosen" && "$status" == "exit 0" && "$candidate" == "vo=null" ]]; then chosen="$candidate"; fi
done
rm -f "$clip"
if [[ -z "$chosen" ]]; then
  echo "no mpv video output survived" | tee -a "$results"
  exit 1
fi
mkdir -p "$HOME/.config/mpv"
for option in $chosen; do echo "$option"; done > "$HOME/.config/mpv/mpv.conf"
echo "chosen: $chosen" | tee -a "$results"
