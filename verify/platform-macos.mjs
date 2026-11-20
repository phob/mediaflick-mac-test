// macOS stand-in for MediaFlick-Desktop's
// .claude/skills/verify-mediaflick/scripts/platform.mjs, which supports only
// Windows and Linux. The e2e workflow copies it over that file in a throwaway
// checkout on a GitHub-hosted macOS runner; it is never committed there.
//
// The runner is a disposable VM whose console session the job owns, so there
// is no user to hide the app from and no real profile to protect. The app
// runs as a user's would: the runner's own HOME (~/Library/Application
// Support/mediaflick-desktop, fresh on every runner) and login keychain.
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const root = path.resolve(import.meta.dirname, "../../../..")
export const isWindows = false
export const isLinux = false

export const buildDir = path.join(root, "build")
if (!process.env.MEDIAFLICK_DESKTOP_EXE) throw new Error("set MEDIAFLICK_DESKTOP_EXE to the installed app's Contents/MacOS/mediaflick-desktop")
export const exe = path.resolve(process.env.MEDIAFLICK_DESKTOP_EXE)

export const PROFILE_PREFIX = "mediaflick-verify-"
export const profileParent = os.tmpdir()

const appSupport = path.join(os.homedir(), "Library", "Application Support")

// The guard fingerprints the user's real profile files; a CI runner has none,
// and the app's profile below is the runner's own, so point the guard at a
// path that never exists.
export function realProfileDirs() {
  const none = path.join(profileParent, "no-user-profile-on-a-ci-runner")
  return { config: none, data: none }
}

export function appEnvironment(_profile) {
  const env = { ...process.env }
  for (const name of ["MEDIAFLICK_DESKTOP_REMOTE_DEBUGGING_PORT", "MEDIAFLICK_DESKTOP_LOG_FILE", "MEDIAFLICK_DESKTOP_LOG_LEVEL", "JELLYFIN_URL"]) delete env[name]
  // mpv's IPC socket goes to TMPDIR, and a macOS Unix socket path may not
  // exceed 104 bytes; the default /var/folders/... TMPDIR leaves too little.
  env.TMPDIR = mkdtempSync("/tmp/mfv-")
  const dir = path.join(appSupport, "mediaflick-desktop")
  return { env, dirs: [appSupport], configDir: dir, dataDir: dir }
}

export function assertIsolated() {
  if (process.env.MEDIAFLICK_VERIFY_ISOLATION !== "macos-ci-runner" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("platform-macos.mjs runs only on a disposable GitHub Actions macOS runner (MEDIAFLICK_VERIFY_ISOLATION=macos-ci-runner)")
  }
  return { kind: "macos-ci-runner", runner: process.env.RUNNER_NAME ?? null, home: os.homedir() }
}

export function listProcesses() {
  // Two passes: comm (the executable's full path, which may hold spaces) and
  // args, joined by PID.
  const read = (field) => execFileSync("ps", ["-axww", "-o", `pid=,ppid=,${field}=`], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n").map((line) => line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/)).filter(Boolean)
  const args = new Map(read("args").map(([, pid, , cmd]) => [Number(pid), cmd.trim()]))
  return read("comm").map(([, pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), name: path.basename(comm.trim()), cmd: args.get(Number(pid)) ?? "" }))
}

// Only Windows' doctor uses it.
export const pwshPath = null

export function sendWindowClose() {
  throw new Error("wmClose is implemented for Linux only")
}

// Counts the app's normal on-screen windows with the window-count helper the
// workflow compiles (CoreGraphics window list; owner PIDs need no permission).
export function mainWindowShown(pid) {
  const tool = process.env.MEDIAFLICK_VERIFY_WINDOW_COUNT
  if (!tool) throw new Error("MEDIAFLICK_VERIFY_WINDOW_COUNT is not set")
  return Number(execFileSync(tool, [String(pid)], { encoding: "utf8" }).trim()) > 0
}

export const isAppProcess = (row) => /^(mediaflick-desktop|MediaFlick Desktop Helper.*)$/.test(row.name)

export function killPids(pids, { tree = false } = {}) {
  const targets = [...pids]
  if (tree) {
    const rows = listProcesses()
    for (let index = 0; index < targets.length; index++) {
      for (const row of rows) if (row.ppid === targets[index] && !targets.includes(row.pid)) targets.push(row.pid)
    }
  }
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
    }
  }
}
