#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
import QuartzCore
import UIKit

/// Measures how well the app's main thread keeps up with the display, for
/// scripts/mac-scroll-bench.sh (`PORTALS_DEBUG_FRAMES`). A display link on the main
/// thread notes each call it gets; one later than half a frame past when it was due
/// counts as a hitch, and the time it is late as hitch time. It sees the main thread
/// only: a frame the render server presents late while the main thread is free is not
/// counted, as Instruments' hitch time would. About once a second it appends
///
///     <seconds since start> <frames> <hitches> <hitch ms> <longest frame ms>
///
/// to the file. Only a development build reads the switch.
@MainActor
final class FrameMeter: NSObject {
    private static var running: FrameMeter?

    static func start(writingTo path: String) {
        guard running == nil else { return }
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let file = FileHandle(forWritingAtPath: path) else { return }
        let meter = FrameMeter(file: file)
        running = meter
        let link = CADisplayLink(target: meter, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
    }

    private let file: FileHandle
    private let started = CACurrentMediaTime()
    private var lastTimestamp: CFTimeInterval?
    private var lastDuration: CFTimeInterval = 1.0 / 60
    private var secondStarted = CACurrentMediaTime()
    private var frames = 0
    private var hitches = 0
    private var hitchTime: CFTimeInterval = 0
    private var longest: CFTimeInterval = 0

    private init(file: FileHandle) {
        self.file = file
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if let last = lastTimestamp {
            let interval = now - last
            // The frame was due one display period after the last; late by more than
            // half a period, the frames between were missed.
            let late = interval - lastDuration
            if late > lastDuration / 2 {
                hitches += 1
                hitchTime += late
            }
            longest = max(longest, interval)
            frames += 1
        }
        lastTimestamp = now
        lastDuration = max(link.targetTimestamp - link.timestamp, 1.0 / 240)
        if now - secondStarted >= 1 {
            let line = String(format: "%.1f %d %d %.1f %.1f\n", now - started, frames, hitches, hitchTime * 1000, longest * 1000)
            file.write(Data(line.utf8))
            secondStarted = now
            frames = 0
            hitches = 0
            hitchTime = 0
            longest = 0
        }
    }
}
#endif

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
/// Counts the frames the wash draws, for scripts/wash-bench.sh
/// (`PORTALS_DEBUG_WASH_FRAMES`). About once a second, while it draws, it appends
///
///     <Unix time> <frames> <ms drawing> <longest ms>
///
/// where the milliseconds are those the wash's own drawing took on its thread (0 where
/// the system draws it, as SwiftUI does a MeshGradient). Only a development build
/// reads the switch.
nonisolated final class WashMeter: @unchecked Sendable {
    static let shared: WashMeter? = DebugLaunch.washFramesPath.flatMap(WashMeter.init(path:))

    private let lock = NSLock()
    private let file: FileHandle
    private var secondStarted = CACurrentMediaTime()
    private var frames = 0
    private var busy: CFTimeInterval = 0
    private var longest: CFTimeInterval = 0

    private init?(path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let file = FileHandle(forWritingAtPath: path) else { return nil }
        self.file = file
    }

    /// A frame drawn, that took `seconds` of drawing.
    func note(_ seconds: CFTimeInterval = 0) {
        lock.lock()
        defer { lock.unlock() }
        let now = CACurrentMediaTime()
        frames += 1
        busy += seconds
        longest = max(longest, seconds)
        guard now - secondStarted >= 1 else { return }
        let line = String(format: "%.3f %d %.2f %.2f\n", Date().timeIntervalSince1970, frames, busy * 1000, longest * 1000)
        file.write(Data(line.utf8))
        secondStarted = now
        frames = 0
        busy = 0
        longest = 0
    }
}
#endif
