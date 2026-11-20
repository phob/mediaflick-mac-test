// Throwaway feasibility probe: can MediaFlick drive Homebrew libmpv on macOS the
// way it drives libmpv on Windows (mpv owns the window, publishes window-id, the
// app layers its own view above and feeds CEF pixels through overlay-add)?
import AppKit
import Foundation

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "async"
let out = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/tmp"
func log(_ s: String) { print("[probe:\(mode)] \(s)"); fflush(stdout) }

let app = NSApplication.shared
app.setActivationPolicy(.regular)

var handle: OpaquePointer? = nil
func opt(_ k: String, _ v: String) {
    let r = mpv_set_option_string(handle, k, v)
    if r < 0 { log("option \(k)=\(v) failed: \(String(cString: mpv_error_string(r)))") }
}
func prop(_ k: String) -> String {
    guard let p = mpv_get_property_string(handle, k) else { return "<unavailable>" }
    defer { mpv_free(p) }
    return String(cString: p)
}
func command(_ args: [String]) -> Int32 {
    var cargs = args.map { strdup($0) } + [nil]
    defer { cargs.forEach { free($0) } }
    return cargs.withUnsafeMutableBufferPointer { buf in
        buf.baseAddress!.withMemoryRebound(to: UnsafePointer<CChar>?.self, capacity: buf.count) {
            mpv_command(handle, $0)
        }
    }
}
// Same named-argument overlay-add the Linux adapter sends (src/players/mpv/runtime/gpu_next.rs).
func overlayAdd(_ pixels: UnsafeMutableRawPointer, w: Int, h: Int, dw: Int, dh: Int) -> Int32 {
    let pairs: [(String, String)] = [
        ("name", "overlay-add"), ("id", "0"), ("x", "0"), ("y", "0"),
        ("file", "&\(Int(bitPattern: pixels))"), ("offset", "0"), ("fmt", "bgra"),
        ("w", "\(w)"), ("h", "\(h)"), ("stride", "\(w * 4)"), ("dw", "\(dw)"), ("dh", "\(dh)"),
    ]
    let keys = pairs.map { strdup($0.0) }
    let vals = pairs.map { strdup($0.1) }
    defer { (keys + vals).forEach { free($0) } }
    var nodes = vals.map { v -> mpv_node in
        var n = mpv_node(); n.format = MPV_FORMAT_STRING; n.u.string = v; return n
    }
    var keyPtrs = keys
    return nodes.withUnsafeMutableBufferPointer { np in
        keyPtrs.withUnsafeMutableBufferPointer { kp in
            var list = mpv_node_list(num: Int32(pairs.count), values: np.baseAddress, keys: kp.baseAddress)
            return withUnsafeMutablePointer(to: &list) { lp in
                var node = mpv_node(); node.format = MPV_FORMAT_NODE_MAP; node.u.list = lp
                return mpv_command_node(handle, &node, nil)
            }
        }
    }
}

func waitWindowId(seconds: Double) -> Int64? {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        var wid: Int64 = 0
        if mpv_get_property(handle, "window-id", MPV_FORMAT_INT64, &wid) >= 0, wid != 0 { return wid }
        usleep(10_000)
    }
    return nil
}

func startPlayer() {
    log("client API \(mpv_client_api_version() >> 16).\(mpv_client_api_version() & 0xffff)")
    handle = mpv_create()
    for (k, v) in [("config", "no"), ("load-scripts", "no"), ("force-window", "yes"), ("idle", "yes"),
                   ("vo", "gpu-next"), ("hwdec", "auto-safe"), ("input-default-bindings", "no"),
                   ("input-vo-keyboard", "no"), ("input-cursor", "no"), ("cursor-autohide", "no"),
                   ("title", "MediaFlick probe"), ("autofit", "70%"), ("border", "yes"),
                   ("keepaspect-window", "no"), ("auto-window-resize", "no"), ("osc", "no"),
                   ("msg-level", "all=v"), ("log-file", "\(out)/mpv-\(mode).log"), ("geometry", "1280x720+0+0")] + (ProcessInfo.processInfo.environment["PROBE_VO"].map { [("vo", $0)] } ?? []) {
        opt(k, v)
    }
    let r = mpv_initialize(handle)
    log("mpv_initialize -> \(r)")
}

func finish(_ code: Int32) {
    log("terminating")
    mpv_terminate_destroy(handle)
    exit(code)
}

if mode == "block" {
    // What on_context_initialized does today: the UI (main) thread blocks
    // waiting for the player's native window while the player starts elsewhere.
    let worker = Thread { startPlayer() }
    worker.start()
    usleep(500_000)
    let wid = waitWindowId(seconds: 10)
    log("main thread blocked, window-id after 10s wait: \(wid.map(String.init) ?? "NONE (deadlocked on main queue)")")
    finish(0)
}

Thread {
    startPlayer()
    let started = Date()
    guard let wid = waitWindowId(seconds: 20) else {
        log("window-id never published (current-vo=\(prop("current-vo")))"); finish(2); return
    }
    log(String(format: "window-id published after %.2fs: 0x%llx", Date().timeIntervalSince(started), wid))
    log("current-vo=\(prop("current-vo")) current-gpu-context=\(prop("current-gpu-context")) display-hidpi-scale=\(prop("display-hidpi-scale"))")

    DispatchQueue.main.sync {
        let window = Unmanaged<NSWindow>.fromOpaque(UnsafeRawPointer(bitPattern: Int(wid))!).takeUnretainedValue()
        log("window class=\(type(of: window)) title=\(window.title) backingScale=\(window.backingScaleFactor) frame=\(window.frame)")
        let content = window.contentView!
        log("contentView=\(type(of: content)) subviews=\(content.subviews.map { "\(type(of: $0)) layer=\(String(describing: $0.layer.map { type(of: $0) }))" })")
        // The app's own input/overlay view, stacked above mpv's video view.
        let mine = NSView(frame: content.bounds)
        mine.autoresizingMask = [.width, .height]
        mine.wantsLayer = true
        mine.layer?.backgroundColor = NSColor.clear.cgColor
        if mode != "noview" {
            content.addSubview(mine, positioned: .above, relativeTo: nil)
            log("added app view above mpv: subviews now \(content.subviews.map { "\(type(of: $0))" })")
        }
    }

    _ = command(["loadfile", "av://lavfi:testsrc2=size=1280x720:rate=30"])
    _ = command(["set", "loop-file", "inf"])
    var deadline = Date().addingTimeInterval(15)
    while Date() < deadline, (Double(prop("playback-time")) ?? 0) < 1.0 { usleep(50_000) }
    log("playback-time=\(prop("playback-time")) estimated-vf-fps=\(prop("estimated-vf-fps")) frame-drop-count=\(prop("frame-drop-count"))")

    let (w, h) = (640, 360)
    let pixels = UnsafeMutableRawPointer.allocate(byteCount: w * h * 4, alignment: 16)
    let p = pixels.bindMemory(to: UInt8.self, capacity: w * h * 4)
    for y in 0..<h { for x in 0..<w {
        let i = (y * w + x) * 4
        let inBox = x > 40 && x < 300 && y > 40 && y < 160
        // premultiplied BGRA: opaque magenta box, half-transparent black elsewhere on the left half, clear right half
        if inBox { p[i] = 255; p[i+1] = 0; p[i+2] = 255; p[i+3] = 255 }
        else if x < w / 2 { p[i] = 0; p[i+1] = 0; p[i+2] = 0; p[i+3] = 128 }
        else { p[i] = 0; p[i+1] = 0; p[i+2] = 0; p[i+3] = 0 }
    } }
    let osd = prop("osd-dimensions")
    log("osd-dimensions=\(osd)")
    let ow = Int(prop("osd-width")) ?? 1280, oh = Int(prop("osd-height")) ?? 720
    let t0 = Date()
    let rc = overlayAdd(pixels, w: w, h: h, dw: ow, dh: oh)
    log(String(format: "overlay-add(%dx%d -> %dx%d) -> %d (%@) in %.1f ms", w, h, ow, oh, rc, String(cString: mpv_error_string(rc)), Date().timeIntervalSince(t0) * 1000))
    // Rough cost of a full-window Retina frame, the size CEF would hand over.
    let (bw, bh) = (2560, 1600)
    let big = UnsafeMutableRawPointer.allocate(byteCount: bw * bh * 4, alignment: 16)
    memset(big, 0, bw * bh * 4)
    var times: [Double] = []
    for _ in 0..<20 { let s = Date(); _ = overlayAdd(big, w: bw, h: bh, dw: ow, dh: oh); times.append(Date().timeIntervalSince(s) * 1000); usleep(16_000) }
    log(String(format: "overlay-add 2560x1600 x20: median %.1f ms max %.1f ms", times.sorted()[10], times.max()!))
    _ = overlayAdd(pixels, w: w, h: h, dw: ow, dh: oh)
    usleep(500_000)
    _ = command(["screenshot-to-file", "\(out)/mpv-window-\(mode).png", "window"])
    let sc = Process(); sc.launchPath = "/usr/sbin/screencapture"; sc.arguments = ["-x", "\(out)/screen-\(mode).png"]
    try? sc.run(); sc.waitUntilExit()

    // Hardware decode check on a real H.264 stream.
    if FileManager.default.fileExists(atPath: "\(out)/h264.mp4") {
        _ = command(["loadfile", "\(out)/h264.mp4"])
        deadline = Date().addingTimeInterval(10)
        while Date() < deadline, (Double(prop("playback-time")) ?? 0) < 1.0 { usleep(50_000) }
        log("h264: hwdec-current=\(prop("hwdec-current")) video-codec=\(prop("video-codec")) playback-time=\(prop("playback-time"))")
    }
    // Native fullscreen through the property, as the controller would set it.
    _ = command(["set", "fullscreen", "yes"]); usleep(1_500_000)
    log("fullscreen property=\(prop("fullscreen"))")
    DispatchQueue.main.async { finish(0) }
}.start()

app.run()
