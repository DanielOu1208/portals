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

/// One choice in a chip's menu (`MenuChip`).
struct MenuChoice: Identifiable {
    /// Tells the choices apart, the same each time the menu is made.
    let id: String
    let title: String
    /// Its symbol, where it has one: the chosen one's checkmark, Other Folder…'s folder.
    var symbol: String?
    let action: () -> Void
}

/// A chip that opens a menu of choices, in sections with a line between them. On an
/// iPhone and iPad SwiftUI's menu as it was; on a Mac the same chip under a Mac's own
/// pull-down button that draws nothing (`MacMenuChipButton`), which opens the same menu on
/// the mouse-down, where SwiftUI's plain menu opened it on the mouse-up (measured
/// 2026-11-06, about 140 ms after the mouse-down for it, 55 for a Mac's button).
/// `sections` is read where the menu is made, not each time the screen around it is
/// drawn.
struct MenuChip<Label: View>: View {
    let sections: () -> [[MenuChoice]]
    let tip: String
    let accessibilityLabel: String
    let accessibilityValue: String
    let accessibilityHint: String
    let accessibilityIdentifier: String
    @ViewBuilder let label: () -> Label

    var body: some View {
        #if targetEnvironment(macCatalyst)
        MacMenuChip(chip: self)
        #else
        Menu {
            MenuChoices(sections: sections)
        } label: {
            label()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .tip(tip)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(accessibilityValue)
        .accessibilityHint(accessibilityHint)
        .accessibilityIdentifier(accessibilityIdentifier)
        #endif
    }
}

#if !targetEnvironment(macCatalyst)
/// A chip's choices as SwiftUI's menu content. A view of its own, so that what they are
/// made from is read where the menu is made.
private struct MenuChoices: View {
    let sections: () -> [[MenuChoice]]

    var body: some View {
        let sections = sections().filter { !$0.isEmpty }
        ForEach(sections.indices, id: \.self) { index in
            if index > 0 { Divider() }
            ForEach(sections[index]) { choice in
                Button(action: choice.action) {
                    if let symbol = choice.symbol {
                        SwiftUI.Label(choice.title, systemImage: symbol)
                    } else {
                        Text(choice.title)
                    }
                }
            }
        }
    }
}
#endif

#if targetEnvironment(macCatalyst)
import UIKit

/// `MenuChip` on a Mac: the chip, dimmed while its menu is open as SwiftUI's menu dimmed
/// it, under the button that opens the menu. The button is what the pointer, the keyboard
/// and assistive apps reach; the chip is only drawn.
private struct MacMenuChip<Label: View>: View {
    let chip: MenuChip<Label>
    @State private var isOpen = false

    var body: some View {
        // Read here, in a view of its own, so that a change to what the choices are made
        // from draws this chip again and not the screen around it.
        let sections = chip.sections().filter { !$0.isEmpty }
        chip.label()
            .opacity(isOpen ? DropdownChip.pressedOpacity : 1)
            .accessibilityHidden(true)
            .overlay {
                MacMenuChipButton(
                    sections: sections,
                    tip: chip.tip,
                    label: chip.accessibilityLabel,
                    value: chip.accessibilityValue,
                    hint: chip.accessibilityHint,
                    identifier: chip.accessibilityIdentifier,
                    isOpen: $isOpen
                )
            }
    }
}

/// A Mac's pull-down button with no title, no bezel and a clear tint, its menu its primary
/// action: AppKit opens it on the mouse-down, with the keyboard (arrows, Return, type to
/// select) and VoiceOver as any Mac menu. The menu is made whole whenever its choices
/// change: one made as it opens (`UIDeferredMenuElement`) titled the button "Loading…".
private struct MacMenuChipButton: UIViewRepresentable {
    let sections: [[MenuChoice]]
    let tip: String
    let label: String
    let value: String
    let hint: String
    let identifier: String
    @Binding var isOpen: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MenuChipUIButton {
        let button = MenuChipUIButton(configuration: .borderless())
        button.tintColor = .clear
        button.showsMenuAsPrimaryAction = true
        button.changesSelectionAsPrimaryAction = false
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentHuggingPriority(.defaultLow, for: .vertical)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        // Its menu is opening (on the mouse-down, the keyboard, VoiceOver), and it is
        // done: AppKit's menu, which says so as menus do (`NSMenuDidEndTrackingNotification`).
        // A Mac's button calls no `UIContextMenuInteraction` delegate of its own.
        button.addAction(UIAction { [weak button] _ in button?.setOpen(true) }, for: .menuActionTriggered)
        context.coordinator.menuEnded = NotificationCenter.default.addObserver(
            forName: Notification.Name("NSMenuDidEndTrackingNotification"), object: nil, queue: .main
        ) { [weak button] _ in
            MainActor.assumeIsolated { button?.setOpen(false) }
        }
        return button
    }

    static func dismantleUIView(_ button: MenuChipUIButton, coordinator: Coordinator) {
        coordinator.menuEnded.map(NotificationCenter.default.removeObserver)
    }

    func updateUIView(_ button: MenuChipUIButton, context: Context) {
        let coordinator = context.coordinator
        coordinator.actions = Dictionary(sections.joined().map { ($0.id, $0.action) }, uniquingKeysWith: { first, _ in first })
        button.onOpen = { [binding = $isOpen] open in
            if binding.wrappedValue != open { binding.wrappedValue = open }
        }
        let shape = sections.map { $0.map { MenuChipUIButton.Item(id: $0.id, title: $0.title, symbol: $0.symbol) } }
        if button.shape != shape {
            button.shape = shape
            button.menu = UIMenu(children: shape.map { section in
                UIMenu(options: .displayInline, children: section.map { item in
                    UIAction(title: item.title, image: item.symbol.flatMap { UIImage(systemName: $0) }) { [weak coordinator] _ in
                        coordinator?.actions[item.id]?()
                    }
                })
            })
        }
        if button.toolTip != tip { button.toolTip = tip }
        button.accessibilityLabel = label
        button.accessibilityValue = value
        button.accessibilityHint = hint
        button.accessibilityIdentifier = identifier
    }

    /// As large as the chip it is over.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MenuChipUIButton, context: Context) -> CGSize? {
        proposal.replacingUnspecifiedDimensions(by: .zero)
    }

    final class Coordinator {
        /// What each choice does, by its id: the menu, made only when the choices change,
        /// does the latest.
        var actions: [String: () -> Void] = [:]
        var menuEnded: (any NSObjectProtocol)?
    }
}

/// The button of `MacMenuChipButton`, which says when its menu opens and closes, for the
/// chip under it to dim while it is open.
final class MenuChipUIButton: UIButton {
    struct Item: Equatable {
        let id: String
        let title: String
        let symbol: String?
    }

    /// The choices its menu was made with.
    var shape: [[Item]]?
    var onOpen: (Bool) -> Void = { _ in }
    /// Its menu is on screen: any menu's end is the end of it then, as a Mac shows one
    /// menu at a time.
    private var isOpen = false

    func setOpen(_ open: Bool) {
        guard open != isOpen else { return }
        isOpen = open
        onOpen(open)
    }
}
#endif
