import SwiftUI

// The chips that open a dropdown: the new thread's host, agent and folder chips
// (`NewThreadPickers`) and the composer's mode and model chips (`ModeChip`, `ModelChip`).
// 2026-11-06: "optimize and make opening some dropdown menus faster ... they all have
// some sort of slight delay to them", "i want to keep the overall styling the same for
// now". Measured on a Mac: a Mac's own controls open their menus on the mouse-down, but a
// SwiftUI Button acts on the mouse-up, and so does a SwiftUI Menu drawn as a plain chip,
// so every one of these dropdowns started a whole click late (the time the button is
// held: 60-120 ms for a person, of 140 ms to a menu and 350 ms to a settled popover).
// On a Mac they open on the press now, and look as they did.

/// A chip's button that opens its popover when it is pressed, on a Mac, as a Mac's own
/// pop-up buttons open on the mouse-down: its action (a click let go of, the keyboard,
/// VoiceOver) still opens it too. `open` only opens: one that toggled would close on the
/// release what the press opened. Pressed, the chip dims as a plain button's does.
private struct OpensOnPressStyle: ButtonStyle {
    let open: () -> Void

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? DropdownChip.pressedOpacity : 1)
            .onChange(of: configuration.isPressed) { _, isPressed in
                if isPressed { open() }
            }
    }
}

enum DropdownChip {
    /// How a pressed chip dims, as SwiftUI's plain button dims its label on a Mac (and a
    /// plain menu's label while its menu is open): measured from its pixels.
    static let pressedOpacity: Double = 0.75
}

extension View {
    /// A chip's button style: on a Mac it opens its popover on the press
    /// (`OpensOnPressStyle`), elsewhere it is plain, as it was. `open` must only open.
    @ViewBuilder
    func dropdownChipStyle(opens open: @escaping () -> Void) -> some View {
        if Platform.isMac {
            buttonStyle(OpensOnPressStyle(open: open))
        } else {
            buttonStyle(.plain)
        }
    }
}
