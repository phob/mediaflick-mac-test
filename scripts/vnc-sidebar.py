"""The sidebar hover check, driven the way the operator drove it: over Screen
Sharing (VNC) into the tester account's own desktop session.

MediaFlick runs in the tester session with a CDP port, signs in to the demo
server by VNC mouse and keyboard, and opens Movies. The VNC pointer then moves
slowly onto the collapsed sidebar, down its icons 1 px at a time and back up
over the labels, while the page records each expand and collapse and every
pointer event that crosses the sidebar's edge or goes to nothing. Fails when
the sidebar collapses while the pointer is on it.

Usage: vnc-sidebar.py OUTPUT_DIR  (needs MAC_PASSWORD, the tester password)
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket
from vncdotool import api

APP = "/Applications/MediaFlick Desktop.app/Contents/MacOS/mediaflick-desktop"
PORT = 9333
DEMO = "https://demo.jellyfin.org/stable"
STEP_S = 0.02

PROBE = r"""(() => {
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
  for (const type of ["pointerover", "pointerout", "pointerenter", "pointerleave"]) {
    document.addEventListener(type, (event) => {
      const crossing = type === "pointerover" || type === "pointerout"
      if (!crossing && event.target !== container) return
      if (crossing && event.relatedTarget && container.contains(event.target) === container.contains(event.relatedTarget)) return
      log.push({ t: now(), type, target: name(event.target), related: name(event.relatedTarget), x: Math.round(event.clientX), y: Math.round(event.clientY), buttons: event.buttons, pointerType: event.pointerType })
    }, true)
  }
  new MutationObserver(() => log.push({ t: now(), type: "state", state: sidebar.dataset.state })).observe(sidebar, { attributes: true, attributeFilter: ["data-state"] })
  window.__sidebarProbe = { log, mark: (label) => log.push({ t: now(), type: "mark", label }) }
  return true
})()"""


class Cdp:
    def __init__(self, port: int):
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=10))
        page = next(t for t in targets if t["type"] == "page" and t["url"].startswith("mediaflick-desktop://"))
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
        self.next_id = 0

    def send(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        self.ws.send(json.dumps({"id": self.next_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == self.next_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message["result"]

    def eval(self, expression: str):
        result = self.send("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in result:
            raise RuntimeError(f"evaluate failed: {result['exceptionDetails']}")
        return result["result"].get("value")


def until(check, description: str, timeout: float = 30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
        except Exception:  # the page or CDP may not be up yet
            value = None
        if value:
            log(f"saw {description}")
            return value
        time.sleep(0.25)
    raise RuntimeError(f"timed out after {timeout} s waiting for {description}")


steps: list[str] = []


def log(text: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {text}"
    steps.append(line)
    print(line, flush=True)


def main() -> int:
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    client = api.connect("127.0.0.1::5900", username="tester", password=os.environ["MAC_PASSWORD"], timeout=90)
    report: dict = {"stepS": STEP_S}
    app = None
    try:
        # Signing in over VNC starts the tester session; wait for its desktop.
        client.pause(30)
        client.captureScreen(str(output / "00-desktop.png"))
        uid = subprocess.run(["id", "-u", "tester"], capture_output=True, text=True, check=True).stdout.strip()
        app_log = open(output / "app-stdout.log", "w")
        app = subprocess.Popen(
            ["sudo", "launchctl", "asuser", uid, "sudo", "-u", "tester", "-H", "env", "HOME=/Users/tester", "TMPDIR=/tmp", APP, "--remote-debugging-port", str(PORT), "--url", DEMO, "--log-level", "debug"],
            stdout=app_log, stderr=subprocess.STDOUT,
        )
        cdp = until(lambda: Cdp(PORT), "the app's CDP page in the tester session", 90)
        screen = until(lambda: cdp.eval("JSON.stringify({ w: screen.width, h: screen.height, x: screenX, y: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio })"), "the window geometry")
        geometry = json.loads(screen)
        client.captureScreen(str(output / "01-app.png"))
        fb_width = client.screen.size[0]
        scale = fb_width / geometry["w"]
        report["geometry"] = geometry
        report["framebuffer"] = list(client.screen.size)
        log(f"geometry {geometry}, framebuffer {client.screen.size}, scale {scale}")

        def to_screen(x: float, y: float) -> tuple[int, int]:
            # Page (CSS px) to framebuffer pixels: the window's origin plus
            # the title bar above the page.
            top = geometry["y"] + geometry["oh"] - geometry["ih"]
            return round((geometry["x"] + x) * scale), round((top + y) * scale)

        def rect(selector: str) -> dict:
            return json.loads(cdp.eval(f"JSON.stringify(document.querySelector({json.dumps(selector)})?.getBoundingClientRect() ?? null)"))

        def move(x: float, y: float) -> None:
            client.mouseMove(*to_screen(x, y))

        def glide(start: tuple[float, float], end: tuple[float, float]) -> None:
            steps_count = max(1, round(max(abs(end[0] - start[0]), abs(end[1] - start[1]))))
            for step in range(1, steps_count + 1):
                t = step / steps_count
                move(start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t)
                client.pause(STEP_S)

        # Sign in with the VNC mouse and keyboard.
        field = until(lambda: rect('input[autocomplete="username"], input[name="username"], #username'), "the Username field", 60)
        client.mouseMove(*to_screen(field["x"] + 20, field["y"] + field["height"] / 2))
        client.mousePress(1)
        client.pause(0.5)
        client.type("demo")
        client.keyPress("enter")
        until(lambda: cdp.eval("JSON.stringify(location.pathname)") == '"/"' and cdp.eval("!!document.querySelector('[data-slot=\"sidebar\"]')"), "Home after sign-in", 60)
        movies = until(lambda: json.loads(cdp.eval("""JSON.stringify((() => { const link = [...document.querySelectorAll('[data-sidebar="menu-button"]')].find((b) => b.textContent.trim() === "Movies"); return link ? link.getBoundingClientRect() : null })())""")), "the Movies link", 60)
        client.mouseMove(*to_screen(movies["x"] + movies["width"] / 2, movies["y"] + movies["height"] / 2))
        client.mousePress(1)
        until(lambda: (cdp.eval("location.pathname") or "").startswith("/library/"), "the Movies library")

        away = (geometry["iw"] * 0.7, geometry["ih"] * 0.4)
        glide((away[0] - 5, away[1]), away)
        until(lambda: cdp.eval("document.querySelector('[data-slot=\"sidebar\"]').dataset.state") == "collapsed", "the sidebar collapsed with the pointer on the page")
        rows = json.loads(cdp.eval("""JSON.stringify([...document.querySelectorAll('[data-sidebar="menu-button"]')].map((b) => { const r = b.getBoundingClientRect(); return { name: b.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height } }))"""))
        first, last = rows[0], rows[-1]
        icon_x = first["x"] + first["width"] / 2
        top = first["y"] + first["height"] / 2
        bottom = last["y"] + last["height"] / 2
        label_x = icon_x + 90
        report["rows"] = rows
        cdp.eval(PROBE)
        client.captureScreen(str(output / "02-collapsed.png"))

        glide(away, (icon_x, top))
        until(lambda: cdp.eval("document.querySelector('[data-slot=\"sidebar\"]').dataset.state") == "expanded", "the sidebar expanded under the VNC pointer", 10)
        time.sleep(0.6)
        client.captureScreen(str(output / "03-expanded.png"))

        passes = []
        for label, path in (
            ("vnc-down-icons", [((icon_x, top), (icon_x, bottom))]),
            ("vnc-up-labels", [((icon_x, bottom), (label_x, bottom)), ((label_x, bottom), (label_x, top))]),
        ):
            cdp.eval(f"window.__sidebarProbe.mark({json.dumps(label)})")
            for start, end in path:
                glide(start, end)
            cdp.eval('window.__sidebarProbe.mark("end")')
            entries = json.loads(cdp.eval("JSON.stringify(window.__sidebarProbe.log)"))
            begin = max(i for i, entry in enumerate(entries) if entry.get("label") == label)
            events = entries[begin:]
            collapses = sum(1 for entry in events if entry["type"] == "state" and entry["state"] == "collapsed")
            to_nothing = sum(1 for entry in events if entry["type"] == "pointerout" and entry["related"] is None)
            log(f"{label}: {collapses} collapses, {to_nothing} pointerouts to nothing")
            passes.append({"pass": label, "collapses": collapses, "pointeroutsToNothing": to_nothing, "events": events})
        client.captureScreen(str(output / "04-after-passes.png"))
        report["passes"] = passes
        report["passed"] = all(entry["collapses"] == 0 for entry in passes)
    finally:
        (output / "vnc-sidebar.json").write_text(json.dumps(report, indent=2) + "\n")
        (output / "steps.log").write_text("\n".join(steps) + "\n")
        client.disconnect()
        api.shutdown()
        subprocess.run(["sudo", "pkill", "-x", "mediaflick-desktop"], check=False)
        if app:
            app.wait(timeout=30)
    if report.get("passed"):
        print("PASS: the sidebar stays expanded while the VNC pointer moves down and up its entries")
        return 0
    print("FAIL: the sidebar collapsed while the VNC pointer was on it: " + ", ".join(f"{p['pass']}: {p['collapses']}" for p in report.get("passes", [])), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
