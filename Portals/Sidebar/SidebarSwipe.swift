import SwiftUI
import UIKit
import WebKit

/// The swipe that opens and closes the sidebar: a sideways pan anywhere on the chat.
///
/// A UIKit pan rather than a SwiftUI `DragGesture`: inside the chat's scroll
/// view, a SwiftUI drag could be left without an end when the scroll took
/// over, and the chat stayed stuck partway across. A pan always ends,
/// cancels or fails.
/// - It only starts when the finger moves mostly sideways, so scrolling is
///   untouched, and it recognizes alongside everything else (scrolling,
///   buttons, text selection). `SwipeGuard` keeps a swipe that ends on a button
///   from also pressing it.
/// - Never inside the text field, a sideways scroller (a code block, a diff) or a
///   widget's page (a slider), which keep their own swipes; nor on the chat's text while
///   part of it is selected (`ProseTextView`), whose handles are dragged sideways.
/// - With a trackpad it is a two-finger sideways scroll; dragging with the pointer
///   held down moves nothing.
struct SidebarSwipe: UIGestureRecognizerRepresentable {
    /// Shared with `MainScreen`, for its stuck-swipe checks.
    let tracker: Tracker
    /// Off on a wide window, where the sidebar is beside the chat.
    var isEnabled = true
    /// The swipe's sideways distance so far, in points.
    var onChange: (CGFloat) -> Void
    /// Where the swipe would come to rest (its distance plus a flick's
    /// momentum), or nil when it was cancelled.
    var onEnd: (CGFloat?) -> Void

    /// Whether a swipe is under way. A plain reference, not observed: only
    /// `MainScreen`'s checks read it.
    @MainActor
    final class Tracker {
        var isActive = false
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.delegate = context.coordinator
        recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        recognizer.allowedScrollTypesMask = .continuous
        recognizer.isEnabled = isEnabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        // In window space: the chat moves with the swipe, so its own space would too.
        let distance = recognizer.translation(in: nil).x
        switch recognizer.state {
        case .began, .changed:
            tracker.isActive = true
            onChange(distance)
        case .ended:
            tracker.isActive = false
            onEnd(distance + recognizer.velocity(in: nil).x * 0.2)
        case .cancelled, .failed:
            tracker.isActive = false
            onEnd(nil)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        /// Mostly sideways. A trackpad's two-finger scroll has no touches, so
        /// `shouldReceive touch:` is never asked about it: whether it is over a view that
        /// keeps its own swipes is asked here, of the view under where it started.
        /// Without that, a sideways scroll over a code block or a visual also slid the
        /// sidebar.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
            if pan.numberOfTouches == 0, let view = pan.view,
               Self.keepsOwnSwipes(view.hitTest(pan.location(in: view), with: nil)) {
                return false
            }
            let velocity = pan.velocity(in: nil)
            return abs(velocity.x) > abs(velocity.y) * 1.5
        }

        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            !Self.keepsOwnSwipes(touch.view)
        }

        /// Whether `view` or one it is in keeps sideways swipes for itself: the text
        /// field, the chat's text while part of it is selected, a sideways scroller, a
        /// widget's page.
        private static func keepsOwnSwipes(_ view: UIView?) -> Bool {
            var view = view
            while let current = view {
                if let text = current as? UITextView, text.isEditable || text.selectedRange.length > 0 { return true }
                if current is UITextField || current is WKWebView { return true }
                if let scroller = current as? UIScrollView, scroller.isScrollEnabled, scroller.contentSize.width > scroller.bounds.width + 1 {
                    return true
                }
                view = current.superview
            }
            return false
        }

        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

/// A swipe to the left on a row of the sidebar's Recent, on a touch screen, to close it
/// (`ThreadRow`): a UIKit pan, as the sidebar's own swipe is, which always ends.
/// - It only starts when the finger moves mostly sideways and to the left, so the
///   groups scroll as before, and a swipe to the right is left alone.
/// - Once it has started, the row's own tap does not happen: the pan recognizes along
///   with the groups' scrolling only.
struct RowSwipe: UIGestureRecognizerRepresentable {
    /// The swipe's sideways distance so far, in points.
    var onChange: (CGFloat) -> Void
    /// Where the swipe would come to rest (its distance plus a flick's momentum), or nil
    /// when it was cancelled.
    var onEnd: (CGFloat?) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.delegate = context.coordinator
        recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let distance = recognizer.translation(in: nil).x
        switch recognizer.state {
        case .began, .changed:
            onChange(distance)
        case .ended:
            onEnd(distance + recognizer.velocity(in: nil).x * 0.2)
        case .cancelled, .failed:
            onEnd(nil)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        /// Mostly sideways, to the left.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: nil)
            return velocity.x < 0 && abs(velocity.x) > abs(velocity.y) * 1.5
        }

        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            other.view is UIScrollView
        }
    }
}
