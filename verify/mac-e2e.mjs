// Basic end to end of MediaFlick on a macOS runner against Jellyfin's public
// demo server, as user `demo`, with the default macOS backend (external mpv
// from Homebrew). Each step is recorded pass/fail in mac-e2e.json, with
// screenshots; a failed step does not stop the independent ones after it.
// Run by .github/workflows/mac-e2e.yml through MediaFlick-Desktop's
// verify-mediaflick session with verify/platform-macos.mjs.
//
// Playback writes the shared demo user's playstate: a title that started
// unplayed is marked watched and unwatched afterwards, which clears the
// resume point this drive left.
import { execFileSync } from "node:child_process"
import path from "node:path"

const MOVIE = "Night of the Living Dead"
const SERIES = "Pioneer One"
const CARD = { css: 'a[aria-label^="Open details for"]' }
// The docked player bar; the title page behind it can carry a Resume of its own.
const BAR = (label) => ({ css: `footer.player-bar button[aria-label="${label}"]` })
const MIN_RESUME = 0.08 // Jellyfin stores no resume point below 5 % of the runtime

const results = []

async function record(ctx, name, run) {
  const started = Date.now()
  ctx.step(`== ${name}`)
  try {
    const detail = (await run()) ?? null
    results.push({ step: name, passed: true, ms: Date.now() - started, detail })
    ctx.step(`== ${name}: PASS`)
    return detail
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ step: name, passed: false, ms: Date.now() - started, error: message })
    ctx.step(`== ${name}: FAIL ${message}`)
    await ctx.screenshot(`fail-${name}`).catch(() => {})
    screen(ctx, `fail-${name}-screen`)
    return null
  }
}

// The whole screen, mpv's own window included, which CDP screenshots lack.
function screen(ctx, name) {
  try {
    execFileSync("screencapture", ["-x", path.join(ctx.evidence, `${name}.png`)])
    ctx.step(`screen capture ${name}.png`)
  } catch (error) {
    ctx.step(`screen capture ${name} failed: ${error.message}`)
  }
}

// A real-mouse click through CDP whose events may go unacknowledged: on this
// runner, opening the player bar's overflow menu left CEF's answer to the
// click pending forever (run 44646986594), although the menu opened and the
// app kept running. Each event gets 5 s; a missing answer is recorded, and the
// caller checks the click's effect itself.
const lostAcks = []
async function click(ctx, target) {
  const { rect } = await ctx.find(target, { timeout: 15000 })
  ctx.step(`click ${JSON.stringify(target)} at (${Math.round(rect.x)},${Math.round(rect.y)})`)
  for (const params of [{ type: "mouseMoved", button: "none" }, { type: "mousePressed", button: "left", clickCount: 1 }, { type: "mouseReleased", button: "left", clickCount: 1 }]) {
    const answered = await Promise.race([ctx.app.send("Input.dispatchMouseEvent", { x: rect.x, y: rect.y, ...params }).then(() => true), ctx.sleep(5000).then(() => false)])
    if (!answered) {
      lostAcks.push({ target, event: params.type })
      ctx.step(`no CDP answer to ${params.type} within 5 s`)
    }
  }
}

async function search(ctx, term, title) {
  await ctx.park()
  if ((await ctx.pathname()) !== "/") await ctx.hover({ css: '[data-sidebar="sidebar"]' })
  await ctx.fill({ role: "textbox", name: "Search the library" }, term)
  await ctx.until(async () => (await ctx.pathname()).startsWith("/library?search="), "the search route")
  await ctx.press({ role: "link", name: `Open details for ${title}` }, { timeout: 30000, nth: 0 })
  await ctx.until(async () => (await ctx.pathname()).startsWith("/item/"), `the ${title} page`)
}

const playButton = async (ctx) => {
  for (const name of ["Play", "From start", "Resume"]) {
    if (await ctx.exists({ role: "button", name })) return name
  }
  return null
}

async function playTitle(ctx, label, open) {
  const report = { title: label }
  await open()
  const detailPath = await ctx.pathname()
  const initial = await ctx.until(() => playButton(ctx), "a Play, From start or Resume button", 30000)
  report.initialButton = initial
  report.startedUnplayed = initial === "Play" && (await ctx.exists({ role: "button", name: "Mark watched" }))
  const press = initial === "Resume" && (await ctx.exists({ role: "button", name: "From start" })) ? "From start" : initial
  await ctx.screenshot(`${label}-01-detail`)

  let marker = ctx.appLog().length
  await ctx.press({ role: "button", name: press })
  const first = await ctx.until(async () => {
    const state = await ctx.player()
    return state?.active && state.positionMs > 2000 ? state : null
  }, "playback running", 120000)
  report.itemId = first.itemId
  report.durationMs = first.durationMs
  report.playMethod = first.playMethod
  report.start = ctx.appLog().slice(marker).match(/starting playback item_id=\S+ .*/)?.[0] ?? null

  // The player bar appears with playback.
  await ctx.find(BAR("Pause"), { timeout: 15000 })
  await ctx.find(BAR("Stop")).catch(async () => ctx.find(BAR("More playback controls")))
  report.barShownWhilePlaying = true
  const t1 = await ctx.mpv("time-pos")
  await ctx.sleep(3000)
  const t2 = await ctx.mpv("time-pos")
  ctx.check(t2 > t1 + 1, `mpv's position advances (${t1.toFixed(1)} → ${t2.toFixed(1)} s)`)
  report.mpv = { vo: await ctx.mpv("current-vo").catch((e) => `error: ${e.message}`), hwdec: await ctx.mpv("hwdec-current").catch(() => null), timePos: [t1, t2] }
  await ctx.screenshot(`${label}-02-playing`)
  screen(ctx, `${label}-02-playing-screen`)

  // Pause and resume from the bar.
  await ctx.press(BAR("Pause"))
  await ctx.until(async () => (await ctx.player()).paused === true && (await ctx.mpv("pause")) === true, "paused in the app and in mpv", 10000)
  const pausedAt = await ctx.mpv("time-pos")
  await ctx.sleep(2000)
  ctx.check(Math.abs((await ctx.mpv("time-pos")) - pausedAt) < 0.5, "mpv stays still while paused")
  await ctx.screenshot(`${label}-03-paused`)
  await ctx.press(BAR("Resume"))
  await ctx.until(async () => (await ctx.player()).paused === false && (await ctx.mpv("pause")) === false, "playing again", 10000)
  report.pauseResume = { pausedAtS: pausedAt }

  // Seek: the bar's Forward button once, then ArrowRight (30 s) presses past
  // the resume minimum, each waiting for the position to land.
  const forward = await ctx.app.evaluate(`document.querySelector('footer.player-bar button[aria-label^="Forward "]')?.getAttribute("aria-label") ?? null`)
  if (!forward) throw new Error("the bar has no Forward button")
  await ctx.snapshot(`${label}-04-bar`)
  const beforeForward = (await ctx.player()).positionMs
  await ctx.press(BAR(forward))
  const step = Number(forward.match(/\d+/)[0]) * 1000
  await ctx.until(async () => (await ctx.player()).positionMs >= beforeForward + step - 2000, `${forward} to land`, 10000)
  const target = report.durationMs * MIN_RESUME
  let presses = 0
  while ((await ctx.player()).positionMs < target) {
    const before = (await ctx.player()).positionMs
    await ctx.key("ArrowRight", { code: "ArrowRight", keyCode: 39 })
    presses++
    await ctx.until(async () => (await ctx.player()).positionMs >= before + 20000, "an ArrowRight seek to land", 8000, { quiet: true }).catch(() => {})
    if (presses > 60) throw new Error(`seeking did not reach ${Math.round(target / 1000)} s`)
  }
  const seekedTo = (await ctx.player()).positionMs
  ctx.check(Math.abs((await ctx.mpv("time-pos")) * 1000 - seekedTo) < 3000, "mpv's position matches the app's after seeking")
  report.seek = { forward, arrowPresses: presses, reachedS: seekedTo / 1000, targetS: target / 1000 }

  // Stop from the bar; the bar goes away and the stop position is reported.
  await ctx.until(() => ctx.playstates().queued.some((entry) => entry.endpoint === "Sessions/Playing/Progress" && entry.positionS * 1000 >= target - 1000), "a progress report past the resume minimum", 20000)
  marker = ctx.appLog().length
  if (await ctx.exists(BAR("Stop"))) {
    await ctx.press(BAR("Stop"))
  } else {
    await click(ctx, BAR("More playback controls"))
    await ctx.find({ role: "menuitem", name: "Stop playback" }, { timeout: 10000 })
    await click(ctx, { role: "menuitem", name: "Stop playback" })
  }
  await ctx.until(async () => !(await ctx.player())?.active, "playback to stop", 30000)
  await ctx.until(async () => !(await ctx.exists({ css: "footer.player-bar" })), "the player bar to go away", 10000)
  report.barGoneAfterStop = true
  const stopped = ctx.playstates().queued.filter((entry) => entry.endpoint === "Sessions/Playing/Stopped").at(-1)
  if (!stopped) throw new Error("no Sessions/Playing/Stopped report was queued")
  await ctx.until(() => ctx.playstates().sent.some((entry) => entry.endpoint === "Sessions/Playing/Stopped" && entry.status === 204), "Jellyfin to accept the Stopped report (204)", 20000)
  report.stoppedReportS = stopped.positionS
  ctx.check(Math.abs(stopped.positionS * 1000 - seekedTo) < 15000, `the Stopped report (${stopped.positionS.toFixed(1)} s) is where playback stopped (about ${(seekedTo / 1000).toFixed(1)} s)`)

  // Back on the title's page, which now offers Resume from what Jellyfin stored.
  report.afterStopPath = await ctx.pathname()
  if (report.afterStopPath !== detailPath) await search(ctx, label === "episode" ? SERIES : MOVIE, label === "episode" ? SERIES : MOVIE)
  await ctx.find({ role: "button", name: "Resume" }, { timeout: 30000 })
  report.resumeOfferedAfterStop = true
  await ctx.screenshot(`${label}-05-after-stop`)

  if (report.startedUnplayed) {
    await ctx.press({ role: "button", name: "Mark watched" })
    await ctx.find({ role: "button", name: "Mark unwatched" }, { timeout: 15000 })
    await ctx.press({ role: "button", name: "Mark unwatched" })
    await ctx.find({ role: "button", name: "Mark watched" }, { timeout: 15000 })
    report.restored = "marked watched then unwatched to clear the resume point"
  }
  return report
}

export default async function macE2e(ctx) {
  const summary = { server: "https://demo.jellyfin.org/stable", user: "demo", steps: results }
  try {
    await record(ctx, "sign-in", async () => {
      await ctx.signIn({ username: "demo" })
      const status = (await ctx.api("/api/status")).body
      ctx.check(status?.authenticated === true && status.userName === "demo", "/api/status reports user demo")
      return { userName: status.userName }
    })

    await record(ctx, "home", async () => {
      await ctx.until(async () => (await ctx.pathname()) === "/", "Home")
      await ctx.until(async () => (await ctx.count({ role: "region" })) > 0 && (await ctx.count(CARD)) > 0, "Home shelves with poster cards", 120000)
      await ctx.screenshot("01-home")
      return { cards: await ctx.count(CARD) }
    })

    await record(ctx, "library", async () => {
      await ctx.press({ role: "link", name: "Movies" })
      await ctx.until(async () => /^\/library\/[0-9a-f]+$/.test(await ctx.pathname()), "the Movies library")
      await ctx.find({ role: "heading", name: "Movies" })
      await ctx.until(async () => (await ctx.count(CARD)) > 0, "movie cards in the grid", 60000)
      await ctx.screenshot("02-movies")
      return { cards: await ctx.count(CARD) }
    })

    await record(ctx, "movie-detail", async () => {
      await search(ctx, "night of the living", MOVIE)
      await ctx.find({ role: "heading", name: MOVIE })
      await ctx.find({ role: "combobox", name: "Streaming quality" })
      await ctx.until(() => playButton(ctx), "the Play or Resume button")
      await ctx.screenshot("03-movie-detail")
      return { path: await ctx.pathname() }
    })

    await record(ctx, "series-detail", async () => {
      await search(ctx, SERIES, SERIES)
      await ctx.find({ role: "heading", name: SERIES })
      await ctx.find({ role: "list", name: "Seasons" }, { timeout: 30000 })
      await ctx.find({ role: "heading", name: "Episodes" })
      await ctx.until(async () => /link '\d+\./.test(await ctx.snapshot("04-series")), "the episode list")
      await ctx.screenshot("04-series-detail")
      return { path: await ctx.pathname() }
    })

    summary.mpvBefore = { idle: await ctx.mpv("idle-active").catch((error) => `error: ${error.message}`) }
    summary.playback = []
    for (const [label, open] of [
      ["movie", () => search(ctx, "night of the living", MOVIE)],
      ["episode", async () => {
        await search(ctx, SERIES, SERIES)
        await ctx.until(async () => /link '\d+\./.test(await ctx.snapshot("episode-series")), "the episode list")
        const seriesPath = await ctx.pathname()
        await ctx.park()
        await ctx.press({ css: 'a[href^="/item/"]:has(> span.tabular-nums)' }, { nth: 0 })
        await ctx.until(async () => (await ctx.pathname()) !== seriesPath && (await ctx.pathname()).startsWith("/item/"), "the episode page")
      }],
    ]) {
      const report = await record(ctx, `playback-${label}`, () => playTitle(ctx, label, open))
      if (report) summary.playback.push(report)
    }
    summary.mpvIpcConnections = (ctx.appLog().match(/mpv IPC connected/g) ?? []).length
    summary.lostCdpAcks = lostAcks

    // A real Cmd+Q from the keyboard (System Events), as a user quits.
    await record(ctx, "quit-cmd-q", async () => {
      const marker = ctx.appLog().length
      execFileSync("osascript", ["-e", 'tell application id "io.github.phob.mediaflick-desktop" to activate', "-e", "delay 2", "-e", 'tell application "System Events" to keystroke "q" using command down'])
      const exit = await ctx.appExit(30000)
      if (!exit) throw new Error("the app was still running 30 s after Cmd+Q")
      ctx.check(exit.code === 0, `the app exited with code ${exit.code} (signal ${exit.signal})`)
      ctx.check(/app: exit requested/.test(ctx.appLog().slice(marker)), "the log shows the orderly exit (exit requested)")
      return { exit }
    })
  } finally {
    summary.passed = results.every((entry) => entry.passed)
    summary.failed = results.filter((entry) => !entry.passed).map((entry) => entry.step)
    ctx.writeEvidence("mac-e2e.json", summary)
  }
  if (!summary.passed) throw new Error(`failed steps: ${summary.failed.join(", ")}`)
}
