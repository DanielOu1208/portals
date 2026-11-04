import Foundation

/// A host that keeps the title the user gives a thread as its own name for it (an
/// Portals bridge's `rename`), so it shows at the desk too. Elsewhere a rename stays
/// in the app.
public protocol ThreadRenaming: Sendable {
    /// Whether the host takes titles, as of the last connection; nil before the first.
    var renamesThreads: Bool? { get async }
    func rename(_ thread: ThreadRef, to title: String) async throws
}

/// What a thread is doing on its host, for the list: a turn running, or waiting on an
/// answer from you.
public enum ThreadActivity: String, Hashable, Sendable {
    case running, waiting
}

/// A host that says which of its threads are at work, whether this app follows them or
/// not (a Portals bridge's `activity`), so the list can show a turn started at the
/// desk, or an approval waiting, in a thread not opened since the app started.
public protocol ThreadActivityReporting: Sendable {
    /// Whether the host says, as of the last connection; nil before the first.
    var reportsActivity: Bool? { get async }
    /// The threads running or waiting now, and where the host's list is.
    func threadActivity() async throws -> ThreadActivityReport
}

/// A host that says when something its poll reads has moved (a Portals bridge's
/// `poll_now`): its list of threads, a thread starting or stopping work or needing an
/// answer, its agents' looks or the sidebar's order. The device then polls at once
/// (`HostSync.hostMoved`), its sidebar out or not, where it would otherwise learn of it at
/// its next poll, and only while the sidebar is out.
public protocol HostMoveReporting: Sendable {
    /// Whether the host says, as of the last connection; nil before the first.
    var reportsMoves: Bool? { get async }
    /// Each time the host says so, from any connection, for as long as the backend lives.
    /// One consumer.
    var hostMoves: AsyncStream<Void> { get }
}

/// What a host said is at work, as it was asked every few seconds.
public struct ThreadActivityReport: Hashable, Sendable {
    /// The threads running or waiting now; the rest are idle.
    public var threads: [ThreadRef.ID: ThreadActivity]
    /// Of `threads`, those running only for the threads started from them at work (a
    /// bridge's `inherited`, feature agent_threads): no turn of their own runs, and their
    /// own chat, which knows of no thread they started, does not say all of their state.
    public var inherited: Set<ThreadRef.ID>
    /// Of `threads`, those running with no turn of their own, for their subagents or
    /// workflows or `inherited` (a bridge's `turn: false`): their turn's end was told when
    /// it came, and their leaving the report ends none.
    public var withoutTurn: Set<ThreadRef.ID>
    /// The list a host that keeps the list of threads for every device keeps, and its
    /// revision now: when it is not the one merged last, something changed. nil from any
    /// other host.
    public var list: ThreadListRevision?
    /// Where a host that keeps its agents' looks for every device has got with them
    /// (`LookSyncing`): when it is not what the device took last, a look changed. nil
    /// from any other host.
    public var looks: LookListRevision?
    /// Where a host that keeps the sidebar's order for every device has got with it
    /// (`SidebarOrderSyncing`): when it is not what the device took last, a row was
    /// moved. nil from any other host.
    public var order: SidebarOrderRevision?
    /// A later version of the host's bridge that is out, when a host that says so
    /// (`HostUpdate`) has one; nil when it has none, and from any other host.
    public var update: String?
    /// The free space on the host's disk, from a host that says it (`HostDisk`); nil from
    /// any other host.
    public var disk: HostDisk?

    public init(
        threads: [ThreadRef.ID: ThreadActivity] = [:], inherited: Set<ThreadRef.ID> = [], withoutTurn: Set<ThreadRef.ID> = [],
        list: ThreadListRevision? = nil, looks: LookListRevision? = nil, order: SidebarOrderRevision? = nil, update: String? = nil,
        disk: HostDisk? = nil
    ) {
        self.threads = threads
        self.inherited = inherited
        self.withoutTurn = withoutTurn
        self.list = list
        self.looks = looks
        self.order = order
        self.update = update
        self.disk = disk
    }
}

extension ThreadActivityReport {
    /// Of the threads an earlier report had at work (`threads`, `withoutTurn`), those this
    /// one has not whose turn ended since: not one that ran no turn of its own then, kept
    /// at work by its subagents or by threads it started, whose turn had ended, and been
    /// told, before (Codex's review of n14/foot, and 2026-10-27, of the same for a
    /// thread kept at work by its subagents: "yes fix that"): an unseen dot for a turn it
    /// never ran.
    public func ended(since threads: [ThreadRef.ID: ThreadActivity], withoutTurn: Set<ThreadRef.ID>) -> [ThreadRef.ID] {
        threads.keys.filter { self.threads[$0] == nil && !withoutTurn.contains($0) }
    }
}

extension ThreadRecord {
    /// A title as the user typed it, made fit for a list: one line, runs of spaces as
    /// one, at most 200 characters. nil when nothing is left.
    public static func tidyTitle(_ title: String) -> String? {
        let words = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !words.isEmpty else { return nil }
        return String(words.prefix(200))
    }
}
