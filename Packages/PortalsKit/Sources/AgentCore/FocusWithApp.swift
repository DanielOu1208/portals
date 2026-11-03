import Foundation

/// The composer's focus as the app stops and starts being the one in use (`ChatScreen`),
/// and as something opens over the chat and closes.
/// On a Mac the focus goes with the app (another app in front, the window hidden) and comes
/// back with it: that is not you starting to type, and the chat stays where it was. Focus
/// moved elsewhere on purpose while the app was not in use (a card asking for an answer
/// came in) does not come back: once the app has been in use a moment (`settle`) without
/// it, it is taken as gone, and the next focus is you starting to type again.
/// The same on a Mac with a panel opened over the chat (a visual expanded, what a turn
/// changed, a file): the panel takes the focus while it is open and gives it back as it
/// closes, which glided a chat scrolled up to a visual to its end (2026-10-20).
/// Focus that comes back as the panel closes, or within `settle` of it, is not typing.
public struct FocusWithApp: Sendable, Equatable {
    /// How long after the app is in use again the focus has to come back with it; and after
    /// what was open over the chat has closed.
    public static let settle: Duration = .seconds(1)

    /// The focus went with the app, and may come back with it.
    public private(set) var leftWithApp = false
    /// Counts the times the app became the one in use, or the focus went with it: only the
    /// latest return's moment settles anything (`settled`).
    private var returns = 0

    /// Whether something is open over the chat (`coverOpened`).
    public private(set) var isCovered = false
    /// Something has been open over the chat since the composer lost its focus, or opened
    /// as it lost it (which of the two is said first is not known): focus coming back now
    /// is that thing giving it back.
    private var coveredSinceLoss = false
    /// Counts the times what was open over the chat closed: only the latest closing's
    /// moment settles anything (`coverSettled`).
    private var closings = 0

    public init() {}

    /// The composer lost its focus; `appActive`, whether the app was still the one in use.
    public mutating func lost(appActive: Bool) {
        leftWithApp = !appActive
        if !appActive { returns += 1 }
        coveredSinceLoss = isCovered
    }

    /// The app became the one in use again: what to settle this return with, `settle` later.
    public mutating func appBecameActive() -> Int {
        returns += 1
        return returns
    }

    /// The composer has its focus again: true when it is you starting to type, false when
    /// it came back with the app, or as what was open over the chat closed.
    public mutating func gained() -> Bool {
        defer {
            leftWithApp = false
            coveredSinceLoss = false
        }
        return !leftWithApp && !coveredSinceLoss
    }

    /// The return `token` names (`appBecameActive`) has lasted `settle`, and the composer
    /// has its focus or not. Nothing if the app has left, or come back again, since: that
    /// return's own moment settles it.
    public mutating func settled(_ token: Int, composing: Bool) {
        guard token == returns else { return }
        if !composing { leftWithApp = false }
    }

    /// Something opened over the chat. Focus the composer loses while it is open, or lost
    /// a moment ago as it opened, is taken as gone with it.
    public mutating func coverOpened() {
        isCovered = true
        coveredSinceLoss = true
    }

    /// What was open over the chat closed: what to settle this closing with, `settle` later.
    public mutating func coverClosed() -> Int {
        isCovered = false
        closings += 1
        return closings
    }

    /// The closing `token` names (`coverClosed`) has lasted `settle`: focus that has not come
    /// back by now was not given back, and the next focus is you starting to type. Nothing
    /// if something has opened, or closed again, since.
    public mutating func coverSettled(_ token: Int) {
        guard token == closings, !isCovered else { return }
        coveredSinceLoss = false
    }
}
