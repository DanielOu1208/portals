import Foundation

// How an agent looks, kept by its host for every device (a Portals bridge's
// `agent_looks`): what the app reads of it, what it sends, and what a device does about
// one agent's look once it knows the host's.
//
// The host's look is the one every device draws. A device sends a look only when the
// host has none for the agent, when the user chose one here, or, the first time, when
// it holds a choice made before the host kept looks and the host has only one an app
// gave.

/// Which looks a host keeps, and how far they have got: the id of its list of them, and
/// its revision, which goes up with every change.
public struct LookListRevision: Hashable, Sendable {
    public var id: String
    public var revision: Int

    public init(id: String, revision: Int) {
        self.id = id
        self.revision = revision
    }
}

/// A look as a host keeps it: with who decided it.
public struct HostLook: Hashable, Sendable {
    public var look: AgentLook
    public var origin: LookOrigin

    public init(_ look: AgentLook, origin: LookOrigin) {
        self.look = look
        self.origin = origin
    }
}

/// The looks a host keeps, by agent name, and where its list of them was then.
public struct HostLooks: Hashable, Sendable {
    public var list: LookListRevision
    public var looks: [String: HostLook]

    public init(list: LookListRevision, looks: [String: HostLook] = [:]) {
        self.list = list
        self.looks = looks
    }
}

/// When a host leaves the look it has for an agent as it is, given another.
public enum LookCondition: String, Hashable, Sendable {
    /// When it has any look for the agent.
    case any
    /// When it has one somebody chose by hand.
    case chosen
}

/// Where a look on this device stands with the host that keeps it.
public enum LookSyncState: String, Codable, Hashable, Sendable {
    /// The host has this look, as of the last time it said or was told.
    case kept
    /// Chosen here since: the host has not taken it yet.
    case pending

    /// Where a look just chosen by hand stands, with a host that keeps looks, one that
    /// keeps none (nil: the look is the device's own), or one that has not said yet on
    /// this launch's connection (`keeps` nil): pending wherever the host may keep it, so
    /// a choice made while the app connects is sent and not taken for an old one.
    public static func chosen(hostKeepsLooks keeps: Bool?) -> LookSyncState? {
        keeps == false ? nil : .pending
    }
}

/// A host that keeps how its agents look for every device (a Portals bridge's
/// `agent_looks`). Elsewhere a look is the device's own. Each call throws
/// `LookSyncError.unavailable`, sending nothing, to a host that keeps none.
public protocol LookSyncing: Sendable {
    /// Whether the host keeps looks, as of the last connection; nil before the first.
    var syncsLooks: Bool? { get async }
    /// Every look the host keeps.
    func hostLooks() async throws -> HostLooks
    /// Gives an agent a look for every device, unless the host has one that `unless`
    /// says to leave; a look somebody chose is never replaced by one an app gave.
    /// Answers with the look the agent has on the host now.
    func setLook(_ look: HostLook, for agent: Agent.ID, unless: LookCondition?) async throws -> HostLook
}

public enum LookSyncError: LocalizedError, Hashable, Sendable {
    /// The host keeps no looks (an older bridge, Hermes): nothing was sent.
    case unavailable

    public var errorDescription: String? {
        "This host does not keep how its agents look for every device."
    }
}

/// A look as this device holds it for one agent.
public struct HeldLook: Hashable, Sendable {
    public var look: AgentLook
    /// nil for a look saved before origins were kept.
    public var origin: LookOrigin?
    /// nil for a look that was never the host's: the device's own so far.
    public var state: LookSyncState?

    public init(_ look: AgentLook, origin: LookOrigin? = nil, state: LookSyncState? = nil) {
        self.look = look
        self.origin = origin
        self.state = state
    }
}

/// What a device does about one agent's look, knowing what its host keeps for it.
public enum LookStep: Hashable, Sendable {
    /// Draw the agent as the host has it.
    case take(HostLook)
    /// Tell the host, which leaves its own as it is in the case `unless` names.
    case send(HostLook, unless: LookCondition?)

    /// The step for an agent this device holds `held` for and the host keeps `host`
    /// for; nil when there is nothing to do.
    ///
    /// - A look chosen here that the host has not taken is sent, and replaces whatever
    ///   the host has.
    /// - Otherwise the host's look is taken. The one exception is a look this device
    ///   chose before the host kept looks (or one from before origins were kept, which
    ///   may have been chosen): it is sent when the host has only a look an app gave,
    ///   and the host keeps a chosen one of its own.
    /// - With none on the host, the device's is sent, for an agent that still has none
    ///   there when it arrives: of two devices that meet a new agent, the first one's
    ///   look is everyone's.
    public static func step(held: HeldLook?, host: HostLook?) -> LookStep? {
        guard let held else { return host.map { .take($0) } }
        if held.state == .pending { return .send(HostLook(held.look, origin: .chosen), unless: nil) }
        guard let host else { return .send(HostLook(held.look, origin: held.origin ?? .chosen), unless: .any) }
        if held.state == nil, held.origin != .assigned, host.origin == .assigned, held.look != host.look {
            return .send(HostLook(held.look, origin: .chosen), unless: .chosen)
        }
        if held.state == .kept, held.look == host.look, held.origin == host.origin { return nil }
        return .take(host)
    }

    /// Whether the host's answer to `sent` (on the condition `unless`) is the look to draw
    /// now, for an agent this device holds `held` for: not when a look was chosen here
    /// since it was sent, unless that choice is what was sent, as chosen and on no
    /// condition. A choice that happens to be a look an app gave, or one sent only where
    /// the host had no choice of its own, is still a choice, and goes next.
    public static func answerSettles(_ held: HeldLook?, sent: HostLook, unless: LookCondition?) -> Bool {
        guard let held, held.state == .pending else { return true }
        return held.look == sent.look && sent.origin == .chosen && unless == nil
    }
}
