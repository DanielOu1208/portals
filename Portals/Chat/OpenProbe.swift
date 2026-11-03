import Foundation
import SwiftUI
#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
import QuartzCore
import UIKit
#endif

/// Measures how a thread opens, for scripts/open-bench.sh (`PORTALS_DEBUG_OPEN_PROBE`):
/// for each thread put on screen, every frame over the next three seconds, where the
/// chat is against its end and how tall its content is. From that, one JSON line per
/// opening is appended to the file:
///
/// - `how`: `warm` (still in memory), `saved` (shown from its saved copy: let go, or
///   after a relaunch) or `cold` (nothing of it on the device, fetched from the host);
/// - `content_ms`: from the tap to the first frame that shows any of the thread;
/// - `laid_out_ms`: from the tap to the first frame with the thread laid out, shown or
///   still kept out of sight while it finds its end;
/// - `first_dist`: how far that frame was from the end, in points (0: at the end);
/// - `moves`: how many frames after it the end moved on screen, with nothing touched;
/// - `lags`: how many layouts after it left the chat short of its end, nothing touched
///   (a reply's growth followed a frame late counts here, whatever the frames saw);
/// - `settled_ms`: from the tap to the frame from which the chat stays at its end;
/// - `max_dist`, `final_dist`: the farthest from the end once shown, and at the last frame;
/// - `steps`: when the saved copy was read (`saved_ms`), the host's copy arrived
///   (`fetched_ms`) and was taken in (`adopted_ms`), and how long those took.
///
/// The frames come from a display link on the main thread, so they are frames the main
/// thread could take; the geometry is the scroll view's as of its last layout. Twice a
/// second, the thread on screen and how far it is from its end are also appended to
/// `<file>.watch` (`{"t", "thread", "dist", "content"}`, t in seconds since the probe
/// started), to check that the chat follows a reply, stays where it was scrolled to, and
/// comes back to its end. Only a development build reads the switch; elsewhere every
/// call does nothing.
@MainActor
enum OpenProbe {
    /// Where the chat is, as one frame shows it.
    struct Geometry: Equatable {
        var distance: CGFloat
        var content: CGFloat
        var offset: CGFloat
        var turns: Int

        static let off = Geometry(distance: 0, content: 0, offset: 0, turns: -1)
    }

    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    static let path = DebugLaunch.openProbePath
    static var isOn: Bool { path != nil }

    private static var session: Session?
    private static var latest: (thread: String, geometry: Geometry)?
    private static var hidden: Set<String> = []

    /// A thread is to be shown, `how` as the caller found it.
    static func requested(_ thread: String, how: String) {
        guard isOn else { return }
        startWatching()
        session?.finish()
        latest = nil
        session = Session(thread: thread, how: how)
    }

    /// A step of opening it, timed from the request: `saved` (its saved copy was read),
    /// `fetched` (the host's copy arrived), `adopted` (taken in), with what it took.
    static func step(_ thread: String, _ name: String, took: Duration? = nil) {
        guard let session, session.thread == thread else { return }
        if name == "saved" || name == "cold" { session.how = name }
        session.steps["\(name)_ms"] = (CACurrentMediaTime() - session.started) * 1000
        if let took {
            let (seconds, attoseconds) = took.components
            session.steps["\(name)_took_ms"] = Double(seconds) * 1000 + Double(attoseconds) / 1e15
        }
    }

    static func geometry(_ thread: String?, _ geometry: Geometry) {
        guard let thread, geometry != .off else { return }
        latest = (thread, geometry)
        if let session, session.thread == thread, !hidden.contains(thread) { session.laidOut(geometry) }
    }

    /// The chat is kept out of sight while it finds its end (`ChatScreen`).
    static func hides(_ thread: String?, _ isHidden: Bool) {
        guard isOn, let thread else { return }
        if isHidden { hidden.insert(thread) } else { hidden.remove(thread) }
        // Shown as it was laid out out of sight, with no new layout to say so.
        if !isHidden, let session, session.thread == thread, latest?.thread == thread { session.revealed() }
    }

    private static var watch: Timer?
    private static let watchStarted = CACurrentMediaTime()

    private static func startWatching() {
        guard watch == nil, let path else { return }
        let file = path + ".watch"
        watch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard let latest = OpenProbe.latest else { return }
                let line = String(
                    format: "{\"t\":%.2f,\"thread\":\"%@\",\"dist\":%.0f,\"content\":%.0f}\n",
                    CACurrentMediaTime() - watchStarted, latest.thread, latest.geometry.distance, latest.geometry.content
                )
                if !FileManager.default.fileExists(atPath: file) { FileManager.default.createFile(atPath: file, contents: nil) }
                guard let handle = FileHandle(forWritingAtPath: file) else { return }
                handle.seekToEndOfFile()
                handle.write(Data(line.utf8))
                try? handle.close()
            }
        }
    }

    @MainActor
    private final class Session: NSObject {
        struct Frame {
            var time: Double
            var geometry: Geometry?
            var shown: Bool
        }

        let thread: String
        var how: String
        let started = CACurrentMediaTime()
        var steps: [String: Double] = [:]
        private var frames: [Frame] = []
        /// Layouts of the thread shown in which it was not at its end (`lags`): unlike
        /// `moves`, which looks at frames from a display link, whose order against the
        /// app's own frame updates varies, this counts every layout that left the end
        /// short, before anything scrolled to it, nothing touched.
        private var lags = 0
        private var hasShown = false
        private var link: CADisplayLink?
        private var isFinished = false

        init(thread: String, how: String) {
            self.thread = thread
            self.how = how
            super.init()
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        func revealed() { hasShown = true }

        func laidOut(_ geometry: Geometry) {
            guard !isFinished, geometry.turns > 0, geometry.content > 0 else { return }
            if hasShown, abs(geometry.distance) >= 1 { lags += 1 }
            hasShown = true
        }

        @objc private func tick(_ link: CADisplayLink) {
            let time = CACurrentMediaTime() - started
            let geometry = OpenProbe.latest.flatMap { $0.thread == thread ? $0.geometry : nil }
            frames.append(Frame(time: time, geometry: geometry, shown: !OpenProbe.hidden.contains(thread)))
            if time > 3 { finish() }
        }

        func finish() {
            guard !isFinished else { return }
            isFinished = true
            link?.invalidate()
            link = nil
            if OpenProbe.session === self { OpenProbe.session = nil }
            write()
        }

        private func write() {
            guard let path = OpenProbe.path else { return }
            var line: [String: Any] = ["thread": thread, "how": how, "frames": frames.count]
            let laidOut = frames.first { ($0.geometry?.turns ?? 0) > 0 && ($0.geometry?.content ?? 0) > 0 }
            if let laidOut { line["laid_out_ms"] = Int(laidOut.time * 1000) }
            let shown = frames.enumerated().filter { $0.element.shown && ($0.element.geometry?.turns ?? 0) > 0 && ($0.element.geometry?.content ?? 0) > 0 }
            if let first = shown.first {
                let geometry = first.element.geometry!
                line["content_ms"] = Int(first.element.time * 1000)
                line["first_dist"] = Int(geometry.distance.rounded())
                line["turns"] = geometry.turns
                var moves = 0
                var maxDistance: CGFloat = abs(geometry.distance)
                var previous = geometry.distance
                var trace: [Int] = [Int(geometry.distance.rounded())]
                for frame in frames[(first.offset + 1)...] {
                    guard let now = frame.geometry, frame.shown else { continue }
                    if abs(now.distance - previous) > 0.5 {
                        moves += 1
                        if trace.count < 24 { trace.append(Int(now.distance.rounded())) }
                    }
                    maxDistance = max(maxDistance, abs(now.distance))
                    previous = now.distance
                }
                line["moves"] = moves
                line["lags"] = lags
                line["max_dist"] = Int(maxDistance.rounded())
                line["final_dist"] = Int(previous.rounded())
                line["trace"] = trace
                // The first shown frame from which every later one is at the end.
                var settled: Double?
                for frame in frames[first.offset...].reversed() where frame.shown {
                    guard let now = frame.geometry, abs(now.distance) < 1 else { break }
                    settled = frame.time
                }
                if let settled { line["settled_ms"] = Int(settled * 1000) }
                line["content_height"] = Int((frames.last?.geometry?.content ?? 0).rounded())
            }
            for (name, value) in steps { line[name] = Int(value.rounded()) }
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
            if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
            guard let file = FileHandle(forWritingAtPath: path) else { return }
            file.seekToEndOfFile()
            file.write(data + Data("\n".utf8))
            try? file.close()
        }
    }
    #else
    static var isOn: Bool { false }
    static func requested(_ thread: String, how: String) {}
    static func step(_ thread: String, _ name: String, took: Duration? = nil) {}
    static func geometry(_ thread: String?, _ geometry: Geometry) {}
    static func hides(_ thread: String?, _ isHidden: Bool) {}
    #endif
}

extension View {
    /// Tells the open probe where the chat is, frame by frame, while it is the one on screen
    /// (`isShown`; a chat kept out of sight says where it is again as it comes back).
    /// Nothing unless the probe is on.
    func reportsOpening(of thread: String?, turns: Int, isShown: Bool = true) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        modifier(ReportsOpening(thread: thread, turns: turns, isShown: isShown))
        #else
        self
        #endif
    }
}

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
private struct ReportsOpening: ViewModifier {
    let thread: String?
    let turns: Int
    let isShown: Bool

    /// The chat's last geometry, said again as it comes back on screen.
    private final class Last {
        var geometry = OpenProbe.Geometry.off
    }
    @State private var last = Last()

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: OpenProbe.Geometry.self) { geometry in
                guard OpenProbe.isOn else { return .off }
                // A chat shorter than its screen is at its end, wherever it is drawn. The
                // container is the room between the bars already (`ScrollExtent.fits`).
                let fits = geometry.contentSize.height <= geometry.containerSize.height + 1
                return OpenProbe.Geometry(
                    distance: fits ? 0 : geometry.contentSize.height - (geometry.visibleRect.maxY - geometry.contentInsets.bottom),
                    content: geometry.contentSize.height,
                    offset: geometry.contentOffset.y,
                    turns: turns
                )
            } action: { _, new in
                last.geometry = new
                if isShown { OpenProbe.geometry(thread, new) }
            }
            .onChange(of: isShown) { _, shown in
                if shown { OpenProbe.geometry(thread, last.geometry) }
            }
    }
}
#endif
