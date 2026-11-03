import AppKit

// An opaque window over a rectangle of the screen for a few seconds, shown without
// activating anything or moving the pointer: for measuring the app with its window
// covered (docs/perf-app.md).
//
//     swiftc -O -o /private/tmp/cover scripts/app-footprint/cover.swift
//     /private/tmp/cover <x> <y> <width> <height> <seconds>    # top-left origin, in points
let a = CommandLine.arguments.dropFirst().map { Double($0)! }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.screens[0].frame
let rect = NSRect(x: a[0], y: screen.height - a[1] - a[3], width: a[2], height: a[3])
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.backgroundColor = .gray
window.isOpaque = true
window.ignoresMouseEvents = true
window.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + a[4]) { exit(0) }
app.run()
