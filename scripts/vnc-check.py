"""Proves the tester desktop is reachable, visible and controllable over VNC.

Connects to 127.0.0.1:5900 as the tester account with Apple's authentication
(what the operator's viewer uses), waits for the desktop, opens and closes the
Apple menu with the mouse and the keyboard, and saves a screenshot of each
state to the directory given as the first argument. Exits non-zero if the
screen stays black or ignores input. Signing in this way also starts the
tester session, so the operator's viewer finds the desktop already running.
"""

import os
import sys
from pathlib import Path

from PIL import Image, ImageChops
from vncdotool import api

# The area under the Apple menu, clear of the menu bar clock.
MENU_AREA = (0, 30, 300, 300)


def non_black_share(image: Image.Image) -> float:
    pixels = image.convert("L").get_flattened_data()
    return sum(1 for value in pixels if value > 12) / len(pixels)


def changed_share(before: Image.Image, after: Image.Image) -> float:
    difference = ImageChops.difference(before.convert("L"), after.convert("L"))
    pixels = difference.crop(MENU_AREA).get_flattened_data()
    return sum(1 for value in pixels if value > 24) / len(pixels)


def main() -> int:
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    shots = [output / f"{name}.png" for name in ("1-desktop", "2-apple-menu-open", "3-apple-menu-closed")]

    client = api.connect("127.0.0.1::5900", username="tester", password=os.environ["MAC_PASSWORD"], timeout=90)
    try:
        # A first sign-in creates the session, which shows black until ready.
        for _ in range(24):
            client.pause(5)
            client.captureScreen(str(shots[0]))
            if non_black_share(Image.open(shots[0])) > 0.2:
                break
        client.pause(5)
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
    print(f"a mouse click on the Apple menu changed {opened:.1%} of the menu area")
    print(f"the Escape key changed {closed:.1%} of the menu area")

    failures = []
    if visible < 0.2:
        failures.append("the desktop is black")
    if opened < 0.05:
        failures.append("the mouse click did not open the Apple menu")
    if closed < 0.05:
        failures.append("the Escape key did not close the Apple menu")
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    if not failures:
        print("PASS: the tester desktop is visible and takes mouse and keyboard input over VNC")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
