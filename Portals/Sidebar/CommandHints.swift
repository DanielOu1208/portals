import AgentCore
import SwiftUI

#if targetEnvironment(macCatalyst)
/// Whether ⌘ is held alone on a Mac, for a sidebar's hints of the ⌘ keys
/// (`CommandHoldState`): one monitor of AppKit's events for the whole app, reached by name
/// from Catalyst, as `WindowMover` reaches its window, made as the first hint asks. Read only
/// by the small views that show a hint: ⌘ draws those again and nothing else, no row's body
/// and no layout. Not on an iPhone or iPad: their tabs show no hints of keys, most being used
/// without a keyboard, and this monitor is AppKit's.
@MainActor @Observable
final class CommandHold {
    static let shared = CommandHold()

    private(set) var isHeld = false

    @ObservationIgnored private var state = CommandHoldState()
    @ObservationIgnored private var delay: Task<Void, Never>?
    /// Asks what is held while the hints show; none otherwise.
    @ObservationIgnored private var watch: Task<Void, Never>?

    /// The monitor and the observers are for good: AppKit and the notification centre hold
    /// them, with nothing here to hold.
    private init() {
        Self.addMonitor { event in
            MainActor.assumeIsolated { CommandHold.shared.heard(event) }
        }
        for name in ["NSApplicationDidResignActiveNotification", "NSApplicationDidBecomeActiveNotification", "NSWindowDidResignKeyNotification"] {
            _ = NotificationCenter.default.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { CommandHold.shared.change { $0.focusChanged() } }
            }
        }
    }

    /// `NSEvent.ModifierFlags`: shift, control, option, command, function. Not Caps Lock.
    private static let modifierKeys: UInt = 1 << 17 | 1 << 18 | 1 << 19 | 1 << 20 | 1 << 23
    private static let commandKey: UInt = 1 << 20
    /// `NSEvent.EventType`.
    private static let keyDown: UInt = 10
    private static let flagsChanged: UInt = 12

    private func heard(_ event: NSObject) {
        guard let type = event.value(forKey: "type") as? UInt, let flags = event.value(forKey: "modifierFlags") as? UInt else { return }
        let modifiers = Self.modifiers(in: flags)
        if type == Self.keyDown {
            change { $0.keyPressed(with: modifiers) }
        } else if type == Self.flagsChanged {
            change { $0.modifiersChanged(to: modifiers) }
        }
    }

    private static func modifiers(in flags: UInt) -> CommandHoldState.Modifiers {
        let held = flags & modifierKeys
        return held == 0 ? .none : held == commandKey ? .commandAlone : .others
    }

    /// What is held now, from `NSEvent.modifierFlags`, for what the monitor cannot hear: it
    /// gets no event that a menu or a window's drag takes, so a ⌘ let go in one would leave
    /// the hints up. Nil if AppKit does not answer.
    private static var heldNow: CommandHoldState.Modifiers? {
        guard let events = NSClassFromString("NSEvent") as? NSObject.Type,
              class_respondsToSelector(object_getClass(events), NSSelectorFromString("modifierFlags")),
              let flags = events.value(forKey: "modifierFlags") as? UInt else { return nil }
        return modifiers(in: flags)
    }

    /// `heldNow` told to the state, if AppKit answers.
    private static func ask(_ state: inout CommandHoldState) {
        if let held = heldNow { state.modifiersChanged(to: held) }
    }

    private func change(_ step: (inout CommandHoldState) -> Void) {
        step(&state)
        if state.isWaiting {
            guard delay == nil else { return }
            delay = Task { [weak self] in
                try? await Task.sleep(for: CommandHoldState.delay)
                guard !Task.isCancelled, let self else { return }
                self.delay = nil
                self.change {
                    Self.ask(&$0)
                    $0.delayEnded()
                }
            }
        } else {
            delay?.cancel()
            delay = nil
        }
        if state.isShown != isHeld {
            isHeld = state.isShown
            watch?.cancel()
            watch = isHeld ? Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: CommandHoldState.delay)
                    guard !Task.isCancelled, let self else { return }
                    self.change(Self.ask)
                }
            } : nil
        }
    }

    /// `NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown])`, which hears
    /// them whatever has the keyboard, and passes them on: nothing if AppKit does not answer.
    private static func addMonitor(_ heard: @escaping (NSObject) -> Void) {
        typealias Add = @convention(c) (AnyClass, Selector, UInt64, @escaping @convention(block) (NSObject) -> NSObject?) -> AnyObject?
        let selector = NSSelectorFromString("addLocalMonitorForEventsMatchingMask:handler:")
        guard let events: AnyClass = NSClassFromString("NSEvent"), let method = class_getClassMethod(events, selector) else { return }
        let add = unsafeBitCast(method_getImplementation(method), to: Add.self)
        _ = add(events, selector, 1 << flagsChanged | 1 << keyDown) { event in
            heard(event)
            return event
        }
    }
}
#endif

/// A thread row's age, with the ⌘ key that goes to its tab in its place while ⌘ is held alone
/// (`CommandHold`), from where the tab has it (`OpenTabs.shortcut(of:)`), asked only then. Its
/// own view, so that ⌘ draws no more than this again; over the age, so that nothing moves.
struct RowAge: View {
    let age: String
    let key: ThreadKey
    let fleet: Fleet

    var body: some View {
        #if targetEnvironment(macCatalyst)
        let shortcut = CommandHold.shared.isHeld ? fleet.tabs.shortcut(of: key) : nil
        Text(age)
            .monospacedDigit()
            .opacity(shortcut == nil ? 1 : 0)
            .overlay(alignment: .trailing) {
                if let shortcut { ShortcutHint(number: shortcut) }
            }
        #else
        Text(age)
            .monospacedDigit()
        #endif
    }
}

/// The same for a row with no age to take the place of, at work or waiting: just before its far
/// end, on a little ground of its own, over the end of the title, for as long as ⌘ is held.
struct RowShortcutOverlay: View {
    let key: ThreadKey
    let fleet: Fleet

    var body: some View {
        #if targetEnvironment(macCatalyst)
        if CommandHold.shared.isHeld, let shortcut = fleet.tabs.shortcut(of: key) {
            ShortcutHint(number: shortcut)
                .padding(.horizontal, 3)
                .background(Theme.plainBackground, in: .capsule)
        }
        #endif
    }
}

/// A ⌘ key's number, as a tab has it (`TabStrip`).
struct ShortcutHint: View {
    let number: Int

    var body: some View {
        Text("⌘\(number)")
            .font(.app.caption2.weight(.medium).monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
