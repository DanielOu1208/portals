import os
import SwiftUI
import UIKit

/// Keeps what you are reading in place while a turn above it changes height. With the chat
/// scrolled up, nothing else does: the scroll's offset stays put while the content above
/// the screen grows or shrinks, and what is on screen moves by as much (scroll audit,
/// 2026-10-26: a 100-point nudge moved the text 407 points as a turn above was built
/// 307 points taller than its estimate; +816 in one of the user's own flings). A turn wholly
/// above the screen that changes height moves the offset by the same amount, in the layout
/// it changed in, so both reach the screen in one frame. One reaching into the screen is
/// left alone: a fold opened there pushes what is under it down, as it should. While the
/// chat keeps to its end it does nothing: the scroll's bottom anchor keeps the end in
/// place (`ChatScreen`). `PORTALS_DEBUG_NO_ANCHOR` turns it off, to compare.
@MainActor
final class TranscriptAnchor {
    /// The chat's UIKit scroll view, found from inside it (`ScrollFinder`).
    fileprivate(set) weak var scrollView: UIScrollView?
    /// Whether the chat is on screen and not hidden while it opens (`ChatScreen`).
    var isInView = false
    /// Whether the chat keeps to its end, read as it is now rather than copied in a view
    /// update later: copied, it went on holding for an update after a send had the bottom
    /// anchor keep the end, so that both moved the chat for a change above, and did not
    /// hold for one after a drag began (review of 2026-10-26).
    var followsEnd: Binding<Bool>?
    /// The turns' places in the chat, and those on screen (`turn(_:isVisible:)`).
    private var order: [UUID: Int] = [:]
    private var visible: Set<UUID> = []

    /// Whether it keeps the reading place: the chat is on screen, not hidden while it
    /// opens, and not keeping to its end.
    var holds: Bool { isInView && followsEnd?.wrappedValue == false }

    /// The chat's turns, in order, as they are now: told when their count changes.
    func turns(_ ids: [UUID]) {
        order = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        visible = visible.filter { order[$0] != nil }
    }

    /// A turn came onto the screen or left it, told by the scroll view.
    func turn(_ id: UUID, isVisible: Bool) {
        if isVisible { visible.insert(id) } else { visible.remove(id) }
    }

    /// Whether a turn is wholly above the screen: before the first turn on it. Worked out
    /// from which turns the scroll view says are on screen, rather than from each turn's
    /// place in it, which changes at every frame the chat scrolls and at every streamed
    /// word that keeps it to its end, and doubled SwiftUI's work at every word with every
    /// turn reading it (78c9619f). With no turn on the screen, it is not known, and left.
    private func isAbove(_ id: UUID) -> Bool {
        guard let index = order[id], let first = visible.lazy.compactMap({ self.order[$0] }).min() else { return false }
        return index < first
    }

    /// Something above the screen changed height: a turn, or a block of turns kept as one
    /// space (`TranscriptBlock`), which `last` is the last turn of. Its change is added
    /// to the offset: its top stays where it was, and so the rest moves with its bottom.
    func changed(by change: CGFloat, upTo last: UUID) {
        guard abs(change) >= 1, holds, isAbove(last), let scrollView else { return }
        scrollView.contentOffset.y += change
        AppLog.scroll.notice("anchor: a turn above changed by \(Int(change), privacy: .public); offset moved with it")
    }

    fileprivate func found(_ scrollView: UIScrollView) {
        self.scrollView = scrollView
    }

    /// Finds the chat's UIKit scroll view from a view inside it.
    struct ScrollFinder: UIViewRepresentable {
        let anchor: TranscriptAnchor

        final class Finder: UIView {
            weak var anchor: TranscriptAnchor?

            override func didMoveToWindow() {
                super.didMoveToWindow()
                find()
            }

            /// Looked for again as it is laid out, if it was not there yet as it came into
            /// the window, which would leave the anchor doing nothing for that chat.
            override func layoutSubviews() {
                super.layoutSubviews()
                if anchor?.scrollView == nil { find() }
            }

            private func find() {
                guard window != nil else { return }
                var view = superview
                while let current = view, !(current is UIScrollView) { view = current.superview }
                if let scrollView = view as? UIScrollView { anchor?.found(scrollView) }
            }
        }

        func makeUIView(context: Context) -> Finder {
            let finder = Finder()
            finder.anchor = anchor
            finder.isUserInteractionEnabled = false
            return finder
        }

        func updateUIView(_ finder: Finder, context: Context) {
            finder.anchor = anchor
        }
    }
}

extension View {
    /// A turn's side of `TranscriptAnchor`: it tells the anchor its height (in whole
    /// points, so a fraction laid out differently from one frame to the next tells nothing)
    /// only as that changes, and whether it is on the screen only as that changes, told by
    /// the scroll view. Neither changes as the chat scrolls or keeps to its end while a
    /// reply streams. Whether it is on the screen is told to `onScreen` as well, with or
    /// without an anchor (`TranscriptTurn` builds a turn on the screen whatever its near
    /// tracker says).
    func tellsAnchor(_ anchor: TranscriptAnchor?, turn id: UUID, onScreen: @escaping (Bool) -> Void) -> some View {
        tellsAnchor(anchor, heightUpTo: id)
            .onScrollVisibilityChange(threshold: 0.001) { visible in
                gapProbeTold("onscreen", turn: id, near: visible)
                onScreen(visible)
                anchor?.turn(id, isVisible: visible)
            }
    }

    /// Its height only, for a block of turns kept as one space, whose last turn is `last`.
    @ViewBuilder
    func tellsAnchor(_ anchor: TranscriptAnchor?, heightUpTo last: UUID) -> some View {
        if let anchor {
            onGeometryChange(for: CGFloat.self) { geometry in
                geometry.size.height.rounded()
            } action: { old, new in
                anchor.changed(by: new - old, upTo: last)
            }
        } else {
            self
        }
    }
}

extension EnvironmentValues {
    /// The chat's `TranscriptAnchor`, which its turns tell of their changes; none with
    /// `PORTALS_DEBUG_NO_ANCHOR`.
    @Entry var transcriptAnchor: TranscriptAnchor? = nil
}
