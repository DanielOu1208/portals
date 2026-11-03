import Foundation

/// A host that lists a thread an agent started from another of its threads (with
/// `portals start`, through the host's fleet) under that thread, and not in the sidebar,
/// and keeps for every device which of them someone showed in the sidebar too
/// (`ThreadRecord.shared`): a Portals bridge's `agent_threads`. Elsewhere such a
/// thread is listed like any other.
public protocol AgentThreadNesting: Sendable {
    /// Whether the host does, as of the last connection; nil before the first.
    var nestsAgentThreads: Bool? { get async }
}

extension ThreadRecord {
    /// The thread an agent started this one from, when that is one of its host's.
    public var startedFrom: ThreadKey? {
        startedBy?.thread.map { ThreadKey(host: key.host, id: $0) }
    }

    /// The thread an agent started this one from, on its host or on another Mac the app
    /// knows: `machines` are the app's hosts by their stable ids (`HostConfig.machineID`),
    /// and a thread started from another Mac's thread says that Mac's id (`senders`).
    public func startedFrom(machines: [String: HostID]) -> ThreadKey? {
        if let here = startedFrom { return here }
        guard let from = startedBy?.from, let machine = from.machine, let thread = from.thread,
              let host = machines[machine], host != key.host else { return nil }
        return ThreadKey(host: host, id: ThreadRef.ID(rawValue: thread))
    }
}

/// The threads agents started from other threads, which a host that nests them
/// (`AgentThreadNesting`) lists under the thread that started them, at the foot of its
/// chat, as that thread's subagents are.
public enum StartedThreads {
    /// The threads of `threads` listed under the thread that started them, shown in the
    /// sidebar too or not: on a host in `nesting`, started from one of its threads with an
    /// agent the sidebar lists (`listed`). Show in sidebar and Hide are for these alone.
    ///
    /// One started from a thread the sidebar does not list is in the sidebar as any thread
    /// is, since nothing else would show it: one gone from the list; one of an agent the
    /// host no longer has, or does not list (Aeri, on a bridge from before 2026-10-21).
    /// One started from another Mac's thread is under it when the app has that Mac as a
    /// host too, known by its stable id (`machines`, `startedFrom(machines:)`).
    public static func nested(
        _ threads: [ThreadRecord], nesting: Set<HostID>, listed agents: Set<Agent.ID>, machines: [String: HostID] = [:]
    ) -> Set<ThreadKey> {
        guard !nesting.isEmpty else { return [] }
        let starters = Set(threads.lazy.filter { agents.contains($0.ref.agent) }.map(\.key))
        var nested = Set<ThreadKey>()
        for record in threads where nesting.contains(record.key.host) {
            guard let parent = record.startedFrom(machines: machines), parent != record.key, starters.contains(parent) else { continue }
            nested.insert(record.key)
        }
        return nested
    }

    /// The hosts by their Macs' stable ids, for a thread started from another Mac's
    /// (`startedFrom(machines:)`): the first host of a Mac added twice.
    public static func machines(of hosts: [HostConfig]) -> [String: HostID] {
        var machines: [String: HostID] = [:]
        for host in hosts {
            if let id = host.machineID, machines[id] == nil { machines[id] = host.id }
        }
        return machines
    }

    /// Of `threads`, the ones under the thread that started them (`nested`) and not
    /// shown in the sidebar too (`isShared`): not in the sidebar.
    public static func tucked(
        _ threads: [ThreadRecord], nesting: Set<HostID>, listed agents: Set<Agent.ID>, machines: [String: HostID] = [:]
    ) -> Set<ThreadKey> {
        tucked(threads, nested: nested(threads, nesting: nesting, listed: agents, machines: machines))
    }

    static func tucked(_ threads: [ThreadRecord], nested: Set<ThreadKey>) -> Set<ThreadKey> {
        guard !nested.isEmpty else { return [] }
        return Set(threads.lazy.filter { !$0.isShared && nested.contains($0.key) }.map(\.key))
    }

    /// The thread `record` was started from, for the back button over its chat: found by
    /// `find` on its Mac, or on another the app has as a host (`startedFrom(machines:)`), and
    /// only one that opens, of an agent its host has (`opens`), as the sidebar lists only
    /// those: a host opens no thread of an agent it no longer has.
    public static func parent(
        of record: ThreadRecord, machines: [String: HostID] = [:], find: (ThreadKey) -> ThreadRecord?, opens: (Agent.ID) -> Bool
    ) -> ThreadRecord? {
        guard let key = record.startedFrom(machines: machines), key != record.key,
              let parent = find(key), opens(parent.ref.agent) else { return nil }
        return parent
    }

    /// The threads started from `parent` among `threads`, in the order they were started:
    /// with `machines`, those of other hosts started from it on its Mac too.
    public static func started(from parent: ThreadKey, in threads: [ThreadRecord], machines: [String: HostID] = [:]) -> [ThreadRecord] {
        threads
            .filter { $0.startedFrom(machines: machines) == parent && $0.key != parent }
            .sorted { ($0.ref.createdAt, $0.id.rawValue) < ($1.ref.createdAt, $1.id.rawValue) }
    }
}
