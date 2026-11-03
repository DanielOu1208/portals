import Foundation

/// When a sidebar's hints of the ⌘ keys show (`CommandHold` in the app): ⌘ held alone for a
/// moment, so that ⌘C, ⌘T or a quick ⌘1 flashes none; gone at once as it is let go, as
/// another key or modifier comes with it, or as the window or app loses the keyboard, which
/// ⌘-Tab does with no key coming up (2026-11-02: "if we click command it should also
/// show the hint for the hotkey to go to that session if it is tabbed").
public struct CommandHoldState: Equatable, Sendable {
    public enum Modifiers: Equatable, Sendable {
        case none, commandAlone, others
    }

    private enum Phase {
        case free
        /// ⌘ alone, for less than the moment so far.
        case waiting
        case shown
        /// Something came with ⌘: nothing shows until every modifier is let go.
        case spoiled
    }

    /// How long ⌘ is held alone before the hints show.
    public static let delay: Duration = .milliseconds(250)

    private var phase = Phase.free

    public init() {}

    public var isShown: Bool { phase == .shown }
    public var isWaiting: Bool { phase == .waiting }

    /// The modifier keys held changed.
    public mutating func modifiersChanged(to modifiers: Modifiers) {
        switch modifiers {
        case .none: phase = .free
        case .others: phase = .spoiled
        case .commandAlone: if phase == .free { phase = .waiting }
        }
    }

    /// A key other than a modifier went down, with `modifiers` held. With none, whatever was
    /// held was let go unheard (in a menu, say), and the next ⌘ is a new one.
    public mutating func keyPressed(with modifiers: Modifiers) {
        if modifiers == .none {
            phase = .free
        } else if phase != .free {
            phase = .spoiled
        }
    }

    /// ⌘ has been held alone for the moment.
    public mutating func delayEnded() {
        if phase == .waiting { phase = .shown }
    }

    /// The window or app lost the keyboard, or got it back: whatever is held may have been
    /// let go elsewhere. A ⌘ still held from before stays without hints, until it comes
    /// down again.
    public mutating func focusChanged() {
        phase = .free
    }
}
