import SwiftUI
import UIKit

/// The keyboard is let go of in a chat that leaves the screen while it is kept built out of
/// sight (`ChatScreen.isShown`, `Fleet.keptChats`): a field of it holding the focus as it
/// leaves (the composer, an answer typed to a question, a note to an approval or a plan,
/// selected text) would take the keys typed next, out of sight.
@MainActor
enum OutOfSightFocus {
    private static weak var found: UIResponder?

    /// Lets the keyboard's holder go if it is drawn nowhere: in a view, or under one, that
    /// is hidden or wholly transparent, as a chat kept out of sight is (its opacity, on the
    /// UIKit view that holds what it draws). Looked at once the chat's leaving is drawn.
    static func letGoIfHidden() {
        DispatchQueue.main.async {
            found = nil
            UIApplication.shared.sendAction(#selector(UIResponder.portalsNoteKeyboardHolder), to: nil, from: nil, for: nil)
            guard let view = found as? UIView, isDrawnNowhere(view) else { return }
            _ = view.resignFirstResponder()
        }
    }

    fileprivate static func note(_ responder: UIResponder) {
        found = responder
    }

    private static func isDrawnNowhere(_ view: UIView) -> Bool {
        guard view.window != nil else { return false }
        var next: UIView? = view
        while let each = next {
            if each.isHidden || each.alpha < 0.01 || each.layer.opacity < 0.01 { return true }
            next = each.superview
        }
        return false
    }
}

extension UIResponder {
    /// Sent to the keyboard's holder (`OutOfSightFocus`): notes it.
    @objc fileprivate func portalsNoteKeyboardHolder() {
        OutOfSightFocus.note(self)
    }
}

extension View {
    /// `focus` is let go of as the chat this is in leaves the screen, kept built out of sight
    /// (`isOutOfSight`): what is typed next would go into this field, unseen.
    func losesFocusOutOfSight(_ focus: FocusState<Bool>.Binding) -> some View {
        modifier(LosesFocusOutOfSight(focus: focus))
    }
}

private struct LosesFocusOutOfSight: ViewModifier {
    let focus: FocusState<Bool>.Binding
    @Environment(\.isOutOfSight) private var isOutOfSight

    func body(content: Content) -> some View {
        content.onChange(of: isOutOfSight) { _, out in
            if out, focus.wrappedValue { focus.wrappedValue = false }
        }
    }
}
