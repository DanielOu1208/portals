import SwiftUI
import UIKit

/// The composer's text on an iPhone and an iPad: the field as tall as its text, up to
/// `ChatFeature.composerLines` lines, and past that in a scroll view kept at its end as
/// the text grows or shrinks there.
///
/// The field used to scroll itself past its tallest (`lineLimit(1...6)`), and it slid
/// each new line into view over five or six frames, the line cut meanwhile: a line
/// started with Return or by a word wrapping, a draft put back and added to, a long
/// paste. Here the field never scrolls (no line limit), and the scroll view around it,
/// a whole number of lines tall, is at the new end in the same pass the line comes:
/// typed at the end, the text moves up a line at once; typed in the middle, the text
/// under the caret stays where it is.
///
/// The caret moved elsewhere (the arrow keys of an iPad's keyboard, the space bar held
/// and dragged on the screen's keyboard, a selection handle dragged, typing after the
/// text was scrolled away from the caret) is brought into view at once by the least
/// scroll (`revealCaret`): the field scrolled itself there too, with the same slide.
///
/// Per key that adds one look at where the caret is; the scroll view's height is one
/// measurement of what it holds, in the layout the field had already.
struct ComposerTextScroll<Field: View>: View {
    /// One line's height at the reader's text size.
    let lineHeight: CGFloat
    /// Where the field's caret is: each change is a time to bring it into view.
    let caret: TextSelection?
    @ViewBuilder var field: Field
    /// Which end of the selection moved last, to follow that one.
    @State private var edge = SelectionEdge()

    var body: some View {
        CappedHeight(maxHeight: lineHeight * CGFloat(ChatFeature.composerLines)) {
            ScrollView(.vertical) {
                field
            }
            .scrollBounceBehavior(.basedOnSize)
            // Dragging the text to read it is not putting the keyboard away.
            .scrollDismissesKeyboard(.never)
            // Kept at the end as the text changes there, and opened at its end (a long
            // draft put back): where the caret is when the field takes the focus.
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onChange(of: caret) { revealCaret() }
        }
    }

    /// Scrolls the field's text, by as little as it takes and without a slide, to show the
    /// caret's whole line (of a selection, the end that moved: Shift-Up, or the start
    /// handle dragged up, moves its start). The field's text
    /// view is the one being typed in, found as the first responder; the scroll view is
    /// the nearest one around it. Nothing happens unless the caret is out of view.
    private func revealCaret() {
        CaretFinder.found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.composerCaretFind), to: nil, from: nil, for: nil)
        // Only the composer's own field: the first responder can also be a reply's
        // read-only text, selected in place (`SelectableProse`), whose keys go to the
        // composer; scrolling to its selection would move the chat.
        guard let textView = CaretFinder.found as? UITextView, textView.isEditable,
              let range = textView.selectedTextRange else { return }
        var above = textView.superview
        while let view = above, !(view is UIScrollView) { above = view.superview }
        guard let scroll = above as? UIScrollView else { return }
        let caret = textView.convert(textView.caretRect(for: edge.moving(range, in: textView)), to: scroll)
        let shown = scroll.bounds
        let inset = scroll.adjustedContentInset
        let highest = -inset.top
        let lowest = max(scroll.contentSize.height + inset.bottom - shown.height, highest)
        var top = shown.minY
        if caret.minY < shown.minY {
            top = caret.minY
        } else if caret.maxY > shown.maxY {
            top = caret.maxY - shown.height
        }
        top = min(max(top, highest), lowest)
        guard abs(top - shown.minY) > 0.5 else { return }
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: top), animated: false)
    }
}

/// Which end of a text view's selection is the one moving: its start, once only the start
/// moved (Shift-Up, the start handle dragged); its end, once the end moved or both did
/// (which is also where a caret is). Asked again with nothing moved, the same end.
@MainActor
final class SelectionEdge {
    private var last: (start: Int, end: Int)?
    private var followsStart = false

    func moving(_ range: UITextRange, in textView: UITextView) -> UITextPosition {
        let start = textView.offset(from: textView.beginningOfDocument, to: range.start)
        let end = textView.offset(from: textView.beginningOfDocument, to: range.end)
        if let last, start != last.start || end != last.end {
            followsStart = start != last.start && end == last.end && start != end
        } else if last == nil || start == end {
            followsStart = false
        }
        last = (start, end)
        return followsStart ? range.start : range.end
    }
}

/// The responder found by `composerCaretFind`, for as long as the call takes.
@MainActor
private enum CaretFinder {
    static weak var found: UIResponder?
}

private extension UIResponder {
    /// Sent to the first responder: the one receiving it says it is.
    @objc func composerCaretFind() {
        MainActor.assumeIsolated { CaretFinder.found = self }
    }
}

/// Its one view as tall as that view wants, but no taller than `maxHeight`: a scroll view
/// as tall as its content, until it scrolls.
private struct CappedHeight: Layout {
    let maxHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        let wanted = view.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        return CGSize(width: proposal.width ?? wanted.width, height: min(wanted.height, maxHeight))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
