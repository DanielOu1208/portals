import AgentCore
import os
import SwiftUI
import UIKit

/// The transcript keeps explicit space for every turn, but renders only those near the
/// viewport. Unlike a lazy stack's moving average, an unseen turn's estimate stays put
/// when another turn is measured. Returning to a measured turn keeps its exact space.
///
/// Every turn of the thread is in the stack, so each is compared when the chat is drawn
/// again, at every streamed word: by what it shows (`shows`, compared as `TurnView` is),
/// as its content closure cannot be compared. Without that, every turn's body ran again
/// at every word, an offscreen one included.
struct TranscriptTurn<Content: View>: View, Equatable {
    let heights: TranscriptHeights
    let keepsBuilt: Bool
    let shows: TurnView
    @ViewBuilder var content: () -> Content

    private var turn: Turn { shows.turn }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.keepsBuilt == rhs.keepsBuilt && lhs.shows == rhs.shows
    }

    @Environment(\.widgetLayoutWidth) private var width
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.transcriptAnchor) private var anchor
    /// Near the screen (`NearTracker`), and on it (`tellsAnchor`): built when either is
    /// (`RowNearness`).
    @State private var nearness = RowNearness()
    @State private var renderedSize: CGSize?

    private var isNear: Bool { nearness.isNear }

    var body: some View {
        Group {
            if nearness.isBuilt(kept: keepsBuilt, onScreenCounts: !DebugLaunch.leavesOutGapsFix(.onScreen)) {
                content()
                    .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                        renderedSize = size
                        remember(size)
                    }
                    .onChange(of: turn) { if let renderedSize { remember(renderedSize) } }
                    .onChange(of: typeSize) { if let renderedSize { remember(renderedSize) } }
                    .environment(\.turnIsNear, nearness.isBuilt())
                    .gapProbeBuilt("turn", turn: turn.id)
            } else {
                let height = heights.height(for: turn, width: width, typeSize: typeSize)
                Color.clear
                    .frame(height: height)
                    .accessibilityHidden(true)
                    .gapProbeSpace("turn", turn: turn.id, height: height, near: isNear)
            }
        }
        .gapProbeNotesNear("turn", turn: turn.id, near: isNear)
        .frame(maxWidth: .infinity, alignment: .leading)
        // A turn above the screen that changes height (built from its estimate, a picture
        // or a visual come, the window's width) moves what is read under it by as much,
        // unless the chat's offset moves with it (`TranscriptAnchor`).
        .tellsAnchor(anchor, turn: turn.id) { visible in
            if visible, !nearness.isNear, !keepsBuilt {
                AppLog.scroll.notice("turn \(turn.id.uuidString.prefix(8), privacy: .public) on screen though not told near: built")
            }
            if nearness.isOnScreen != visible { nearness.isOnScreen = visible }
        }
        // Near: within twice `WidgetSizing.nearby` of the screen, told by the scroll view
        // for a box that much taller than the turn, rather than worked out by each turn
        // from its place at every frame the chat scrolls or a reply moves it.
        .background { NearTracker(nearness: $nearness, reach: WidgetSizing.nearby * 2, probe: ("turn", turn.id)) }
    }

    private func remember(_ size: CGSize) {
        heights.record(size.height, turn: turn, width: size.width, typeSize: typeSize)
    }
}

extension EnvironmentValues {
    /// Whether the turn a view is in is near the screen (`TranscriptTurn`): one kept built
    /// is built far from it too, and is not, for telling a chat left blank (`BuiltTurns`).
    @Entry var turnIsNear = true
}

/// Lightweight measurements live with the thread, separately from rendered rows and
/// WebKit pages. Changed content or text size gets a new measurement; on resize an
/// old height remains a stable estimate until that row is laid out at its new width.
@MainActor
final class TranscriptHeights {
    private struct Entry {
        var turn: Turn
        var width: CGFloat
        var typeSize: DynamicTypeSize
        var height: CGFloat
        /// Measured as laid out, rather than estimated.
        var measured = false
        /// The scroll log has said it was kept for a turn changed since: said once, not at
        /// each read until the turn is measured again.
        var keptLogged = false
    }

    private var entries: [UUID: Entry] = [:]

    /// Lets go of the heights of these turns: measured with folds open that will not be.
    func forget(_ ids: some Sequence<UUID>) {
        for id in ids { entries[id] = nil }
    }

    func keep(_ ids: Set<UUID>) { entries = entries.filter { ids.contains($0.key) } }

    func height(for turn: Turn, width: CGFloat, typeSize: DynamicTypeSize) -> CGFloat {
        if let entry = entries[turn.id], entry.turn == turn, entry.typeSize == typeSize,
           entry.width > 0 || width == 0 {
            return entry.height
        }
        // A turn that changed since it was measured, out of sight (its footer's time and
        // tokens come as it ends), keeps the height it was measured at until it is laid out
        // again: nearer than an estimate, which counts a reply's lines but not its images,
        // and which left space under the last reply after a fast scroll down to it.
        if let entry = entries[turn.id], entry.typeSize == typeSize, entry.width > 0, abs(entry.width - width) < 1 {
            if !entry.keptLogged {
                AppLog.scroll.notice("turn \(turn.id.uuidString.prefix(8), privacy: .public) changed out of sight: kept \(Int(entry.height), privacy: .public) (\(entry.measured ? "measured" : "estimate", privacy: .public))")
                entries[turn.id]?.keptLogged = true
            }
            return entry.height
        }
        let height = estimate(turn, width: width)
        entries[turn.id] = Entry(turn: turn, width: width, typeSize: typeSize, height: height)
        return height
    }

    func record(_ height: CGFloat, turn: Turn, width: CGFloat, typeSize: DynamicTypeSize) {
        guard height.isFinite, height > 0, width > 0 else { return }
        if let before = entries[turn.id], abs(before.height - height) >= 20 {
            AppLog.scroll.notice("turn \(turn.id.uuidString.prefix(8), privacy: .public) measured \(Int(before.height), privacy: .public) -> \(Int(height), privacy: .public) (\(Int(height - before.height), privacy: .public)); was \(before.measured ? "measured" : "estimate", privacy: .public)\(before.turn == turn ? "" : ", turn changed", privacy: .public)")
        }
        entries[turn.id] = Entry(turn: turn, width: width, typeSize: typeSize, height: height, measured: true)
    }

    /// Whether a line of a reply is an image on a line of its own, `![caption](path)`.
    private static func isImage(_ line: Substring) -> Bool {
        line.hasPrefix("![") && line.contains("](") && line.trimmingCharacters(in: .whitespaces).hasSuffix(")")
    }

    /// Only a first visit needs an estimate. Count prose without parsing Markdown or
    /// laying out offscreen text; HTML inside a visual takes one card, not code lines.
    private func estimate(_ turn: Turn, width: CGFloat) -> CGFloat {
        let font = UIFont.preferredFont(forTextStyle: .body)
        let columns = max(12, Int(max(width, 100) / (font.pointSize * 0.52)))
        var height: CGFloat = 0
        for piece in TurnLayout.layout(for: turn).pieces {
            height += Theme.grid * 2
            switch piece {
            case .steps:
                height += font.lineHeight
            case let .item(item):
                switch item.content {
                case let .text(text):
                    var visual: MarkdownWidget?
                    var visualMark: Character?
                    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                        let trimmed = line.drop(while: { $0 == " " })
                        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~"), let mark = trimmed.first {
                            let marks = trimmed.prefix(while: { $0 == mark })
                            let info = trimmed.dropFirst(marks.count).trimmingCharacters(in: .whitespaces)
                            if var card = visual, mark == visualMark, info.isEmpty {
                                if card.source.hasSuffix("\n") { card.source.removeLast() }
                                let remembered = WidgetHeightStore.shared.height(for: card.sourceHash, width: width)
                                height += WidgetSizing.shown(card.height.map(CGFloat.init) ?? remembered ?? WidgetSizing.guess) + font.lineHeight
                                visual = nil
                                visualMark = nil
                                continue
                            }
                            if visual == nil, let card = MarkdownWidget(infoString: info) {
                                visual = card
                                visualMark = mark
                                continue
                            }
                        }
                        if visual != nil {
                            visual?.source += String(line) + "\n"
                        } else if Self.isImage(trimmed) {
                            // A picture of a file on the Mac (`MarkdownImage`), whose size is
                            // not known here: a typical one's, rather than a line's, as its
                            // place is while its shape is not known.
                            height += ReplyImageView.typicalHeight
                        } else {
                            height += CGFloat(max(1, (line.count + columns - 1) / columns)) * font.lineHeight
                        }
                    }
                    if visual != nil { height += WidgetSizing.draftFloor }
                case let .user(message):
                    height += CGFloat(max(1, (message.text.count + columns - 1) / columns)) * font.lineHeight + Theme.grid * 2
                    if !message.images.isEmpty || !message.files.isEmpty { height += 120 }
                default:
                    height += font.lineHeight * 2
                }
            }
        }
        return max(48, height)
    }
}

extension EnvironmentValues {
    /// Known before new transcript rows are built, so a recreated visual can use its
    /// saved height on its first layout instead of waiting for its own geometry.
    @Entry var widgetLayoutWidth: CGFloat = 0
}

/// A block of the transcript's turns (`TranscriptBlocks`), compared as a whole: by its
/// turns and by what else its rows show (`Shows`). In a long thread, a streamed word then
/// builds and compares the block with the last turn in it, not every turn of the thread.
/// Far from the screen, a block is one space as tall as its turns' remembered heights and
/// the gaps between them, exactly what its stack of turns kept out of sight measures, so
/// the scroll's height does not change as it comes near and is built; its turns then
/// hold no views, state or visibility trackers. With every turn in the plain stack
/// (`TranscriptTurn`), streaming into a 600-turn thread cost 29.4% CPU in the iPhone
/// simulator where the lazy stack before it took 21.3% (night n7).
struct TranscriptBlock<Row: View>: View, Equatable {
    let turns: ArraySlice<Turn>
    let heights: TranscriptHeights
    let shows: Shows
    @ViewBuilder var row: (Turn) -> Row

    /// What the block's rows show besides their turns, as far as it is about them: the
    /// run's status only in the block with the last turn, the plan only in the one with
    /// the running turn, and so on, so that other blocks compare equal.
    struct Shows: Equatable {
        var status: RunStatus?
        var plan: TodoPlan?
        var canRetry: Bool
        var offersMessageFork = false
        var canForkMessage = false
        var listing: Turn.ID?
        /// Built wherever it is: the last blocks, which the chat scrolls to by their
        /// turns (`ChatScreen.settle`, the repair of a blank chat), and one with a turn
        /// that is kept built (`TranscriptTurn.keepsBuilt`).
        var staysBuilt: Bool
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.shows == rhs.shows && lhs.heights === rhs.heights && lhs.turns == rhs.turns
    }

    @Environment(\.widgetLayoutWidth) private var width
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.transcriptAnchor) private var anchor
    /// Near the screen and on it, as a turn's (`TranscriptTurn`).
    @State private var nearness = RowNearness()

    private var isNear: Bool { nearness.isNear }

    private static var spacing: CGFloat { Theme.grid * 3 }

    var body: some View {
        Group {
            if nearness.isBuilt(kept: shows.staysBuilt, onScreenCounts: !DebugLaunch.leavesOutGapsFix(.onScreen)) {
                VStack(alignment: .leading, spacing: Self.spacing) {
                    ForEach(turns) { turn in
                        row(turn)
                    }
                }
                .gapProbeBuilt("block", turn: turns.first?.id ?? UUID())
            } else {
                Color.clear
                    .frame(height: spaceTaken)
                    .accessibilityHidden(true)
                    .gapProbeSpace("block", turn: turns.first?.id ?? UUID(), height: spaceTaken, near: isNear)
                    // Its space can change above the screen too: a turn in it that changed
                    // out of sight is estimated again once the window's width is not the
                    // one it was measured at (`TranscriptHeights`). Built, its turns tell
                    // the anchor themselves.
                    .tellsAnchor(anchor, heightUpTo: turns.last?.id ?? UUID())
            }
        }
        .gapProbeNotesNear("block", turn: turns.first?.id ?? UUID(), near: isNear)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onScrollVisibilityChange(threshold: 0.001) { visible in
            if nearness.isOnScreen != visible { nearness.isOnScreen = visible }
        }
        // Near a little before its turns would be (`TranscriptTurn`, twice
        // `WidgetSizing.nearby`), so that they are there to be told they are near.
        .background { NearTracker(nearness: $nearness, reach: WidgetSizing.nearby * 3, probe: ("block", turns.first?.id ?? UUID())) }
    }

    private var spaceTaken: CGFloat {
        turns.reduce(0) { $0 + heights.height(for: $1, width: width, typeSize: typeSize) }
            + Self.spacing * CGFloat(max(0, turns.count - 1))
    }
}

/// Whether a row of the transcript is within `reach` of the screen, above or below it, told
/// by the scroll view for a clear box that much taller than the row. The tracker is on the
/// taller box itself: put on the padding around it, as it was from 78c9619f (2026-10-21),
/// it was told about the padding's own frame, which is the row's, and turns were built
/// only as they touched the screen, so that each one's estimate gave way to its real height
/// at the screen's edge, under what was being read (scroll audit, 2026-10-26: built with
/// their bottoms 5 to 79 points into the screen).
private struct NearTracker: View {
    @Binding var nearness: RowNearness
    let reach: CGFloat
    /// What it tracks, for `GapProbe`.
    var probe: (kind: String, id: UUID)
    /// Where the box was last seen while a "not near" is held (`RowNearness.reconcile`).
    @State private var box = BoxPlace()

    var body: some View {
        if DebugLaunch.keepsNoAnchor {
            Color.clear
                .padding(.vertical, -reach)
                .background { if nearness.holdsDeparture { BoxReader(box: box) } }
                .onScrollVisibilityChange(threshold: 0.001, told)
                .task(id: nearness.departureCheckedAt) { await settleDeparture() }
        } else {
            Color.clear
                .gapProbeTracker(probe.kind, turn: probe.id)
                // Read only while a "not near" is held: a geometry reader on every row
                // would run at every frame the chat scrolls (78c9619f). In the box's
                // background, so that its coming and going leaves the box as it was.
                .background { if nearness.holdsDeparture { BoxReader(box: box) } }
                .onScrollVisibilityChange(threshold: 0.001, told)
                .padding(.vertical, -reach)
                .task(id: nearness.departureCheckedAt) { await settleDeparture() }
        }
    }

    /// Told "not near" within moments of "near", the row stays built for now
    /// (`RowNearness`).
    private func told(_ near: Bool) {
        gapProbeTold(probe.kind, turn: probe.id, near: near)
        var next = nearness
        if !next.told(near: near, at: .now, settles: !DebugLaunch.leavesOutGapsFix(.hold)) {
            box.inReach = nil
            gapProbeTold(probe.kind + "-kept", turn: probe.id, near: true)
            AppLog.scroll.notice("\(probe.kind, privacy: .public) \(probe.id.uuidString.prefix(8), privacy: .public) told not near at once after near: kept built")
        }
        if next != nearness { nearness = next }
    }

    /// Once the settling time is over, a held "not near" is settled by where the box is
    /// then: a row that really left is let go of, which the scroll view, having said so
    /// once, would not say again.
    private func settleDeparture() async {
        guard let due = nearness.departureCheckedAt else { return }
        try? await Task.sleep(until: due, clock: .continuous)
        guard !Task.isCancelled, !DebugLaunch.leavesOutGapsFix(.reconcile) else { return }
        var next = nearness
        guard next.reconcile(boxInReach: box.inReach, at: .now) else { return }
        gapProbeTold(probe.kind + "-settled", turn: probe.id, near: next.isNear)
        if !next.isNear {
            AppLog.scroll.notice("\(probe.kind, privacy: .public) \(probe.id.uuidString.prefix(8), privacy: .public) out of reach once settled: let go of")
        }
        if next != nearness { nearness = next }
    }
}

/// Where a near tracker's box was last seen: in the scroll view's bounds or not. Not
/// observed: it is read once, when a held "not near" is settled.
@MainActor
private final class BoxPlace {
    var inReach: Bool?
}

/// Notes whether the box it is the background of reaches into the scroll view's bounds.
private struct BoxReader: View {
    let box: BoxPlace

    var body: some View {
        Color.clear
            .onGeometryChange(for: Bool.self) { proxy in
                let frame = proxy.frame(in: .scrollView)
                let height = proxy.bounds(of: .scrollView)?.height ?? 0
                return height > 0 && frame.maxY > 0 && frame.minY < height
            } action: { inReach in
                box.inReach = inReach
            }
    }
}
