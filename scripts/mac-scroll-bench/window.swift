// Prints the largest on-screen window of a process: `<id> <x> <y> <width> <height>`
// in global points, top-left origin. Part of scripts/mac-scroll-bench.sh.
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
let best = mine.max { a, b in
    let ra = a[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    let rb = b[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    return (ra["Width"] ?? 0) * (ra["Height"] ?? 0) < (rb["Width"] ?? 0) * (rb["Height"] ?? 0)
}
guard let best, let bounds = best[kCGWindowBounds as String] as? [String: CGFloat] else { exit(1) }
print(best[kCGWindowNumber as String] as! Int, Int(bounds["X"]!), Int(bounds["Y"]!), Int(bounds["Width"]!), Int(bounds["Height"]!))
