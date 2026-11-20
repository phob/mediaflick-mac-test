// Real macOS input and window state for the e2e drive, through the window
// server (CGEvent) and the Accessibility API, the way a user's mouse and the
// Dock reach an app. CDP's Input domain injects into the renderer and skips
// AppKit, so it cannot show how the native window delivers mouse events.
//
//   pointer trusted                       is this process trusted for Accessibility
//   pointer bounds PID                    the app's on-screen layer-0 window frames (JSON, points, top-left origin)
//   pointer glide X1 Y1 X2 Y2 STEPS MS    move the mouse in STEPS steps, MS ms apart, ending at X2 Y2
//   pointer click X Y                     left click at X Y
//   pointer window PID                    the main window's AX state and its title bar buttons (JSON)
//   pointer press PID close|minimize|zoom click that title bar button with the real mouse
//   pointer set PID minimized|fullscreen|frame ...  set AXMinimized or AXFullScreen (true|false), or the frame (X Y W H), as the Dock or a drag would
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func json(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

func post(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        fail("could not create a \(type.rawValue) event")
    }
    event.post(tap: .cghidEventTap)
}

func click(_ point: CGPoint) {
    post(.mouseMoved, point)
    usleep(150_000)
    post(.leftMouseDown, point)
    usleep(80_000)
    post(.leftMouseUp, point)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = attribute(element, name) else { return nil }
    var result = CGPoint.zero
    // SAFETY of the cast: kAXPositionAttribute holds an AXValue of type cgPoint.
    return AXValueGetValue(value as! AXValue, .cgPoint, &result) ? result : nil
}

func size(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = attribute(element, name) else { return nil }
    var result = CGSize.zero
    // SAFETY of the cast: kAXSizeAttribute holds an AXValue of type cgSize.
    return AXValueGetValue(value as! AXValue, .cgSize, &result) ? result : nil
}

func mainWindow(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty else {
        fail("the app has no AX windows (trusted: \(AXIsProcessTrusted()))")
    }
    return windows.first { (attribute($0, kAXSubroleAttribute) as? String) == (kAXStandardWindowSubrole as String) } ?? windows[0]
}

func button(_ window: AXUIElement, _ name: String) -> [String: Any] {
    guard let raw = attribute(window, name) else { return ["exists": false] }
    // SAFETY of the cast: the title bar button attributes hold AXUIElements.
    let element = raw as! AXUIElement
    var info: [String: Any] = ["exists": true, "enabled": (attribute(element, kAXEnabledAttribute) as? Bool) ?? false]
    if let origin = point(element, kAXPositionAttribute), let extent = size(element, kAXSizeAttribute) {
        info["frame"] = [origin.x, origin.y, extent.width, extent.height]
        info["center"] = [origin.x + extent.width / 2, origin.y + extent.height / 2]
    }
    return info
}

let buttons = ["close": kAXCloseButtonAttribute, "minimize": kAXMinimizeButtonAttribute, "zoom": kAXZoomButtonAttribute, "fullscreen": kAXFullScreenButtonAttribute as String]

func windowState(_ pid: pid_t) -> [String: Any] {
    let window = mainWindow(pid)
    var state: [String: Any] = [
        "title": (attribute(window, kAXTitleAttribute) as? String) ?? NSNull(),
        "subrole": (attribute(window, kAXSubroleAttribute) as? String) ?? NSNull(),
        "minimized": (attribute(window, kAXMinimizedAttribute) as? Bool) ?? NSNull(),
        "fullScreen": (attribute(window, "AXFullScreen") as? Bool) ?? NSNull(),
    ]
    if let origin = point(window, kAXPositionAttribute), let extent = size(window, kAXSizeAttribute) {
        state["frame"] = [origin.x, origin.y, extent.width, extent.height]
    }
    for (key, name) in buttons { state[key] = button(window, name) }
    return state
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: see the header of pointer.swift") }
let number = { (index: Int) -> Double in
    guard index < args.count, let value = Double(args[index]) else { fail("argument \(index) must be a number") }
    return value
}

switch args[1] {
case "trusted":
    print(AXIsProcessTrusted())
case "bounds":
    let pid = Int(number(2))
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    json(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.map { window -> [String: Double] in
        let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return ["x": bounds["X"] ?? 0, "y": bounds["Y"] ?? 0, "width": bounds["Width"] ?? 0, "height": bounds["Height"] ?? 0]
    })
case "glide":
    let (x1, y1, x2, y2, steps, ms) = (number(2), number(3), number(4), number(5), max(1, Int(number(6))), number(7))
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        post(.mouseMoved, CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t))
        usleep(useconds_t(ms * 1000))
    }
case "click":
    click(CGPoint(x: number(2), y: number(3)))
case "window":
    json(windowState(pid_t(number(2))))
case "press":
    let pid = pid_t(number(2))
    guard args.count > 3, let name = buttons[args[3]] else { fail("press needs close, minimize, zoom or fullscreen") }
    let info = button(mainWindow(pid), name)
    guard let center = info["center"] as? [Double] else { fail("the window has no \(args[3]) button: \(info)") }
    click(CGPoint(x: center[0], y: center[1]))
case "set":
    let window = mainWindow(pid_t(number(2)))
    guard args.count > 3 else { fail("set needs minimized, fullscreen or frame") }
    let result: AXError
    switch args[3] {
    case "minimized":
        result = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, (args.count > 4 && args[4] == "true") as CFBoolean)
    case "fullscreen":
        result = AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, (args.count > 4 && args[4] == "true") as CFBoolean)
    case "frame":
        var origin = CGPoint(x: number(4), y: number(5))
        var extent = CGSize(width: number(6), height: number(7))
        let moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
        let sized = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &extent)!)
        result = moved == .success ? sized : moved
    default:
        fail("set needs minimized, fullscreen or frame")
    }
    if result != .success { fail("AX set \(args[3]) failed: \(result.rawValue)") }
default:
    fail("unknown command \(args[1])")
}
