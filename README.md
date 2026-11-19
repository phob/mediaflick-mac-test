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
(`/opt/homebrew/bin/mpv`), where MediaFlick finds it for playback.

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

- No GPU acceleration: the Mac is a virtual machine, so video plays through
  software rendering and may stutter.
- No audio over Screen Sharing.
- The screen is small (1024×768 is typical) and the session lasts 6 hours at most.
- The repository, its workflow logs and its artifacts are public. A real
  session uploads nothing; only the self-test uploads screenshots.
- Each run starts from a clean Mac; nothing carries over between sessions.

## Self-test

Running the workflow with `self_test` on needs no secrets. It builds and
places both DMGs, starts each app with `--version`, signs in to Screen Sharing
as `tester` with a throwaway password from the runner itself, checks that the
desktop is visible and reacts to the mouse and the keyboard, uploads the
screenshots as the `self-test-screenshots` artifact, and ends without
connecting to Tailscale.
