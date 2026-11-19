"""Proves the Screen Sharing desktop is visible and controllable over VNC.

Connects to 127.0.0.1:5900 with the legacy VNC password (the scheme TigerVNC
and most non-Apple viewers use), opens and closes the Apple menu with the
mouse and the keyboard, and saves a screenshot of each state to OUTPUT_DIR.
Exits non-zero if the screen is black or does not react to input.
"""

import os
import sys
from pathlib import Path

from PIL import Image, ImageChops
from vncdotool import api, rfb

# vncdotool prefers Apple's own authentication when the server offers it; the
# check must use the VNC password, which is what the operator's viewer uses.
rfb.RFBClient.SUPPORTED_AUTHS = {rfb.AuthTypes.VNC_AUTHENTICATION}

# The area under the Apple menu, clear of the menu bar clock.
MENU_AREA = (0, 30, 300, 300)


def non_black_share(image: Image.Image) -> float:
    pixels = image.convert("L").getdata()
    return sum(1 for value in pixels if value > 12) / len(pixels)


def changed_share(before: Image.Image, after: Image.Image) -> float:
    difference = ImageChops.difference(before.convert("L"), after.convert("L"))
    pixels = difference.crop(MENU_AREA).getdata()
    return sum(1 for value in pixels if value > 24) / len(pixels)


def main() -> int:
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    shots = [output / name for name in ("1-desktop.png", "2-apple-menu-open.png", "3-apple-menu-closed.png")]

    client = api.connect("127.0.0.1::5900", password=os.environ["VNC_PASSWORD"], timeout=60)
    try:
        client.mouseMove(700, 400)
        client.pause(1)
        client.captureScreen(str(shots[0]))
        client.mouseMove(20, 10)
        client.mousePress(1)
        client.pause(2)
        client.captureScreen(str(shots[1]))
        client.keyPress("esc")
        client.pause(2)
        client.captureScreen(str(shots[2]))
    finally:
        client.disconnect()
        api.shutdown()

    desktop, menu_open, menu_closed = (Image.open(path) for path in shots)
    visible = non_black_share(desktop)
    opened = changed_share(desktop, menu_open)
    closed = changed_share(menu_open, menu_closed)
    print(f"framebuffer {desktop.size[0]}x{desktop.size[1]}, {visible:.1%} non-black")
    print(f"mouse click on the Apple menu changed {opened:.1%} of the menu area")
    print(f"Escape key changed {closed:.1%} of the menu area")

    failures = []
    if visible < 0.02:
        failures.append("the desktop is black")
    if opened < 0.05:
        failures.append("the mouse click did not open the Apple menu")
    if closed < 0.05:
        failures.append("the Escape key did not close the Apple menu")
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    if not failures:
        print("PASS: the desktop is visible and takes mouse and keyboard input over VNC")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
