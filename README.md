# MediaFlick macOS test machine

A throwaway Mac for checking [MediaFlick Desktop](https://github.com/phob/MediaFlick-Desktop)
by hand, without owning one. One manually started workflow builds MediaFlick
for macOS from source on a GitHub-hosted Apple Silicon runner (`macos-15`),
then opens a second macOS runner with that build and a released version on its
desktop, and lets you control it over Screen Sharing (VNC) for up to 6 hours.

Nothing runs automatically: both apps sit on the desktop as DMGs for you to
install and open.

## One-time setup

Add two repository secrets (Settings → Secrets and variables → Actions, or
`gh secret set NAME -R phob/mediaflick-mac-test`, which prompts for the value):

| Secret | Value |
| --- | --- |
| `MAC_PASSWORD` | A password of at least 16 characters, on one line. It becomes the password of the Mac's `tester` account, which you sign in to Screen Sharing with. |
| `TS_AUTHKEY` | A Tailscale auth key from your tailnet (admin console → Settings → Keys → Generate auth key). Make it **Reusable** and **Ephemeral**, so each session joins your tailnet and is removed again when it goes offline. Keys expire after at most 90 days; generate a new one then. |

Your own computer needs [Tailscale](https://tailscale.com/download) signed in
to the same tailnet, and a VNC viewer that supports Apple's username and
password authentication: **Remmina** (Linux) or **RealVNC Viewer** (Windows,
Linux, macOS). TigerVNC and TightVNC only speak the 8-character VNC password,
which this Mac does not accept.

## Start a session

1. Actions → **macOS test session** → **Run workflow**.
2. Inputs:
   - `ref`: the MediaFlick Desktop branch, tag or commit to build (default `main`).
   - `release`: the released version to put beside it (default `v0.2.0`).
   - `hours`: how long to keep the desktop open, 1 to 6.
   - `self_test`: leave off. It is for checking this workflow itself.
3. Wait for the **Build** job (about 20 to 40 minutes; less when its cache is
   warm) and the setup steps of the **macOS desktop** job. The session is ready
   when the step **Keep the desktop open** starts; it prints the machine's
   Tailscale name, `mediaflick-mac-<run id>`, and when the session ends.

## Connect

In your VNC viewer, connect to `mediaflick-mac-<run id>` (or the `100.x.y.z`
address the step prints, or the one the Tailscale admin console lists) on the
default port 5900. Sign in as user **`tester`** with your `MAC_PASSWORD`.

The machine is reachable only through your tailnet: the runner has no public
inbound address, Screen Sharing accepts only Tailscale and loopback addresses,
and it accepts only the `tester` account's password. The logs are public, so
they never show the password or the auth key.

## What is on the desktop

- `MediaFlickDesktop-v0.2.0-macos-arm64.dmg`: the released version from GitHub Releases.
- `MediaFlickDesktop-<ref>@<commit>-macos-arm64.dmg`: the build of `ref`, made by
  the same steps as the release workflow (ad-hoc signed, like the releases).

Open a DMG and drag the app to Applications, as a user would. To test an
update, install the release first, use it, then drag the newer build over it
in Applications and choose Replace. `mpv` is installed through Homebrew
(`/opt/homebrew/bin/mpv`), where MediaFlick finds it for playback, but with
its default settings it crashes on this Mac's virtual GPU (see Limits). Before
playing anything, give `tester` a working video output:

```sh
mkdir -p ~/.config/mpv && echo vo=libmpv > ~/.config/mpv/mpv.conf
```

`tester` is a fresh admin account with its own login keychain, so it behaves
like a new user on a new Mac.

## Stop a session

The session ends by itself after the chosen hours (at the latest 5 h 50 min
after the desktop job started; GitHub stops any job at 6 hours). To end it
sooner, cancel the run: the run page's **Cancel workflow** button, or
`gh run cancel <run id> -R phob/mediaflick-mac-test`. Everything on the Mac is
deleted with the runner, and the ephemeral Tailscale node disappears from your
tailnet shortly after.

Logging out of `tester` is harmless: connect again and a new session starts.
Restarting or shutting down the Mac ends the session for good.

## Limits

- No GPU acceleration: the Mac is a virtual machine with an "Apple
  Paravirtual device" GPU. Homebrew mpv's default output (`vo=gpu-next`, Vulkan
  through MoltenVK) crashes with a segmentation fault on the first video frame,
  and so does `vo=gpu`; `gpu-api=opengl` is refused. `vo=libmpv` (cocoa-cb,
  OpenGL) shows the picture, decoded in software (`hwdec=no`). None of this
  says anything about a real Mac's GPU.
- No audio over Screen Sharing.
- The screen is small (1024×768 is typical) and the session lasts 6 hours at most.
- The repository, its workflow logs and its artifacts are public. A real
  session uploads nothing; only the self-test and the end-to-end workflow
  upload evidence.
- Each run starts from a clean Mac; nothing carries over between sessions.

## Self-test

Running the workflow with `self_test` on needs no secrets. It builds and
places both DMGs, then installs each app to `/Applications` and launches it
the ways a user does (`scripts/launch-check.sh`):

1. with `open`;
2. as the inner binary from a shell;
3. with an `accounts.json` from a newer release, so the startup error screen
   shows;
4. under lldb, for a backtrace if it crashes.

Each launch must stay up with a window for 40 s. The opened app is then quit
with the quit Apple event; the shell launch and the error screen are quit with
Cmd+Q. Each must take MediaFlick's orderly exit (`exit requested` in its log)
and end by itself. Crash reports, logs, lldb output and screenshots go to the
`launch-check` artifact. A failed launch fails the run at its end; the v0.2.0
release always does, because every macOS release up to 0.2.0 crashes at
startup.

The self-test then signs in to Screen Sharing
as `tester` with a throwaway password from the runner itself, checks that the
desktop is visible and reacts to the mouse and the keyboard, uploads the
screenshots as the `self-test-screenshots` artifact, and ends without
connecting to Tailscale.

`build_run_id` reuses the DMG an earlier run of this workflow built (its run
id) instead of building `ref` again, which saves 20 to 40 minutes.

## End to end

The **macOS end to end** workflow (`mac-e2e.yml`) drives a build against
Jellyfin's public demo server as user `demo`. Its `build_run_id` input names a
**macOS test session** run whose DMG to test; its `ref` input picks the
MediaFlick Desktop ref whose verify harness to use. It uses that harness
(`.claude/skills/verify-mediaflick`), with `verify/platform-macos.mjs` in
place of its Windows and Linux platform layer. It runs the drive
`verify/mac-e2e.mjs`:

- sign-in, Home, the Movies library, and a movie and a series page;
- a movie and an episode with External mpv. For each: Play, the player bar,
  pause and resume, seeking past Jellyfin's resume minimum, Stop from the
  bar's menu, the Stopped report Jellyfin accepted (204), and Resume offered
  on the title's page;
- a real Cmd+Q, which must exit with status 0 through the orderly exit.

`scripts/pick-mpv-vo.sh` first tries mpv video outputs on the VM and writes
the first that survives to the runner's `~/.config/mpv/mpv.conf`. Every step's
result is in `mac-e2e.json`; the `mac-e2e` artifact also holds screenshots,
full-screen captures, the app log and the VO probe's logs. Playback writes the
shared demo user's playstate (resume points).

