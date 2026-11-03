import AgentCore
import SwiftUI
#if targetEnvironment(macCatalyst)
import UIKit
#endif

/// One list's thread rows on a Mac (a Mac's space, the groups on top, a search's results):
/// where each row is, which of them the pointer is on, and the one control that takes the
/// pointer for them all.
///
/// On a Mac a thread row is only drawn: it has no UIKit view, tracks no pointer and takes
/// no hit of its own (2026-10-24: none of the stuff around the controls until the
/// pointer is on that row). With a UIKit button and a pointer tracker in every row, each
/// move of the pointer over a long list hit-tested the views of every row, and each row
/// it entered or left changed state that laid the whole sidebar out again: most of the
/// main thread while the pointer moved over a folder of many threads (a profile of
/// 2026-10-24). For the whole list now:
/// - each row notes where it is in the list, once for each layout that moves it and again
///   as the list shows it again (`note`, `Spot`), and forgets it as the list lets it go
///   (`forget`);
/// - one tracker on the list works out the row under the pointer from those places
///   (`pointerMoved`);
/// - the fill of the row under the pointer is drawn once, behind the rows, where that row
///   is (`fill`); a row under Recent, which shows its × under the pointer, is told by a flag
///   of its own (`Flag`); no other row is drawn again, and the list is not laid out again;
/// - the pin at that row's far end is one button, drawn once, over the rows, where that row
///   is (`pinSpot`, 2026-11-02: "can we make it easier to pin? like on hover there
///   should be an option to pin as well"): it hides what the row has there by covering it,
///   so that no row has to ask whether the pointer is on it;
/// - one UIKit view behind the rows (`RowHoverView`, the rows let hits through to it) puts
///   its one button over the row a hit lands on: the button opens the thread, opens the
///   row's menu, made only as it opens, and shows the tooltip of the arrow before the title
///   of a thread an agent started. A secondary click, Full Keyboard Access, Voice Control and
///   VoiceOver reach it there, at the row, as they would a button of the row's own.
@MainActor @Observable
final class RowHover {
    /// The space the rows' places are measured in: the list's own, so that scrolling it
    /// changes none.
    nonisolated static let space = "thread-row-hover"

    /// Where a row is in the list, and what of it the control over it needs.
    nonisolated struct Place: Equatable, Sendable {
        var frame: CGRect
        var kind: AgentSidebar.ThreadRowKind
        /// Under Finished or Recent, where its × dismisses it.
        var closes: Bool
        /// Its thread is on screen: its box is filled as such, and not as the row under the
        /// pointer too.
        var isCurrent: Bool
    }

    /// Where the fill of the row under the pointer goes, in the list: drawn again as the
    /// pointer goes from row to row, with `pinSpot`, and nothing else is.
    private(set) var fill: CGRect?
    /// Where the pin of the row under the pointer goes, in the list.
    private(set) var pinSpot: PinSpot?

    /// Each thread's rows that noted their places, oldest first: a thread can have two for a
    /// moment, the one leaving a group (Running) and the one coming into another (Recent),
    /// which SwiftUI may make before it lets the first go. The newest is the thread's row,
    /// and a row let go takes only its own place with it (Codex review).
    @ObservationIgnored private var registrations: [ThreadKey: [Registration]] = [:]
    @ObservationIgnored private var places: [ThreadKey: Place] = [:]
    /// The rows as they were made (their fleet and actions), noted with their places.
    @ObservationIgnored private var rows: [ThreadKey: ThreadRow] = [:]

    private struct Registration {
        /// The row view's own (`ThreadRow`'s state): two rows of one thread are told apart by it.
        let token: UUID
        var place: Place
        var row: ThreadRow
        /// The row view's own (its state), which tells it the pointer is on its thread's
        /// row: held by the row for as long as it lives, so a row is never left watching a
        /// flag nothing sets any more (Codex review).
        let flag: Flag
    }
    @ObservationIgnored private var hovered: ThreadKey?
    @ObservationIgnored private var pointer: CGPoint?
    /// Folders' rows under the pointer, pinned over the threads under them as those scroll:
    /// while one is, no thread's row is under the pointer.
    @ObservationIgnored private var covers: Set<String> = []
    @ObservationIgnored private var updates = false

    init() {
        #if DEBUG && targetEnvironment(macCatalyst)
        RowHover.made(self)
        #endif
    }

    /// A row's place, for each layout that moves it or changes what it is, and as the list
    /// shows it again. `token` and `flag` are the row view's own.
    func note(_ place: Place, of row: ThreadRow, token: UUID, flag: Flag) {
        let key = row.record.key
        var list = registrations[key] ?? []
        if let index = list.firstIndex(where: { $0.token == token }) {
            list[index].place = place
            list[index].row = row
        } else {
            list.append(Registration(token: token, place: place, row: row, flag: flag))
            flag.set(key == hovered)
        }
        registrations[key] = list
        settle(key)
        #if DEBUG && targetEnvironment(macCatalyst)
        if RowProbe.isForced(row.record.id.rawValue) { forced = key }
        #endif
        updateSoon()
    }

    /// The list let the row view with `token` go: out of sight, or no longer listed. Another
    /// row of the same thread, made meanwhile, keeps its place.
    func forget(_ key: ThreadKey, token: UUID) {
        guard var list = registrations[key], let index = list.firstIndex(where: { $0.token == token }) else { return }
        list.remove(at: index)
        registrations[key] = list.isEmpty ? nil : list
        settle(key)
        updateSoon()
    }

    /// The thread's place and row, from its newest row; with none left, nothing of it is
    /// kept: each row's flag goes with its row (Codex review).
    private func settle(_ key: ThreadKey) {
        let had = places[key] != nil
        if let newest = registrations[key]?.last {
            places[key] = newest.place
            rows[key] = newest.row
            if !had { RowProbe.laidOut(1) }
        } else {
            places[key] = nil
            rows[key] = nil
            if had { RowProbe.laidOut(-1) }
        }
    }

    /// The pointer moved over the list, to a point in it, or left it (nil).
    func pointerMoved(to point: CGPoint?) {
        pointer = point
        if point == nil { covers = [] }
        update()
    }

    /// A folder's row pinned at the top of the list is under the pointer, or no longer.
    func covered(by header: String, _ isCovered: Bool) {
        let changed = isCovered ? covers.insert(header).inserted : covers.remove(header) != nil
        if changed { update() }
    }

    /// The row at a point of the list, if any: not between two rows, as a row's own box
    /// was all of it there was before.
    func row(at point: CGPoint) -> ThreadKey? {
        places.first { $0.value.frame.contains(point) }?.key
    }

    /// The row at a point of the list, with what its control needs.
    func target(at point: CGPoint) -> Target? {
        row(at: point).flatMap(target(of:))
    }

    /// A thread's row in the list, with what its controls need.
    func target(of key: ThreadKey) -> Target? {
        guard let place = places[key], let row = rows[key] else { return nil }
        return Target(key: key, place: place, row: row)
    }

    /// The places changed: what is under the pointer is worked out once they have, not
    /// once for each.
    private func updateSoon() {
        guard !updates else { return }
        updates = true
        Task { @MainActor [weak self] in
            self?.updates = false
            self?.update()
        }
    }

    private func update() {
        var key = covers.isEmpty ? pointer.flatMap(row(at:)) : nil
        #if DEBUG && targetEnvironment(macCatalyst)
        if pointer == nil, let forced, places[forced] != nil { key = forced }
        #endif
        if key != hovered {
            if let hovered { registrations[hovered]?.forEach { $0.flag.set(false) } }
            if let key { registrations[key]?.forEach { $0.flag.set(true) } }
            hovered = key
        }
        let place = key.flatMap { places[$0] }
        let frame = place.flatMap { $0.isCurrent ? nil : $0.frame }
        if frame != fill { fill = frame }
        let spot = key.flatMap { key in place.map { PinSpot(key: key, place: $0) } }
        if spot != pinSpot { pinSpot = spot }
    }

    /// What the pin of the row under the pointer needs of it.
    nonisolated struct PinSpot: Equatable, Sendable {
        var key: ThreadKey
        var place: Place
    }

    /// The × and the pin at a row's far end, each as wide as this.
    static let controlWidth: CGFloat = RowMetrics.mark + Theme.grid
    /// From the row's edge to those, which is less than to what it says.
    static let controlInset: CGFloat = RowMetrics.padding / 2

    /// How much of its far end a row keeps for those: the pin, and the × under Recent. From
    /// its own end, whose edge the row's padding keeps further in than theirs.
    static func controlsRoom(closes: Bool) -> CGFloat {
        (closes ? controlWidth * 2 : controlWidth) + controlInset - RowMetrics.padding
    }

    /// Where a row view was last laid out in the list, and whether the list shows it
    /// (`ListedSpot`): each row view has its own, which no body reads, so that keeping it
    /// draws nothing again. A row the list let go as it scrolled out of sight, and shows
    /// again where it was, is noted again from it.
    final class Spot {
        var spot = ListedSpot<Place>()
    }

    /// Whether the pointer is on a row: each row view has its own, which a row under Recent
    /// reads (for its ×) and otherwise only `HiddenUnderPointer`, each alone drawn again as
    /// it changes.
    @Observable final class Flag {
        private(set) var isOn = false

        /// Changes it only when it changes, so that its row is not drawn again for nothing.
        func set(_ on: Bool) {
            if isOn != on { isOn = on }
        }
    }

    /// The row a hit landed on, held whole: what the control's click opens and its menu
    /// offers, should the row have left the list since.
    @MainActor
    struct Target {
        let key: ThreadKey
        let place: Place
        let row: ThreadRow

        /// The thread as its host has it now, which a menu opening long after the row was
        /// drawn offers to pin or archive as it is.
        var record: ThreadRecord {
            row.fleet.model(for: key.host)?.record(for: key.id) ?? row.record
        }

        func open() {
            row.onOpen(record)
        }

        /// The tooltip of the arrow before the title of a thread an agent started, under its
        /// folder, where the arrow is in the row (`ThreadRow.starterMark`).
        var tip: (text: String, rect: CGRect)? {
            guard place.kind == .underProject, let starter = record.startedBy?.caption, !starter.isEmpty else { return nil }
            return (starter, CGRect(x: RowMetrics.padding, y: (place.frame.height - RowMetrics.icon) / 2, width: RowMetrics.icon, height: RowMetrics.icon))
        }

        #if targetEnvironment(macCatalyst)
        /// The row's menu, as UIKit's items, made as it opens: the same as `ThreadRow.menu`.
        func menuItems() -> [UIMenuElement] {
            let fleet = row.fleet
            let record = record
            return ThreadRowMenu.items(
                for: record, kind: place.kind, closing: place.closes ? row.closing : nil, isTab: fleet.tabs.contains(key),
                isBot: place.kind == .apart && fleet.isBot(record.ref.agent), offersRemoval: fleet.offersRemoval(record),
                fleet: fleet, onRename: row.onRename
            )
        }
        #endif
    }

    #if DEBUG && targetEnvironment(macCatalyst)
    /// The thread whose row is under the pointer while the pointer is not on the list, for
    /// comparing captures (`RowProbe.forcedHover`).
    @ObservationIgnored private var forced: ThreadKey?

    private static var lists: [Weak] = []

    private struct Weak {
        weak var hover: RowHover?
    }

    private static func made(_ hover: RowHover) {
        lists = lists.filter { $0.hover != nil } + [Weak(hover: hover)]
        RowProbe.walker = walk
    }

    /// A thread as the probe tells its row by (`RowProbe`, `hits`): its title, and its Mac's
    /// name, which a row in the groups on top says too.
    struct Named {
        let title: String
        let host: String
    }

    /// The rows as noted, each thread's name with its place, top first: what the probe
    /// checks a click against.
    var notedRows: [(name: Named, frame: CGRect)] {
        places.compactMap { key, place in rows[key].map { (Self.name(of: $0), place.frame) } }
            .sorted { $0.frame.minY < $1.frame.minY }
    }

    /// The thread whose row is at a point of the list, as a click there would find it.
    func name(at point: CGPoint) -> Named? {
        target(at: point).map { Self.name(of: $0.row) }
    }

    private static func name(of row: ThreadRow) -> Named {
        Named(title: row.record.displayTitle, host: row.fleet.model(for: row.record.key.host)?.host.name ?? row.record.key.host.rawValue)
    }

    /// Moves the row under the pointer, as the pointer would, from each row of every list
    /// to the next, 25 ms apart, and off the list at the end: how many moves.
    private static func walk() async -> Int {
        var steps = 0
        for hover in lists.compactMap(\.hover) {
            for place in hover.places.values.sorted(by: { $0.frame.minY < $1.frame.minY }) {
                hover.pointerMoved(to: CGPoint(x: place.frame.midX, y: place.frame.midY))
                steps += 1
                try? await Task.sleep(for: .milliseconds(25))
            }
            hover.pointerMoved(to: nil)
        }
        return steps
    }
    #endif
}

extension View {
    /// A list's thread rows on a Mac, with one tracker of the pointer for them all, the
    /// fill of the row under it, and the control that takes its clicks (`RowHover`). The
    /// rows note their places in the list this is put on. Elsewhere, nothing.
    @ViewBuilder
    func threadRowHover(_ hover: RowHover) -> some View {
        #if targetEnvironment(macCatalyst)
        modifier(ThreadRowHover(hover: hover))
        #else
        self
        #endif
    }

    /// A folder's row pinned at the top of the list while its threads scroll under it: the
    /// pointer on it is on none of them (`RowHover.covered(by:_:)`).
    @ViewBuilder
    func coversThreadRows(_ hover: RowHover, id: String) -> some View {
        #if targetEnvironment(macCatalyst)
        onHover { hover.covered(by: id, $0) }
            .onDisappear { hover.covered(by: id, false) }
        #else
        self
        #endif
    }
}

#if targetEnvironment(macCatalyst)
private struct ThreadRowHover: ViewModifier {
    let hover: RowHover

    func body(content: Content) -> some View {
        content
            .coordinateSpace(.named(RowHover.space))
            .background(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    RowHoverLayer(hover: hover)
                        .accessibilityHidden(true)
                    RowHoverFill(hover: hover)
                }
            }
            .overlay(alignment: .topLeading) { RowHoverPin(hover: hover) }
            .onContinuousHover { phase in
                switch phase {
                case let .active(point): hover.pointerMoved(to: point)
                case .ended: hover.pointerMoved(to: nil)
                }
            }
            .environment(hover)
    }
}

/// The fill of the row under the pointer, behind the rows, as a row's box drew it
/// (`RowBox`): the one view drawn again as the pointer goes from row to row.
private struct RowHoverFill: View {
    let hover: RowHover

    var body: some View {
        if let frame = hover.fill {
            RoundedRectangle(cornerRadius: RowMetrics.corner, style: .continuous)
                .fill(Color(uiColor: .quaternarySystemFill))
                .frame(width: frame.width, height: frame.height)
                .offset(x: frame.minX, y: frame.minY)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

/// The pin of the row under the pointer, over the rows, where that row is (`RowHover.pinSpot`):
/// beside its × under Recent, elsewhere in the ×'s place, with the row's far end hidden under
/// the pointer (`HiddenUnderPointer`), and the ⌘ key that was there beside it. The one view
/// drawn again, with the fill, as the pointer goes from row to row; the thread is read here,
/// so that a press shows at once. A click on it is its own: it is over `RowHoverView`, whose
/// control opens the thread.
private struct RowHoverPin: View {
    let hover: RowHover

    var body: some View {
        if let spot = hover.pinSpot, let target = hover.target(of: spot.key) {
            let record = target.record
            let frame = spot.place.frame
            HStack(spacing: 2) {
                RowShortcutOverlay(key: spot.key, fleet: target.row.fleet)
                    .allowsHitTesting(false)
                Button(record.isPinned ? "Unpin" : "Pin", systemImage: record.isPinned ? "pin.slash" : "pin") {
                    target.row.fleet.setPinned(!record.isPinned, for: record)
                }
                .labelStyle(.iconOnly)
                .font(.app.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: RowHover.controlWidth, height: RowHover.controlWidth)
                .contentShape(.rect)
                .buttonStyle(.plain)
                .tip(record.isPinned ? "Unpin" : "Pin")
                .accessibilityIdentifier("thread-row-pin")
            }
            .padding(.trailing, RowHover.controlInset + (spot.place.closes ? RowHover.controlWidth : 0))
            .frame(width: frame.width, height: frame.height, alignment: .trailing)
            .offset(x: frame.minX, y: frame.minY)
        }
    }
}

/// A row's far end, gone while the pointer is on the row, for what shows there instead
/// (`RowHoverPin`, and the × under Recent). Its own view, so that the flag draws this again
/// and not the row. Hidden and not covered: the sidebar's ground fades into the chat's wash
/// under a wide window's far ends (`AgentSidebar.fadesIntoChat`), which no patch can match.
struct HiddenUnderPointer: ViewModifier {
    let flag: RowHover.Flag

    func body(content: Content) -> some View {
        content.opacity(flag.isOn ? 0 : 1)
    }
}

/// `RowHoverView`, behind the list's rows, the list's size.
private struct RowHoverLayer: UIViewRepresentable {
    let hover: RowHover

    func makeUIView(context: Context) -> RowHoverView {
        RowHoverView(hover: hover)
    }

    func updateUIView(_ view: RowHoverView, context: Context) {
        view.hover = hover
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: RowHoverView, context: Context) -> CGSize? {
        proposal.replacingUnspecifiedDimensions(by: .zero)
    }
}

/// What takes the clicks on a list's thread rows on a Mac: a view the list's size that
/// draws nothing and takes a hit only where a row is, putting its one button over that
/// row (`RowMenuUIButton`), whatever made the hit: a click, a secondary click, the pointer
/// resting for a tooltip, an assistive app asking for the row's menu.
final class RowHoverView: UIView {
    var hover: RowHover
    private let button = RowMenuUIButton(type: .custom)
    /// The row the button is over, which its click opens and its menu is made for: held by
    /// the button's actions and menu, never holding them, so that whenever UIKit asks
    /// there is a row to give the items of.
    private let over = Over()

    final class Over {
        var target: RowHover.Target?
    }

    init(hover: RowHover) {
        self.hover = hover
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        // The rows are what assistive apps reach, each with its own element.
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        let over = over
        button.addAction(UIAction { _ in over.target?.open() }, for: .primaryActionTriggered)
        button.showsMenuAsPrimaryAction = false
        button.menu = UIMenu(children: [
            UIDeferredMenuElement.uncached { completion in
                MainActor.assumeIsolated {
                    let items = over.target?.menuItems() ?? []
                    RowProbe.menuMade(over.target?.record.displayTitle ?? "none", items: items.flatMap { ($0 as? UIMenu)?.children ?? [$0] }.count)
                    completion(items)
                }
            }
        ])
        button.isAccessibilityElement = false
        button.accessibilityIdentifier = "thread-row-control"
        addSubview(button)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        hover.row(at: point) != nil
    }

    /// A hit on a row puts the button over it, and is the button's; anywhere else is the
    /// list's. While the button's menu shows it stays where it is.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, isUserInteractionEnabled else { return nil }
        if button.showsMenu {
            return button.frame.contains(point) ? button : nil
        }
        guard let target = hover.target(at: point) else { return nil }
        if over.target?.key != target.key || button.frame != target.place.frame {
            button.frame = target.place.frame
        }
        over.target = target
        button.tip = target.tip
        return button
    }
}
#endif
