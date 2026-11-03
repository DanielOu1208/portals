import Foundation

/// How long a tool call stays on a running turn's status line (2026-10-23: "make
/// tool calls last on screen for a minimum time before they disapear bc rn they disapear
/// very fast"). A call shown on the line stays there at least `minimum` seconds, 1.5,
/// before the line moves on to what the agent does next ("Thinking…", the next call). What
/// comes while a call is held does not queue behind it, or the line would fall behind the
/// agent: when the held call's time is up the line shows the newest thing then, skipping
/// the ones in between. The hold also outlasts the agent saying something (a new stretch
/// of work, `scope`) and the line going while its words are written (`nil`), which is when
/// most calls of an agent that talks between its steps went at once: having tried 1.5 s
/// held only within a stretch, 2026-10-23: "i still think tool calls appear for
/// too short of a time"; kept at 1.5 s, the word, once that was found). Only the agent
/// waiting for the user is shown at once (the turn's end takes the line away whatever it
/// holds). Pure: the time is given, and `due` says when
/// to look again, only while a call is held with something else waiting, so nothing runs
/// when nothing changes.
public struct StatusHold: Hashable, Sendable {
    /// How long a call stays on the line, at least.
    public static let standard: TimeInterval = 1.5

    /// How long a call stays on the line at least; zero holds nothing.
    public let minimum: TimeInterval
    /// What the line shows now.
    public private(set) var shown: RunStatus?
    /// The line shows a call that has given way to something newer, kept only for its
    /// title: what was live about it (its output, the calls beside it) is not current,
    /// so `shown` holds it with none beside it and the line shows no output for it.
    public private(set) var isHolding = false
    /// When to call `tick` again: the held call's time is up while something newer
    /// waits. Nil when nothing waits.
    public private(set) var due: Date?

    /// The newest status, and the stretch of work it is in, shown once a hold is up.
    private var latest: RunStatus?
    private var latestScope: UUID?
    /// The call on the line: its id, the stretch it is in and since when it is shown.
    private var held: Held?

    private struct Held: Hashable, Sendable {
        var id: String
        var scope: UUID?
        var since: Date
    }

    public init(minimum: TimeInterval = StatusHold.standard) {
        self.minimum = max(0, minimum)
    }

    /// The agent's status changed: `status` is what it does now, `scope` the stretch of
    /// work it is in (`TurnLayout.UnderWay.id`), which changes when the agent says something.
    public mutating func update(_ status: RunStatus?, scope: UUID?, at now: Date) {
        latest = status
        latestScope = scope
        settle(at: now)
    }

    /// The time `due` named has come: the line moves on to the newest status.
    public mutating func tick(at now: Date) {
        settle(at: now)
    }

    private mutating func settle(at now: Date) {
        if let held, let end = holdEnd(of: held), now < end, holds(against: latest) {
            due = end
            if !isHolding, case let .tool(run, others)? = shown, others > 0 {
                shown = .tool(run, others: 0)
            }
            isHolding = true
            return
        }
        due = nil
        isHolding = false
        shown = latest
        if case let .tool(run, _)? = latest {
            // The same call again (its output, another beside it) is updated in place and
            // keeps its time; a new one starts its own.
            if held?.id != run.id || held?.scope != latestScope {
                held = Held(id: run.id, scope: latestScope, since: now)
            }
        } else {
            held = nil
        }
    }

    private func holdEnd(of held: Held) -> Date? {
        minimum > 0 ? held.since.addingTimeInterval(minimum) : nil
    }

    /// Whether the held call stays in place of `status`.
    private func holds(against status: RunStatus?) -> Bool {
        guard let held else { return false }
        switch status {
        case .waitingForUser?:
            // The agent waits for the user: shown at once.
            return false
        case let .tool(run, _)?:
            return run.id != held.id || held.scope != latestScope
        case nil, .thinking?, .note?, .headline?:
            // Its words being written, or a new stretch of work after them, wait too; so
            // does what the agent says it is working on.
            return true
        }
    }
}
