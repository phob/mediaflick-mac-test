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

// External mpv goes fullscreen in its own Space and covers the app window.
// macOS then stops the hidden window's frames, and CDP input waits for a
// frame that never comes (runs 44646986594 and 44651423968 stalled 28 min on
// the bar's overflow menu until a CDP screenshot forced one). A user switches
// back to MediaFlick to use its player bar; so does the drive.
async function front(ctx) {
  execFileSync("osascript", ["-e", 'tell application id "io.github.phob.mediaflick-desktop" to activate'])
  await ctx.sleep(2500)
  ctx.step("brought MediaFlick to the front")
}

// Real input through the window server (scripts/pointer.swift), which CDP's
// Input domain bypasses: it injects into the renderer, past AppKit.
const pointer = (...args) => execFileSync(process.env.MEDIAFLICK_VERIFY_POINTER, args.map(String), { encoding: "utf8" }).trim()
const appPid = () => Number(execFileSync("pgrep", ["-x", "mediaflick-desktop"], { encoding: "utf8" }).trim().split("\n")[0])
const windowState = () => JSON.parse(pointer("window", appPid()))
const sidebarState = (ctx) => ctx.app.evaluate(`document.querySelector('[data-slot="sidebar"]')?.dataset.state ?? null`)

// Where the page's (0, 0) is on the screen, in points: the window's frame
// less the title bar above the page.
async function pageOrigin(ctx) {
  const [bounds] = JSON.parse(pointer("bounds", appPid()))
  const [, innerHeight] = await ctx.app.evaluate("[innerWidth, innerHeight]")
  return { x: bounds.x, y: bounds.y + bounds.height - innerHeight, bounds }
}

// Records, in the page, every sidebar expand and collapse and the pointer
// events around it: enter and leave of the sidebar, and each pointerout whose
// pointer went to nothing (relatedTarget null, which React reads as leaving
// the window) or out of the sidebar.
const SIDEBAR_PROBE = `(() => {
  const sidebar = document.querySelector('[data-slot="sidebar"]')
  const container = document.querySelector('[data-slot="sidebar-container"]')
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)
  const name = (node) => {
    if (!node) return null
    if (node.nodeType !== 1) return node.nodeName
    const slot = node.dataset.slot ?? node.dataset.sidebar
    const text = node.closest('[data-sidebar="menu-button"]')?.textContent?.trim()
    return node.tagName.toLowerCase() + (slot ? "[" + slot + "]" : "") + (text ? " (" + text + ")" : "")
  }
  const log = []
  const probe = { log, mark: (label) => log.push({ t: now(), type: "mark", label }) }
  for (const type of ["pointerover", "pointerout", "pointerenter", "pointerleave", "mouseleave", "mouseenter"]) {
    document.addEventListener(type, (event) => {
      const enterLeave = !type.endsWith("over") && !type.endsWith("out")
      if (enterLeave && event.target !== container && event.target !== document.documentElement) return
      if (!enterLeave && event.relatedTarget && container.contains(event.target) === container.contains(event.relatedTarget)) return
      log.push({ t: now(), type, target: name(event.target), related: name(event.relatedTarget), x: Math.round(event.clientX), y: Math.round(event.clientY) })
    }, true)
  }
  new MutationObserver(() => log.push({ t: now(), type: "state", state: sidebar.dataset.state })).observe(sidebar, { attributes: true, attributeFilter: ["data-state"] })
  window.__sidebarProbe = probe
  return true
})()`

async function hoverPass(ctx, label, move) {
  await ctx.app.evaluate(`window.__sidebarProbe.mark(${JSON.stringify(label + ":start")})`)
  await move()
  await ctx.app.evaluate(`window.__sidebarProbe.mark(${JSON.stringify(label + ":end")})`)
  const log = await ctx.app.evaluate(`JSON.stringify(window.__sidebarProbe.log)`).then(JSON.parse)
  const start = log.findIndex((entry) => entry.label === `${label}:start`)
  const end = log.findIndex((entry) => entry.label === `${label}:end`)
  const during = log.slice(start, end + 1)
  return {
    pass: label,
    collapses: during.filter((entry) => entry.type === "state" && entry.state === "collapsed").length,
    leavesToNothing: during.filter((entry) => entry.type === "pointerout" && entry.related === null).length,
    events: during,
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
  await front(ctx)
  screen(ctx, `${label}-02b-app-in-front-screen`)

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

// MEDIAFLICK_VERIFY_STEPS: a comma-separated list of the steps to run after
// sign-in (playback runs both titles), or empty for all but quit-close-button.
const only = (process.env.MEDIAFLICK_VERIFY_STEPS ?? "").split(",").map((step) => step.trim()).filter(Boolean)
const wanted = (step) => (only.length ? only.includes(step) : step !== "quit-close-button")

export default async function macE2e(ctx) {
  const summary = { server: "https://demo.jellyfin.org/stable", user: "demo", steps: results }
  try {
    await record(ctx, "sign-in", async () => {
      await ctx.signIn({ username: "demo" })
      const status = (await ctx.api("/api/status")).body
      ctx.check(status?.authenticated === true && status.userName === "demo", "/api/status reports user demo")
      return { userName: status.userName }
    })

    if (wanted("home")) await record(ctx, "home", async () => {
      await ctx.until(async () => (await ctx.pathname()) === "/", "Home")
      await ctx.until(async () => (await ctx.count({ role: "region" })) > 0 && (await ctx.count(CARD)) > 0, "Home shelves with poster cards", 120000)
      await ctx.screenshot("01-home")
      return { cards: await ctx.count(CARD) }
    })

    if (wanted("library")) await record(ctx, "library", async () => {
      await ctx.press({ role: "link", name: "Movies" })
      await ctx.until(async () => /^\/library\/[0-9a-f]+$/.test(await ctx.pathname()), "the Movies library")
      await ctx.find({ role: "heading", name: "Movies" })
      await ctx.until(async () => (await ctx.count(CARD)) > 0, "movie cards in the grid", 60000)
      await ctx.screenshot("02-movies")
      return { cards: await ctx.count(CARD) }
    })

    if (wanted("movie-detail")) await record(ctx, "movie-detail", async () => {
      await search(ctx, "night of the living", MOVIE)
      await ctx.find({ role: "heading", name: MOVIE })
      await ctx.find({ role: "combobox", name: "Streaming quality" })
      await ctx.until(() => playButton(ctx), "the Play or Resume button")
      await ctx.screenshot("03-movie-detail")
      return { path: await ctx.pathname() }
    })

    if (wanted("series-detail")) await record(ctx, "series-detail", async () => {
      await search(ctx, SERIES, SERIES)
      await ctx.find({ role: "heading", name: SERIES })
      await ctx.find({ role: "list", name: "Seasons" }, { timeout: 30000 })
      await ctx.find({ role: "heading", name: "Episodes" })
      await ctx.until(async () => /link '\d+\./.test(await ctx.snapshot("04-series")), "the episode list")
      await ctx.screenshot("04-series-detail")
      return { path: await ctx.pathname() }
    })

    // Off Home the sidebar is collapsed and expands under the pointer. Moving
    // the real mouse slowly down its entries must keep it expanded the whole
    // way: no collapse while the pointer never leaves it.
    if (wanted("sidebar-hover")) await record(ctx, "sidebar-hover", async () => {
      await front(ctx)
      if (!/^\/library\/[0-9a-f]+$/.test(await ctx.pathname())) {
        await ctx.press({ role: "link", name: "Movies" })
        await ctx.until(async () => /^\/library\/[0-9a-f]+$/.test(await ctx.pathname()), "the Movies library")
      }
      const origin = await pageOrigin(ctx)
      const away = { x: origin.x + 700, y: origin.y + 300 }
      pointer("glide", away.x, away.y, away.x, away.y, 1, 300)
      await ctx.until(async () => (await sidebarState(ctx)) === "collapsed", "the sidebar collapsed with the pointer on the page")
      const rows = JSON.parse(await ctx.app.evaluate(`JSON.stringify([...document.querySelectorAll('[data-sidebar="menu-button"]')].map((b) => { const r = b.getBoundingClientRect(); return { name: b.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height } }))`))
      const first = rows[0]
      const last = rows.at(-1)
      const iconX = first.x + first.width / 2
      const top = first.y + first.height / 2
      const bottom = last.y + last.height / 2
      await ctx.app.evaluate(SIDEBAR_PROBE)
      const passes = []

      // Real mouse: onto the first icon, then 1 pt every 20 ms down to the last.
      pointer("glide", away.x, away.y, origin.x + iconX, origin.y + top, 40, 15)
      await ctx.until(async () => (await sidebarState(ctx)) === "expanded", "the sidebar expanded under the real pointer", 5000)
      await ctx.sleep(600)
      screen(ctx, "sidebar-01-expanded-screen")
      passes.push(await hoverPass(ctx, "real-down-icons", async () => pointer("glide", origin.x + iconX, origin.y + top, origin.x + iconX, origin.y + bottom, Math.round(bottom - top), 20)))
      // Back up over the entries' labels.
      const textX = iconX + 90
      passes.push(await hoverPass(ctx, "real-up-labels", async () => {
        pointer("glide", origin.x + iconX, origin.y + bottom, origin.x + textX, origin.y + bottom, 20, 15)
        pointer("glide", origin.x + textX, origin.y + bottom, origin.x + textX, origin.y + top, Math.round(bottom - top), 20)
      }))
      screen(ctx, "sidebar-02-after-real-passes-screen")

      // The same path through CDP, which reaches the renderer without AppKit.
      passes.push(await hoverPass(ctx, "cdp-down-icons", async () => {
        for (let y = top; y <= bottom; y += 1) {
          await ctx.app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: iconX, y, button: "none" })
          await ctx.sleep(20)
        }
      }))
      pointer("glide", origin.x + iconX, origin.y + bottom, away.x, away.y, 30, 15)
      await ctx.until(async () => (await sidebarState(ctx)) === "collapsed", "the sidebar collapsed once the pointer left it")

      const report = { origin, rows, iconX, textX, top, bottom, passes }
      ctx.writeEvidence("sidebar-hover.json", report)
      for (const pass of passes) ctx.step(`${pass.pass}: ${pass.collapses} collapses, ${pass.leavesToNothing} pointerouts to nothing`)
      const real = passes.filter((pass) => pass.pass.startsWith("real"))
      ctx.check(real.every((pass) => pass.collapses === 0), `the sidebar stays expanded while the real pointer moves down and up its entries (${real.map((pass) => `${pass.pass}: ${pass.collapses} collapses`).join(", ")})`)
      return { passes: passes.map(({ pass, collapses, leavesToNothing }) => ({ pass, collapses, leavesToNothing })) }
    })

    // The window's title bar buttons, used with the real mouse: minimize and
    // restore from the Dock, zoom, and a moved and resized frame that comes
    // back after a relaunch.
    if (wanted("window-chrome")) await record(ctx, "window-chrome", async () => {
      await front(ctx)
      const report = { trusted: pointer("trusted") }
      report.initial = windowState()
      screen(ctx, "window-01-title-bar-screen")
      const missing = ["close", "minimize", "zoom"].filter((key) => !report.initial[key].exists || !report.initial[key].enabled)
      ctx.check(missing.length === 0, `the window has enabled close, minimize and zoom buttons${missing.length ? `; missing or disabled: ${missing.join(", ")}` : ""}`)

      pointer("press", appPid(), "minimize")
      await ctx.until(() => windowState().minimized === true, "the window minimized to the Dock", 10000)
      screen(ctx, "window-02-minimized-screen")
      ctx.check((await ctx.appExit(1000)) === null, "the app keeps running while minimized")
      pointer("set", appPid(), "minimized", "false")
      await ctx.until(() => windowState().minimized === false, "the window restored from the Dock", 10000)
      await front(ctx)
      report.restored = windowState()
      screen(ctx, "window-03-restored-screen")

      const before = windowState()
      pointer("press", appPid(), "zoom")
      await ctx.until(() => {
        const now = windowState()
        return now.fullScreen === true || JSON.stringify(now.frame) !== JSON.stringify(before.frame) ? now : null
      }, "the zoom button to change the window", 10000)
      await ctx.sleep(1500)
      report.zoomed = windowState()
      screen(ctx, "window-04-zoomed-screen")
      if (report.zoomed.fullScreen) {
        pointer("set", appPid(), "fullscreen", "false")
        await ctx.until(() => windowState().fullScreen === false, "full screen to end", 10000)
      } else {
        pointer("press", appPid(), "zoom")
        await ctx.until(() => JSON.stringify(windowState().frame) === JSON.stringify(before.frame), "the zoom button to restore the frame", 10000)
      }
      await ctx.sleep(1500)
      report.unzoomed = windowState()

      const frame = [40, 60, 900, 600]
      pointer("set", appPid(), "frame", ...frame)
      await ctx.until(() => JSON.stringify(windowState().frame) === JSON.stringify(frame), `the window moved and resized to ${frame}`, 10000)
      await ctx.sleep(1000)
      await ctx.relaunch()
      await ctx.until(() => { try { return windowState().frame } catch { return null } }, "the relaunched window", 30000)
      report.saved = ctx.readConfig("settings.json")?.webui_window ?? null
      report.relaunched = windowState()
      screen(ctx, "window-05-relaunched-screen")
      ctx.writeEvidence("window-chrome.json", report)
      ctx.check(report.relaunched.frame.every((value, index) => Math.abs(value - frame[index]) <= 2), `the relaunched window keeps the moved and resized frame (${report.relaunched.frame} vs ${frame})`)
      return report
    })

    if (wanted("playback")) summary.mpvBefore = { idle: await ctx.mpv("idle-active").catch((error) => `error: ${error.message}`) }
    summary.playback = []
    for (const [label, open] of !wanted("playback") ? [] : [
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
    if (wanted("quit-cmd-q")) await record(ctx, "quit-cmd-q", async () => {
      const marker = ctx.appLog().length
      execFileSync("osascript", ["-e", 'tell application id "io.github.phob.mediaflick-desktop" to activate', "-e", "delay 2", "-e", 'tell application "System Events" to keystroke "q" using command down'])
      const exit = await ctx.appExit(30000)
      if (!exit) throw new Error("the app was still running 30 s after Cmd+Q")
      ctx.check(exit.code === 0, `the app exited with code ${exit.code} (signal ${exit.signal})`)
      ctx.check(/app: exit requested/.test(ctx.appLog().slice(marker)), "the log shows the orderly exit (exit requested)")
      return { exit }
    })

    // The window's close button, clicked with the real mouse, quits through
    // the same orderly exit as Cmd+Q (Close behavior is the default, Exit).
    if (wanted("quit-close-button")) await record(ctx, "quit-close-button", async () => {
      await front(ctx)
      const marker = ctx.appLog().length
      pointer("press", appPid(), "close")
      const exit = await ctx.appExit(30000)
      if (!exit) throw new Error("the app was still running 30 s after its close button")
      ctx.check(exit.code === 0, `the app exited with code ${exit.code} (signal ${exit.signal})`)
      const log = ctx.appLog().slice(marker)
      ctx.check(/last window closed; shutting down/.test(log), "the log shows the orderly shutdown (last window closed; shutting down)")
      return { exit, log: log.split("\n").filter((line) => / app: | app\.|shutting down|exit/.test(line)).slice(-20) }
    })
  } finally {
    summary.passed = results.every((entry) => entry.passed)
    summary.failed = results.filter((entry) => !entry.passed).map((entry) => entry.step)
    ctx.writeEvidence("mac-e2e.json", summary)
  }
  if (!summary.passed) throw new Error(`failed steps: ${summary.failed.join(", ")}`)
}
