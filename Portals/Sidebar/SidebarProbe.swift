import Foundation
import QuartzCore

/// Measuring the sidebar and the launch, for scripts/sidebar-bench.sh (docs/perf-sidebar.md).
/// Only a development build reads the switches; elsewhere every call does nothing.
///
/// - `PORTALS_DEBUG_SIDEBAR_PROBE=<file>`: appends a line for each moment of the
///   launch and of the bench, `<ms since the process started> <event> [<ms>]`:
///   `sidebar-row saved|host` the first row of the sidebar on screen, from the list saved
///   last time or once a host answered; `host-listed` a host listed its agents;
///   `avatars-saved` the notification pictures were first saved;
///   `list-merged` a host's list of threads was merged; `chat-shown <turns>` a thread put
///   on screen, and `chat-drawn <ms>` the next frame the main thread could draw after it;
///   `thread-read <ms>` a thread's saved copy read to put it on screen; `fold <ms>` Show
///   more or Show fewer pressed on every open list, with the time until the main thread
///   could draw the next frame; `open-plan-done` the threads `PORTALS_DEBUG_OPEN_PLAN`
///   names all opened; the tabs bench's `tab-switch`, `tab-frame`, `space-step` and
///   `space-frame` (`TabsBench`).
/// - `PORTALS_DEBUG_SIDEBAR_BENCH=1`: every agent and every folder open in the
///   sidebar once the host listed its agents; a Darwin notification
///   `com.danielou.portals.bench.fold` (`notifyutil -p`) presses Show more or Show
///   fewer on every open list at once.
@MainActor
enum SidebarProbe {
    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    /// The switches under their names before the app was Portals too (`AERIPORTAL_`), as
    /// `DebugLaunch` reads them; the new name wins when both are set.
    private static let environment: [String: String] = {
        let given = ProcessInfo.processInfo.environment
        var names = given
        for (key, value) in given where key.hasPrefix("AERIPORTAL_") {
            let current = "PORTALS_" + key.dropFirst("AERIPORTAL_".count)
            if names[current] == nil { names[current] = value }
        }
        return names
    }()
    private static let file: FileHandle? = {
        guard let path = environment["PORTALS_DEBUG_SIDEBAR_PROBE"], !path.isEmpty else { return nil }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        let handle = FileHandle(forWritingAtPath: path)
        _ = handle?.seekToEndOfFile()
        return handle
    }()
    /// When the process started, in seconds since 1970.
    private static let started: TimeInterval = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return Date().timeIntervalSince1970 }
        let start = info.kp_proc.p_starttime
        return TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000
    }()
    private static var marked: Set<String> = []
    private static var frameWaiters: [(event: String, since: CFTimeInterval)] = []
    private static var link: CADisplayLink?
    private static var observer: NSObjectProtocol?

    static var expandsEverything: Bool { environment["PORTALS_DEBUG_SIDEBAR_BENCH"] != nil }

    /// Posted on the main thread when the bench asks for Show more or Show fewer.
    static let fold = Notification.Name("SidebarProbe.fold")

    static func mark(_ event: String, once: Bool = false, detail: @autoclosure () -> String? = nil) {
        guard let file else { return }
        if once {
            guard !marked.contains(event) else { return }
            marked.insert(event)
        }
        let ms = (Date().timeIntervalSince1970 - started) * 1000
        let line = String(format: "%.1f %@%@\n", ms, event, detail().map { " \($0)" } ?? "")
        file.write(Data(line.utf8))
    }

    /// Marks `event` when the main thread is next free to draw a frame, with how long
    /// that took from now.
    static func markNextFrame(_ event: String) {
        guard file != nil else { return }
        frameWaiters.append((event, CACurrentMediaTime()))
        if link == nil {
            let made = CADisplayLink(target: Ticker.shared, selector: #selector(Ticker.tick(_:)))
            made.add(to: .main, forMode: .common)
            link = made
        }
    }

    fileprivate static func ticked() {
        let now = CACurrentMediaTime()
        for waiter in frameWaiters {
            mark(waiter.event, detail: String(format: "%.1f", (now - waiter.since) * 1000))
        }
        frameWaiters = []
        link?.invalidate()
        link = nil
    }

    /// Listens for the bench's Darwin notifications, once.
    static func listen() {
        guard expandsEverything, observer == nil else { return }
        observer = NSObject()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in
                DispatchQueue.main.async { NotificationCenter.default.post(name: SidebarProbe.fold, object: nil) }
            },
            "com.danielou.portals.bench.fold" as CFString, nil, .deliverImmediately
        )
    }

    private final class Ticker: NSObject {
        static let shared = Ticker()
        @objc func tick(_ link: CADisplayLink) {
            MainActor.assumeIsolated { SidebarProbe.ticked() }
        }
    }
    #else
    static var expandsEverything: Bool { false }
    static let fold = Notification.Name("SidebarProbe.fold")
    /// The detail is not worked out: nothing is written.
    static func mark(_ event: String, once: Bool = false, detail: @autoclosure () -> String? = nil) {}
    static func markNextFrame(_ event: String) {}
    static func listen() {}
    #endif
}
