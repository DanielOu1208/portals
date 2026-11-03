import Foundation

/// What a host's screens do as the app leaves and comes back to the front (`HostModel`):
/// the connection the app let go of for being away shows as it was left, and what the
/// host says while the app catches up is shown without the screens' animations.
///
/// In the background the app closes every host's connection, and opens it again on its
/// way back. Shown as it is, that is "Not connected", then "Connecting…", then the host's
/// name again, a Retry button coming and going in the sidebar, and on the iPhone the
/// chat's banner over the header when the app was away longer than its grace. None of it
/// is news: the app did it itself. So a connection that was up when the app left shows
/// as up (`shown`) until the host answers again, the attempt fails, or the app has been
/// back `grace` without the host answering (then it is news, and shows).
///
/// Then the list, the groups and the agents catch up with what changed while the app was
/// away. Shown with the sidebar's animations, a thread that ended meanwhile glides from
/// Running to Finished in front of you as if it moved just then. For `quiet` seconds from
/// the return, and from the reconnect after it, they take their places at once
/// (`isQuiet`).
public struct ComingBack: Sendable {
    /// How long after coming back the connection shows as it was left while the host is
    /// reached again; a reconnect usually takes a fraction of it.
    public static let grace: Duration = .seconds(3)
    /// How long the catch-up goes without animations, from the return and from the
    /// reconnect after it.
    public static let quiet: TimeInterval = 4

    /// The connection was up when the app let go of it, and it has not shown otherwise
    /// since: it shows as up (`shown`).
    public private(set) var isAway = false
    /// Counts the times the app left, so that the grace of a return the app left again
    /// before its end does not end the next one's.
    private var departures = 0
    /// Until when the catch-up is quiet (`isQuiet`).
    public private(set) var quietUntil = Date.distantPast

    public init() {}

    /// The app leaves the screen and lets go of the connection, which was `connected` or
    /// not.
    public mutating func left(connected: Bool) {
        departures += 1
        if connected { isAway = true }
    }

    /// The app is back at `now`. When the connection still shows as it was left, what to
    /// end its grace with (`graceEnded`), once `grace` has passed.
    public mutating func back(at now: Date) -> Int? {
        quietUntil = now.addingTimeInterval(Self.quiet)
        return isAway ? departures : nil
    }

    /// The grace of the return `back` gave `token` for is over: the connection shows as it
    /// is, unless the app has left again since.
    public mutating func graceEnded(_ token: Int) {
        if token == departures { isAway = false }
    }

    /// The connection is now `state`. Up again, or failing, it shows as it is from now
    /// on; the app's own letting go of it (no reason) and the attempt to reconnect change
    /// nothing shown. Up again soon after a return, the catch-up after it is quiet too.
    public mutating func connection(_ state: ConnectionState, at now: Date) {
        switch state {
        case .connected:
            if isAway || now < quietUntil { quietUntil = now.addingTimeInterval(Self.quiet) }
            isAway = false
        case .stopped:
            isAway = false
        case let .disconnected(reason):
            if reason != nil { isAway = false }
        case .connecting:
            break
        }
    }

    /// The connection as the screens show it.
    public func shown(_ state: ConnectionState) -> ConnectionState {
        isAway ? .connected : state
    }

    /// Whether what the host says now is shown without animations: the app is catching
    /// up after coming back.
    public func isQuiet(at now: Date) -> Bool {
        now < quietUntil
    }
}

extension ThreadRecord {
    /// `threads` as the sidebar lists them, with the thread in sight (its chat on the
    /// screen, the app in front or not) seen: never under Finished, however the turn
    /// that ended in it while the app was away was marked. Shown there, it would be
    /// there as the app came back and leave once the host was told it was seen, moving
    /// the list in front of you; the host is told as before, and other devices list it
    /// as the host says.
    public static func inSight(_ key: ThreadKey?, of threads: [ThreadRecord]) -> [ThreadRecord] {
        guard let key, let index = threads.firstIndex(where: { $0.key == key }), threads[index].isUnseen else { return threads }
        var shown = threads
        shown[index].unseen = nil
        return shown
    }
}

/// What a thread's stream brings while a catch-up replays what the thread missed (a bridge's
/// `resume_replay`, `ThreadCatchingUp`): held, and given back all at once with the catch-up's
/// end (`.caughtUp`), so that what shows the thread takes it in at once. Applied as it came,
/// a frame could show it half done: a turn that ended while the app was away seen running,
/// its thread in Running for a moment, and gone again. Held from `begin()` (a catch-up the
/// thread asked for) or from `.catchUpBegan` on the stream (one the backend makes by itself
/// on reconnecting, for a thread that was running when the connection went).
public struct CatchUpHold: Sendable {
    public private(set) var isHolding = false
    private var held: [ThreadEvent] = []

    public init() {}

    /// A catch-up begins: what comes from now on is held until its end.
    public mutating func begin() {
        isHolding = true
    }

    /// The events to apply now, `event` being the next the stream brought: it alone when
    /// nothing is held; none while a catch-up is under way; everything held, then it, at
    /// the catch-up's end.
    public mutating func take(_ event: ThreadEvent) -> [ThreadEvent] {
        if case .catchUpBegan = event {
            isHolding = true
            return []
        }
        guard isHolding else { return [event] }
        if case .caughtUp = event { return end() + [event] }
        held.append(event)
        return []
    }

    /// The catch-up ended without its end on the stream (it failed, or the thread is taken
    /// whole on a new stream): what was held, which is given back once.
    public mutating func end() -> [ThreadEvent] {
        isHolding = false
        defer { held = [] }
        return held
    }
}
