"""Proves the tester desktop is reachable, visible and controllable over VNC.

Connects to 127.0.0.1:5900 with the legacy VNC password (the scheme TigerVNC
and most non-Apple viewers use), logs in as the tester account at the login
window, opens and closes the Apple menu with the mouse and the keyboard, and
saves a screenshot of each state to the directory given as the first argument.
Exits non-zero if the screen stays black, the login fails or input is ignored.
"""

import os
import sys
from pathlib import Path

from PIL import Image, ImageChops
from vncdotool import api, rfb

# vncdotool prefers Apple's own authentication when the server offers it; the
# check must use the VNC password, which is what the operator's viewer uses.
rfb.RFBClient.SUPPORTED_AUTHS = {rfb.AuthTypes.VNC_AUTHENTICATION}

WHOLE_SCREEN = None
# The area under the Apple menu, clear of the menu bar clock.
MENU_AREA = (0, 30, 300, 300)


def changed_share(before: Image.Image, after: Image.Image, area: tuple[int, int, int, int] | None) -> float:
    difference = ImageChops.difference(before.convert("L"), after.convert("L"))
    pixels = (difference.crop(area) if area else difference).get_flattened_data()
    return sum(1 for value in pixels if value > 24) / len(pixels)


def type_text(client: api.ThreadedVNCClientProxy, text: str) -> None:
    for character in text:
        client.keyPress(character)


def main() -> int:
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    names = ("1-login-window", "2-desktop", "3-apple-menu-open", "4-apple-menu-closed")
    shots = [output / f"{name}.png" for name in names]

    password = os.environ["MAC_PASSWORD"]
    client = api.connect("127.0.0.1::5900", password=password, timeout=60)
    try:
        client.pause(3)
        client.captureScreen(str(shots[0]))
        # The Name field of the login window.
        client.mouseMove(512, 652)
        client.mousePress(1)
        type_text(client, "tester")
        client.keyPress("tab")
        type_text(client, password)
        client.keyPress("enter")
        client.pause(30)
        client.mouseMove(700, 400)
        client.pause(1)
        client.captureScreen(str(shots[1]))
        client.mouseMove(20, 10)
        client.mousePress(1)
        client.pause(2)
        client.captureScreen(str(shots[2]))
        client.keyPress("esc")
        client.pause(2)
        client.captureScreen(str(shots[3]))
    finally:
        client.disconnect()
        api.shutdown()

    login, desktop, menu_open, menu_closed = (Image.open(path) for path in shots)
    logged_in = changed_share(login, desktop, WHOLE_SCREEN)
    opened = changed_share(desktop, menu_open, MENU_AREA)
    closed = changed_share(menu_open, menu_closed, MENU_AREA)
    print(f"framebuffer {desktop.size[0]}x{desktop.size[1]}")
    print(f"logging in changed {logged_in:.1%} of the screen")
    print(f"a mouse click on the Apple menu changed {opened:.1%} of the menu area")
    print(f"the Escape key changed {closed:.1%} of the menu area")

    failures = []
    if logged_in < 0.05:
        failures.append("logging in did not change the screen")
    if opened < 0.05:
        failures.append("the mouse click did not open the Apple menu")
    if closed < 0.05:
        failures.append("the Escape key did not close the Apple menu")
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    if not failures:
        print("PASS: logged in over VNC; the desktop takes mouse and keyboard input")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
