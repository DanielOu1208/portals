import SwiftUI
#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
import QuartzCore
import UIKit
#endif

/// Notes a chat shown blank (`PORTALS_DEBUG_BLANK=<file>`): on screen (not kept out of
/// sight while it finds its end, nor slid aside for the sidebar), with turns, and with
/// none of its turns in the part of the scroll view between its bars, for more than a
/// few frames, wherever it is scrolled (`dist` says how far from its end: a lazy stack
/// collapsed under it leaves a chat that fits its screen). Seen on an iPhone
/// (2026-10-19): a thread opened from the sidebar showed nothing but the subagents line
/// under it until scrolled by hand. The safety nets look only at the distance from the
/// end, which is 0 there, and the open probe counts such a frame as showing the thread.
///
/// Each turn tells the probe when the lazy stack builds it and lets go of it, where it is
/// in the scroll view (`frame(in: .scrollView)`) and whether the scroll view counts it as
/// visible (`onScrollVisibilityChange`), into a box that nothing draws; a display link
/// looks at the box once a frame. One JSON line per event is appended to the file:
///
/// - `open`: a chat appeared; `shown`: it stopped being kept out of sight; `state`: how it
///   was 1.5 s after it was first shown with turns, blank or not;
/// - `blank`: the state above held for 3 frames; `persist`: still so 0.5 s, 1 s, 2 s
///   and 5 s after it began; `clear`: it ended, `ms` after it began, `by` what: `hand`
///   (scrolled), `repair` (the repair below, `repair_ms` after it began), `aside` (the
///   chat slid aside for the sidebar, or another thread opened, still blank), `self`;
/// - each with the thread, its turn count, the scroll geometry (content height, offset,
///   container, insets, distance from the end), how many turns are in view by their
///   frames (`in_view`) and by the scroll view's count (`visible`), which turns the lazy
///   stack has built (indexes, `built`), and the frames of the last turn, the lazy stack
///   and the end marker in the scroll view's space, and the UIKit scroll view's offset
///   and content height.
///
/// `PORTALS_DEBUG_BLANK_FIX`: what to do once it is seen (`BlankProbe.Repair`), to try
/// repairs. Off by default; only a development build in a simulator or on a Mac reads
/// either switch, and everywhere else none of the views' probes are there.
@MainActor
enum BlankProbe {
    /// What to try on a blank chat, `PORTALS_DEBUG_BLANK_FIX`.
    enum Repair: String {
        /// `proxy.scrollTo(last turn, anchor: .bottom)`.
        case last
        /// To the last turn, then to the end marker, as `ChatScreen.settle` does.
        case lastEnd = "last-end"
        /// To the last turn, then at the next display frame to the end marker.
        case lastThenEnd = "last-then-end"
        /// To the end marker alone.
        case end
        /// To the turn before the last, then a frame later back to the end marker.
        case previous
        /// The UIKit scroll view moved up 1 point, and a frame later back.
        case nudge
        /// The same within one frame: 1 point up and back at once.
        case nudgeNow = "nudge-now"
        /// A UIKit layout pass of the scroll view, nothing moved.
        case layout
    }

    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    static let path = DebugLaunch.blankProbePath
    static let repair = DebugLaunch.blankRepair.flatMap(Repair.init(rawValue:))
    static let traces = DebugLaunch.blankTraces
    static var isOn: Bool { path != nil }

    private static let file: FileHandle? = {
        guard let path else { return nil }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        let handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
        return handle
    }()

    static func write(_ fields: [String: Any]) {
        var line = fields
        line["t"] = (Date().timeIntervalSince1970 * 1000).rounded() / 1000
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        file?.write(data + Data("\n".utf8))
    }
    #else
    static var isOn: Bool { false }
    #endif
}

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
/// What one chat's probe knows, written by the views and read by the display link.
@MainActor
final class BlankWatch: NSObject {
    struct Geometry: Equatable {
        var content: CGFloat = 0
        var container: CGFloat = 0
        var offset: CGFloat = 0
        var insetTop: CGFloat = 0
        var insetBottom: CGFloat = 0

        init() {}

        init(_ geometry: ScrollGeometry) {
            content = geometry.contentSize.height
            container = geometry.containerSize.height
            offset = geometry.contentOffset.y
            insetTop = geometry.contentInsets.top
            insetBottom = geometry.contentInsets.bottom
        }

        /// As `ScrollExtent.distanceFromEnd`. The container is the part between the bars
        /// (the scroll view's bounds less its insets), and the offset that of the bounds'
        /// top, under the top bar.
        var distance: CGFloat { content - (offset + insetTop + container) }
    }

    var thread: String?
    var turnIDs: [UUID] = []
    var hidden = true
    var aside = false
    var geometry = Geometry()
    var phase: ScrollPhase = .idle
    var built: Set<UUID> = []
    var visible: Set<UUID> = []
    var frames: [UUID: CGRect] = [:]
    var marks: [String: CGRect] = [:]
    weak var scrollView: UIScrollView?
    /// Moves the chat for a repair: to an id, at the bottom.
    var scrollTo: ((AnyHashable) -> Void)?
    var bottomID: AnyHashable?

    private var link: CADisplayLink?
    private var blankFrames = 0
    private var episode: Episode?
    private var opened = CACurrentMediaTime()
    private var shownWithTurns: Double?
    private var stateWritten = false
    /// What a repair does at the next display frame.
    private var nextFrame: (() -> Void)?

    private struct Episode {
        var started: Double
        var touched = false
        var repaired: Double?
        var persisted: [Double] = []
    }

    func start() {
        guard link == nil else { return }
        opened = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        BlankProbe.write(["event": "open", "thread": thread ?? "-", "turns": turnIDs.count])
    }

    func stop() {
        link?.invalidate()
        link = nil
        if let episode { end(episode, by: "gone") }
        episode = nil
    }

    func shown() {
        BlankProbe.write(["event": "shown", "thread": thread ?? "-", "turns": turnIDs.count, "ms": Int((CACurrentMediaTime() - opened) * 1000)])
    }

    func touched() {
        episode?.touched = true
    }

    /// How many built turns are between the bars, by their frames: the scroll view's
    /// space (`.scrollView`) is the part between them, from 0 to the container's height.
    private var inView: Int {
        frames.reduce(0) { count, entry in
            built.contains(entry.key) && entry.value.maxY > 1 && entry.value.minY < geometry.container - 1 ? count + 1 : count
        }
    }

    /// Writes the scroll geometry as it changes over the first seconds of a chat, with
    /// `PORTALS_DEBUG_BLANK_TRACE`.
    func tracedGeometry() {
        guard BlankProbe.traces, CACurrentMediaTime() - opened < 4 else { return }
        var line: [String: Any] = [
            "event": "geo", "ms": Int((CACurrentMediaTime() - opened) * 1000), "offset": Self.rounded(geometry.offset),
            "content": Self.rounded(geometry.content), "dist": Self.rounded(geometry.distance), "hidden": hidden,
            "built": Self.ranges(turnIDs.indices.filter { built.contains(turnIDs[$0]) }),
        ]
        if let scrollView { line["ui_id"] = String(UInt(bitPattern: ObjectIdentifier(scrollView).hashValue), radix: 16) }
        BlankProbe.write(line)
    }

    /// Writes when a turn is built or let go of, over the first seconds of a chat, with
    /// `PORTALS_DEBUG_BLANK_TRACE`.
    func traced(_ what: String, _ id: UUID) {
        guard BlankProbe.traces, CACurrentMediaTime() - opened < 4, let index = turnIDs.firstIndex(of: id) else { return }
        var line: [String: Any] = [
            "event": what, "turn": index, "ms": Int((CACurrentMediaTime() - opened) * 1000),
            "offset": Self.rounded(geometry.offset), "content": Self.rounded(geometry.content), "hidden": hidden,
        ]
        if let frame = frames[id] { line["frame"] = Self.rect(frame) }
        BlankProbe.write(line)
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if let action = nextFrame {
            nextFrame = nil
            action()
        }
        // Once, 1.5 s after the chat is shown with its turns, how it is, blank or not.
        if !hidden, !turnIDs.isEmpty {
            if shownWithTurns == nil { shownWithTurns = now }
            if let shownWithTurns, !stateWritten, now - shownWithTurns >= 1.5 {
                stateWritten = true
                write("state", ms: Int((now - shownWithTurns) * 1000))
            }
        }
        // Any distance from the end: a lazy stack collapsed under a chat that then fits
        // its screen is at no end at all.
        let blank = !hidden && !aside && !turnIDs.isEmpty && geometry.container > 0 && inView == 0
        guard blank else {
            blankFrames = 0
            if let episode {
                // Slid aside for the sidebar (or hidden), it was left blank.
                let cause = aside || hidden ? "aside" : episode.touched ? "hand" : episode.repaired != nil ? "repair" : "self"
                end(episode, by: cause)
                self.episode = nil
            }
            return
        }
        blankFrames += 1
        if episode == nil, blankFrames >= 3 {
            episode = Episode(started: now)
            write("blank", ms: 0)
            if let repair = BlankProbe.repair { apply(repair) }
        }
        guard var current = episode else { return }
        let age = now - current.started
        if let mark = [0.5, 1, 2, 5].first(where: { age >= $0 && !current.persisted.contains($0) }) {
            current.persisted.append(mark)
            episode = current
            write("persist", ms: Int(age * 1000))
        }
    }

    private func end(_ episode: Episode, by cause: String) {
        var extra: [String: Any] = ["by": cause]
        if let repaired = episode.repaired { extra["repair_ms"] = Int((repaired - episode.started) * 1000) }
        write("clear", ms: Int((CACurrentMediaTime() - episode.started) * 1000), extra: extra)
    }

    private func apply(_ repair: BlankProbe.Repair) {
        episode?.repaired = CACurrentMediaTime()
        let last = turnIDs.last
        switch repair {
        case .last:
            if let last { scrollTo?(last) }
        case .lastEnd:
            if let last { scrollTo?(last) }
            if let bottomID { scrollTo?(bottomID) }
        case .lastThenEnd:
            if let last { scrollTo?(last) }
            nextFrame = { [weak self] in
                if let bottomID = self?.bottomID { self?.scrollTo?(bottomID) }
            }
        case .end:
            if let bottomID { scrollTo?(bottomID) }
        case .previous:
            if turnIDs.count >= 2 { scrollTo?(turnIDs[turnIDs.count - 2]) }
            Task { @MainActor in
                if let bottomID = self.bottomID { self.scrollTo?(bottomID) }
            }
        case .nudge:
            guard let scrollView else { break }
            let y = scrollView.contentOffset.y
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: y - 1), animated: false)
            Task { @MainActor in
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: y), animated: false)
            }
        case .nudgeNow:
            guard let scrollView else { break }
            let y = scrollView.contentOffset.y
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: y - 1), animated: false)
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: y), animated: false)
        case .layout:
            scrollView?.setNeedsLayout()
            scrollView?.layoutIfNeeded()
        }
        write("repair", ms: Int((CACurrentMediaTime() - (episode?.started ?? CACurrentMediaTime())) * 1000), extra: ["repair": repair.rawValue])
    }

    private func write(_ event: String, ms: Int, extra: [String: Any] = [:]) {
        var line: [String: Any] = [
            "event": event, "ms": ms, "thread": thread ?? "-", "turns": turnIDs.count,
            "content": Self.rounded(geometry.content), "offset": Self.rounded(geometry.offset), "container": Self.rounded(geometry.container),
            "inset_top": Self.rounded(geometry.insetTop), "inset_bottom": Self.rounded(geometry.insetBottom),
            "dist": Self.rounded(geometry.distance), "in_view": inView, "visible": visible.count,
            "built": Self.ranges(turnIDs.indices.filter { built.contains(turnIDs[$0]) }),
            "phase": "\(phase)", "since_open_ms": Int((CACurrentMediaTime() - opened) * 1000),
        ]
        if let last = turnIDs.last, let frame = frames[last], built.contains(last) { line["last_frame"] = Self.rect(frame) }
        for (key, frame) in marks { line["\(key)_frame"] = Self.rect(frame) }
        if let scrollView {
            line["ui_offset"] = Self.rounded(scrollView.contentOffset.y)
            line["ui_content"] = Self.rounded(scrollView.contentSize.height)
            line["ui_bounds"] = Self.rounded(scrollView.bounds.height)
            line["ui_id"] = String(UInt(bitPattern: ObjectIdentifier(scrollView).hashValue), radix: 16)
            if event != "persist" { line.merge(Self.uikit(scrollView)) { _, new in new } }
        }
        line.merge(extra) { _, new in new }
        BlankProbe.write(line)
    }

    /// What UIKit has in the scroll view: its subviews (kind, top and height against the
    /// visible top, opacity as drawn), the visuals' views (`WidgetHostView`) found in it
    /// with where they are and their opacity down from the scroll view, and the opacity of
    /// the scroll view's own ancestors up to the window.
    private static func uikit(_ scrollView: UIScrollView) -> [String: Any] {
        func opacity(_ layer: CALayer) -> Double { Double((layer.presentation() ?? layer).opacity) }
        let top = scrollView.contentOffset.y
        let subviews = scrollView.subviews.map { view -> String in
            let name = String(describing: type(of: view)).suffix(24)
            return "\(name) \(Int(view.frame.minY - top)) \(Int(view.frame.height)) a\(String(format: "%.2f", view.alpha)) o\(String(format: "%.2f", opacity(view.layer)))\(view.isHidden ? " hidden" : "")"
        }
        var hosts: [String] = []
        func walk(_ view: UIView, _ alpha: Double) {
            for child in view.subviews {
                let shown = alpha * Double(child.alpha) * opacity(child.layer) * (child.isHidden ? 0 : 1)
                if child is WidgetHostView {
                    let frame = child.convert(child.bounds, to: scrollView)
                    hosts.append("\(Int(frame.minY - top)) \(Int(frame.height)) o\(String(format: "%.2f", shown)) w\(child.window != nil ? 1 : 0)")
                }
                walk(child, shown)
            }
        }
        walk(scrollView, 1)
        var ancestors: [String] = []
        var view = scrollView.superview
        while let current = view, ancestors.count < 12 {
            let value = Double(current.alpha) * opacity(current.layer)
            if value < 0.99 || current.isHidden { ancestors.append("\(String(describing: type(of: current)).suffix(20)) o\(String(format: "%.2f", value))\(current.isHidden ? " hidden" : "")") }
            view = current.superview
        }
        return ["ui_subviews": subviews, "ui_visuals": hosts, "ui_faded": ancestors, "ui_layers": scrollView.layer.sublayers?.count ?? 0]
    }

    private static func rounded(_ value: CGFloat) -> Double { (Double(value) * 10).rounded() / 10 }
    private static func rect(_ rect: CGRect) -> [Double] { [rounded(rect.minY), rounded(rect.height)] }

    /// "0-2,40-44" for [0, 1, 2, 40, 41, 42, 43, 44].
    private static func ranges(_ indexes: [Int]) -> String {
        var parts: [String] = []
        var start: Int?
        var previous = -2
        for index in indexes {
            if index != previous + 1 {
                if let start { parts.append(start == previous ? "\(start)" : "\(start)-\(previous)") }
                start = index
            }
            previous = index
        }
        if let start { parts.append(start == previous ? "\(start)" : "\(start)-\(previous)") }
        return parts.joined(separator: ",")
    }
}

extension EnvironmentValues {
    @Entry var blankWatch: BlankWatch?
}

/// The chat's side of the probe, on its scroll view.
private struct BlankProbeScroll: ViewModifier {
    let thread: String?
    let turnIDs: [UUID]
    let hidden: Bool
    let bottomID: AnyHashable

    @State private var watch = BlankWatch()
    @Environment(\.chatIsAside) private var aside

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .environment(\.blankWatch, watch)
                .onScrollGeometryChange(for: BlankWatch.Geometry.self) { BlankWatch.Geometry($0) } action: { _, new in
                    watch.geometry = new
                    watch.tracedGeometry()
                }
                .onScrollPhaseChange { _, phase in
                    watch.phase = phase
                    if phase == .interacting { watch.touched() }
                }
                .onChange(of: turnIDs, initial: true) { _, ids in watch.turnIDs = ids }
                .onChange(of: aside, initial: true) { _, aside in watch.aside = aside }
                .onChange(of: hidden, initial: true) { old, hides in
                    watch.hidden = hides
                    if old, !hides { watch.shown() }
                }
                .onAppear {
                    watch.thread = thread
                    watch.bottomID = bottomID
                    watch.scrollTo = { id in proxy.scrollTo(id, anchor: .bottom) }
                    watch.start()
                    if !hidden { watch.shown() }
                }
                .onDisappear { watch.stop() }
        }
    }
}

/// A turn's side: built, let go of, where it is, whether it is counted visible.
private struct BlankProbeTurn: ViewModifier {
    let id: UUID
    @Environment(\.blankWatch) private var watch

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView) } action: { watch?.frames[id] = $0 }
            .onScrollVisibilityChange(threshold: 0.01) { isVisible in
                if isVisible { watch?.visible.insert(id) } else { watch?.visible.remove(id) }
            }
            .onAppear {
                watch?.built.insert(id)
                watch?.traced("built", id)
            }
            .onDisappear {
                watch?.traced("let-go", id)
                watch?.built.remove(id)
                watch?.visible.remove(id)
                watch?.frames[id] = nil
            }
    }
}

/// Where a part of the chat (the lazy stack, the end marker) is in the scroll view.
private struct BlankProbeMark: ViewModifier {
    let key: String
    @Environment(\.blankWatch) private var watch

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView) } action: { watch?.marks[key] = $0 }
    }
}

/// Finds the UIKit scroll view the chat is drawn in, for its offset and the repairs.
private struct BlankScrollFinder: UIViewRepresentable {
    let watch: BlankWatch?

    final class Finder: UIView {
        weak var watch: BlankWatch?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            var view = superview
            while let current = view, !(current is UIScrollView) { view = current.superview }
            if let scrollView = view as? UIScrollView { watch?.scrollView = scrollView }
        }
    }

    func makeUIView(context: Context) -> Finder {
        let finder = Finder()
        finder.watch = watch
        finder.isUserInteractionEnabled = false
        return finder
    }

    func updateUIView(_ finder: Finder, context: Context) {
        finder.watch = watch
    }
}

private struct BlankProbeFinder: ViewModifier {
    @Environment(\.blankWatch) private var watch

    func body(content: Content) -> some View {
        content.background(BlankScrollFinder(watch: watch).accessibilityHidden(true))
    }
}
#endif

extension View {
    /// The chat's scroll view's side of `BlankProbe`; nothing unless the probe is on.
    @ViewBuilder
    func blankProbe(thread: String?, turnIDs: @autoclosure () -> [UUID], hidden: Bool, bottomID: AnyHashable) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if BlankProbe.isOn {
            modifier(BlankProbeScroll(thread: thread, turnIDs: turnIDs(), hidden: hidden, bottomID: bottomID))
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// A turn's side of `BlankProbe`; nothing unless the probe is on.
    @ViewBuilder
    func blankProbeTurn(_ id: UUID) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if BlankProbe.isOn { modifier(BlankProbeTurn(id: id)) } else { self }
        #else
        self
        #endif
    }

    /// Where this part of the chat is, for `BlankProbe`; nothing unless the probe is on.
    @ViewBuilder
    func blankProbeMark(_ key: String) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if BlankProbe.isOn { modifier(BlankProbeMark(key: key)) } else { self }
        #else
        self
        #endif
    }

    /// Finds the chat's UIKit scroll view for `BlankProbe`, from inside it; nothing unless
    /// the probe is on.
    @ViewBuilder
    func blankProbeFindsScrollView() -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if BlankProbe.isOn { modifier(BlankProbeFinder()) } else { self }
        #else
        self
        #endif
    }
}
