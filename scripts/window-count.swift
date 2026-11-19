// Prints how many normal (layer 0) on-screen windows the process with the
// given PID owns. Reading owner PIDs needs no Screen Recording permission.
import CoreGraphics

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else {
    fatalError("usage: window-count.swift PID")
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let owned = windows.filter {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
}
print(owned.count)
