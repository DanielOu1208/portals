import AppKit

// Leaves and comes back to the scratch copy of the app, for scripts/return-bench.sh,
// without moving the pointer or typing: through NSRunningApplication, as the Dock does.
//
//     swiftc -O -o /private/tmp/portals-n4/bench/return-app scripts/return-bench/app.swift
//     return-app hide <pid>        # the copy hidden (as Command-H)
//     return-app front <pid>       # the copy in front again, shown if it was hidden
//     return-app finder            # Finder in front: the copy is left inactive
//     return-app windows <pid>     # the copy's windows: id, on screen, bounds
let arguments = Array(CommandLine.arguments.dropFirst())
func app(_ pid: String) -> NSRunningApplication {
    guard let pid = Int32(pid), let app = NSRunningApplication(processIdentifier: pid) else {
        FileHandle.standardError.write("no app with pid \(arguments.last ?? "")\n".data(using: .utf8)!)
        exit(1)
    }
    return app
}
switch (arguments.first, arguments.count) {
case ("hide", 2):
    exit(app(arguments[1]).hide() ? 0 : 1)
case ("front", 2):
    let copy = app(arguments[1])
    if copy.isHidden { _ = copy.unhide() }
    exit(copy.activate(options: [.activateAllWindows]) ? 0 : 1)
case ("finder", 1):
    guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { exit(1) }
    exit(finder.activate(options: []) ? 0 : 1)
case ("windows", 2):
    let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    for window in list where (window[kCGWindowOwnerPID as String] as? Int32) == Int32(arguments[1]) {
        let id = window[kCGWindowNumber as String] as? Int ?? 0
        let onScreen = window[kCGWindowIsOnscreen as String] as? Bool ?? false
        let layer = window[kCGWindowLayer as String] as? Int ?? 0
        let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
        print(id, onScreen, layer, Int(bounds["X"] ?? 0), Int(bounds["Y"] ?? 0), Int(bounds["Width"] ?? 0), Int(bounds["Height"] ?? 0))
    }
default:
    FileHandle.standardError.write("usage: return-app hide|front <pid> | finder | windows <pid>\n".data(using: .utf8)!)
    exit(2)
}
