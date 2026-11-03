import SwiftUI

/// Notes a gap in the chat (`PORTALS_DEBUG_GAPS=<file>`): the space kept for a turn, or
/// for a block of turns, that is in view with nothing built in it (`TranscriptTurn`,
/// `TranscriptBlock`). 2026-10-30, on the Mac: "chat rendering is bugged like
/// theres big gaps sometimes", a screen and more of nothing between two replies.
///
/// One JSON line per event, appended to the file:
/// - `gap`: a space with nothing built in it came into view (`kind` turn or block, its
///   turn (a block's first), its height, whether it counted as near, its frame in the
///   scroll view and the scroll view's height, worked out from its own geometry rather
///   than from what the scroll view tells, which is what is in question); `gap-end`: it
///   left the view; `space-gone`: the space was let go of (the row built, or gone);
/// - `near`: a turn or a block came to count as near the screen, or not;
/// - `told`: what the scroll view told a near tracker (`kind` turn or block), or a turn's
///   own frame (`onscreen`), and `turn-kept`/`block-kept` for a "not near" set aside
///   (`RowNearness`); with `PORTALS_DEBUG_GAPS_TRACKERS`, where the tracker's box was last
///   seen.
///
/// Found with it (2026-10-30, a copy of the user's thread on a scratch bridge, the Mac app
/// opened cold and scrolled up with the wheel): a relayed message's turn, 50 points
/// shorter than its estimate, told near at the edge of its reach and "not near" 17 ms
/// later, then nothing more while it crossed the screen, 858 points of nothing for 5.9 s.
///
/// Only a development build in a simulator or on a Mac reads the switch; everywhere else
/// none of the views' probes are there.
@MainActor
enum GapProbe {
    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    static let path = DebugLaunch.gapProbePath
    static var isOn: Bool { path != nil }
    /// `PORTALS_DEBUG_GAPS_TRACKERS`: also where each tracker's box was when it was told.
    static let tracesTrackers = DebugLaunch.gapProbeTracesTrackers

    private static let file: FileHandle? = {
        guard let path else { return nil }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        let handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
        return handle
    }()

    /// The turns and blocks built, by kind (`gapProbeBuilt`).
    static var built: [String: Set<UUID>] = [:]

    /// The last frame of each tracker (`NearTracker`), in the scroll view, and its height.
    static var trackerFrames: [String: (frame: CGRect, view: CGFloat)] = [:]

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
/// Where a space is against the scroll view's bounds, from its own geometry rather than
/// from what the scroll view tells of it (`onScrollVisibilityChange`), which is what is in
/// question.
nonisolated private struct GapPlace: Equatable {
    var inView: Bool
    var frame: CGRect
    var viewHeight: CGFloat

    init(_ proxy: GeometryProxy) {
        frame = proxy.frame(in: .scrollView)
        viewHeight = proxy.bounds(of: .scrollView)?.height ?? 0
        // At least a point of it between the scroll view's top and bottom.
        inView = viewHeight > 0 && frame.height > 0 && frame.maxY > 1 && frame.minY < viewHeight - 1
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        // Changes as the chat scrolls are not news; coming into view and leaving it are.
        lhs.inView == rhs.inView
    }
}

private struct GapProbeSpace: ViewModifier {
    let kind: String
    let id: UUID
    let height: CGFloat
    let near: Bool

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: GapPlace.self) { GapPlace($0) } action: { old, new in
                guard old.inView != new.inView else { return }
                GapProbe.write([
                    "event": new.inView ? "gap" : "gap-end", "kind": kind, "turn": id.uuidString,
                    "height": Int(height), "near": near, "min_y": Int(new.frame.minY),
                    "max_y": Int(new.frame.maxY), "view": Int(new.viewHeight),
                ])
            }
            .onDisappear {
                GapProbe.write(["event": "space-gone", "kind": kind, "turn": id.uuidString, "near": near])
            }
    }
}
#endif

extension View {
    /// The space kept for a turn or a block with nothing built in it, for `GapProbe`;
    /// nothing unless the probe is on.
    @ViewBuilder
    func gapProbeSpace(_ kind: String, turn id: UUID, height: CGFloat, near: Bool) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if GapProbe.isOn { modifier(GapProbeSpace(kind: kind, id: id, height: height, near: near)) } else { self }
        #else
        self
        #endif
    }
}

extension View {
    /// Notes each time a turn or a block counts as near the screen or not, for `GapProbe`;
    /// nothing unless the probe is on.
    @ViewBuilder
    func gapProbeNotesNear(_ kind: String, turn id: UUID, near: Bool) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if GapProbe.isOn {
            onChange(of: near) { _, near in
                GapProbe.write(["event": "near", "kind": kind, "turn": id.uuidString, "near": near])
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
nonisolated private struct TrackerPlace: Equatable {
    var frame: CGRect
    var view: CGFloat
}

private struct GapProbeTracker: ViewModifier {
    let key: String

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: TrackerPlace.self) {
                TrackerPlace(frame: $0.frame(in: .scrollView), view: $0.bounds(of: .scrollView)?.height ?? 0)
            } action: { place in
                GapProbe.trackerFrames[key] = (place.frame, place.view)
            }
    }
}
#endif

extension View {
    /// Where a `NearTracker`'s box is, for `GapProbe`; nothing unless the probe is on.
    @ViewBuilder
    func gapProbeTracker(_ kind: String, turn id: UUID) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if GapProbe.isOn, GapProbe.tracesTrackers { modifier(GapProbeTracker(key: kind + id.uuidString)) } else { self }
        #else
        self
        #endif
    }
}

/// What the scroll view told a `NearTracker`, with where its box was last seen, for `GapProbe`.
@MainActor
func gapProbeTold(_ kind: String, turn id: UUID, near: Bool) {
    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    guard GapProbe.isOn else { return }
    let place = GapProbe.trackerFrames[kind + id.uuidString]
    GapProbe.write([
        "event": "told", "kind": kind, "turn": id.uuidString, "near": near,
        "min_y": place.map { Int($0.frame.minY) } ?? -1, "max_y": place.map { Int($0.frame.maxY) } ?? -1,
        "view": place.map { Int($0.view) } ?? -1,
    ])
    #endif
}

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
private struct GapProbeBuilt: ViewModifier {
    let kind: String
    let id: UUID

    func body(content: Content) -> some View {
        content
            .onAppear { GapProbe.built[kind, default: []].insert(id) }
            .onDisappear { GapProbe.built[kind]?.remove(id) }
    }
}

/// Runs a scroll for the probe each time `<file>.go` appears beside its file: the chat to
/// its first turn at once, then, 3 s later, to its end in an animated scroll of 1 s,
/// writing how many turns and blocks are built before, at the top and 3 s after the end
/// (`scroll-run`). Codex's review of the gaps fix: rows a long animated scroll passed in
/// under the settling time stayed built.
private struct GapProbeScrollRun: ViewModifier {
    let first: () -> AnyHashable?
    let bottom: AnyHashable
    let scrollTo: (AnyHashable, UnitPoint) -> Void

    func body(content: Content) -> some View {
        content.task {
            guard let path = GapProbe.path else { return }
            let go = path + ".go"
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard FileManager.default.fileExists(atPath: go) else { continue }
                try? FileManager.default.removeItem(atPath: go)
                note("start")
                if let first = first() { scrollTo(first, .top) }
                try? await Task.sleep(for: .seconds(3))
                note("top")
                withAnimation(.easeInOut(duration: 1)) { scrollTo(bottom, .bottom) }
                try? await Task.sleep(for: .seconds(4))
                note("end")
            }
        }
    }

    private func note(_ stage: String) {
        GapProbe.write([
            "event": "scroll-run", "stage": stage,
            "turns_built": GapProbe.built["turn"]?.count ?? 0, "blocks_built": GapProbe.built["block"]?.count ?? 0,
        ])
    }
}
#endif

extension View {
    /// A built turn or block, counted for `GapProbe`; nothing unless the probe is on.
    @ViewBuilder
    func gapProbeBuilt(_ kind: String, turn id: UUID) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if GapProbe.isOn { modifier(GapProbeBuilt(kind: kind, id: id)) } else { self }
        #else
        self
        #endif
    }

    /// The chat's scroll for `GapProbe` (`GapProbeScrollRun`); nothing unless the probe is on.
    @ViewBuilder
    func gapProbeScrollRun(first: @escaping () -> AnyHashable?, bottom: AnyHashable, scrollTo: @escaping (AnyHashable, UnitPoint) -> Void) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if GapProbe.isOn { modifier(GapProbeScrollRun(first: first, bottom: bottom, scrollTo: scrollTo)) } else { self }
        #else
        self
        #endif
    }
}
