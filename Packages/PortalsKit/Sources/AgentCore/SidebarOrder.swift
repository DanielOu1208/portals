import Foundation

// The order the user gave a host's agents and folders in the sidebar: how the rows are
// arranged by it, how a row is moved, and what a device does with the order of a host
// that keeps it for every device (a Portals bridge's `sidebar_order`).
//
// Threads are not arranged: pinned ones first, then the most recently active.
//
// The user's Macs are arranged too (`MachineOrder`). That order is no one host's: every
// host that keeps orders keeps a copy of it, and the one arranged last is everyone's.

/// The order the user gave one host's agents and folders. An empty list is no order: the
/// agents as the host lists them, the folders by when each was last worked in (in a
/// space, by when each was first seen: `SidebarSpace.folders`).
public struct SidebarOrder: Hashable, Codable, Sendable {
    /// What a list arranges.
    public enum Kind: String, Codable, Hashable, Sendable, CaseIterable {
        case agents, folders
    }

    /// The agents' names, first to last.
    public var agents: [String]
    /// The folders' full paths on the host, first to last.
    public var folders: [String]

    public init(agents: [String] = [], folders: [String] = []) {
        self.agents = agents
        self.folders = folders
    }

    public subscript(kind: Kind) -> [String] {
        get {
            switch kind {
            case .agents: agents
            case .folders: folders
            }
        }
        set {
            switch kind {
            case .agents: agents = newValue
            case .folders: folders = newValue
            }
        }
    }

    /// The host's agents as the sidebar lists them: the ones the user placed, in that
    /// order, then the others as the host lists them. A new agent comes last.
    public func arranged(_ listed: [Agent]) -> [Agent] {
        guard !agents.isEmpty else { return listed }
        let place = Self.places(agents)
        let placed = listed.filter { place[$0.id.name] != nil }.sorted { place[$0.id.name]! < place[$1.id.name]! }
        return placed + listed.filter { place[$0.id.name] == nil }
    }

    /// The host's folders as the sidebar lists them, from `byLastUse`, the one worked in
    /// last first: with no order, as they are. With one, the folders the user placed in
    /// that order, after any that are not on the list, which stay by last use: a new
    /// folder is on top.
    public func arranged<Row>(_ byLastUse: [Row], path: (Row) -> String) -> [Row] {
        guard !folders.isEmpty else { return byLastUse }
        let place = Self.places(folders)
        var placed: [(row: Row, place: Int)] = []
        var others: [Row] = []
        for row in byLastUse {
            if let at = place[path(row)] {
                placed.append((row, at))
            } else {
                others.append(row)
            }
        }
        return others + placed.sorted { $0.place < $1.place }.map(\.row)
    }

    /// The host's folders as a space lists them (`SidebarSpace`), from `rows`, in an
    /// order of their own that work starting or ending in them does not change: the
    /// folders the user placed first, in that order, then the others as they are. A new
    /// folder comes after the ones placed.
    public func placedFirst<Row>(_ rows: [Row], path: (Row) -> String) -> [Row] {
        guard !folders.isEmpty else { return rows }
        let place = Self.places(folders)
        let placed = rows.filter { place[path($0)] != nil }.sorted { place[path($0)]! < place[path($1)]! }
        return placed + rows.filter { place[path($0)] == nil }
    }

    /// `names`, the rows of one kind as the sidebar lists them now, with `moved` taken
    /// out and put just before `target`, or last when there is no target. Unchanged when
    /// `moved` is not among them, or is its own target; a target that is not among them
    /// puts it last.
    public static func moving(_ moved: String, before target: String?, in names: [String]) -> [String] {
        guard moved != target, names.contains(moved) else { return names }
        var names = names.filter { $0 != moved }
        if let target, let at = names.firstIndex(of: target) {
            names.insert(moved, at: at)
        } else {
            names.append(moved)
        }
        return names
    }

    private static func places(_ names: [String]) -> [String: Int] {
        Dictionary(names.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
    }
}

/// A move of an agent's or a folder's row among the rows listed with it, as its menu
/// offers it.
public enum SidebarMove: String, CaseIterable, Hashable, Sendable {
    case up, down, top, bottom

    /// What the move comes to for the row `id` among `siblings`, the rows listed with it
    /// in their order: the row to put just before `before`, or after them all when
    /// there is none (`SidebarOrder.moving`). nil when the row is at that end already,
    /// and for a move to an end that one place up or down makes as well.
    public func step<ID: Equatable>(of id: ID, among siblings: [ID]) -> (moved: ID, before: ID?)? {
        guard let at = siblings.firstIndex(of: id) else { return nil }
        let last = siblings.count - 1
        switch self {
        case .up: return at > 0 ? (id, siblings[at - 1]) : nil
        // Down one place: the row under it goes before it.
        case .down: return at < last ? (siblings[at + 1], id) : nil
        case .top: return at > 1 ? (id, siblings[0]) : nil
        case .bottom: return at < last - 1 ? (id, nil) : nil
        }
    }
}

// MARK: - The Macs

/// The order the user gave their Macs, each named by the id its bridge gave itself
/// (`HostConfig.machineID`), with when they were arranged. Every host that keeps orders
/// keeps a copy (a Portals bridge's `machine_order`), and a copy is replaced only by
/// one arranged later: a device takes the newest it finds, lists its Macs by it, and
/// gives it to any host that is behind.
public struct MachineOrder: Hashable, Codable, Sendable {
    /// The Macs' ids, first to last. One this device has not been given is kept.
    public var ids: [String]
    /// When they were arranged, in milliseconds since 1970 by the clock of the device
    /// they were arranged on.
    public var at: Int

    public init(ids: [String], at: Int) {
        self.ids = ids
        self.at = at
    }

    /// The newest of the orders given (`isLater`); nil with none.
    public static func newest(_ orders: [MachineOrder?]) -> MachineOrder? {
        orders.compactMap(\.self).reduce(nil) { newest, order in order.isLater(than: newest) ? order : newest }
    }

    /// Whether this order replaces `other`: arranged later, or, arranged at the same
    /// moment on two devices, the one whose ids come later when joined. The bridges
    /// decide the same way (`isLaterMachineOrder` in bridge/src/order.ts), so two such
    /// orders end the same on every bridge and device. Any order replaces none.
    public func isLater(than other: MachineOrder?) -> Bool {
        guard let other else { return true }
        if at != other.at { return at > other.at }
        let key = ids.joined(separator: "\n"), otherKey = other.ids.joined(separator: "\n")
        return key != otherKey && key > otherKey
    }

    /// This device's Macs as the order lists them. A Mac that is not on the list (one
    /// whose bridge gave no id, or added since) stays in the place it has, and the
    /// others take the remaining places in the list's order.
    public func arranged<Row>(_ rows: [Row], id: (Row) -> String?) -> [Row] {
        let place = Dictionary(ids.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
        let listed = rows.enumerated().compactMap { index, row in id(row).flatMap { place[$0] }.map { (slot: index, row: row, place: $0) } }
        var arranged = rows
        for (slot, entry) in zip(listed.map(\.slot), listed.sorted { $0.place < $1.place }) {
            arranged[slot] = entry.row
        }
        return arranged
    }

    /// The order after the user arranged this device's Macs: `shown`, their ids as the
    /// device lists them now. A Mac this device does not have keeps its place after the
    /// Mac it followed. `now` is the device's clock, in milliseconds since 1970; the
    /// order is always later than the one it replaces, whatever the clock says.
    public func rearranged(_ shown: [String], now: Int) -> MachineOrder {
        let known = Set(shown)
        var arranged = shown
        // What the next Mac this device does not have comes after.
        var last: String?
        for id in ids {
            if !known.contains(id) {
                arranged.insert(id, at: last.flatMap { arranged.firstIndex(of: $0) }.map { $0 + 1 } ?? 0)
            }
            last = id
        }
        return MachineOrder(ids: arranged, at: max(now, at + 1))
    }
}

// MARK: - An order every device shares

/// Which order a host keeps, and how far it has got: its id, and its revision, which
/// goes up with every change.
public struct SidebarOrderRevision: Hashable, Codable, Sendable {
    public var id: String
    public var revision: Int

    public init(id: String, revision: Int) {
        self.id = id
        self.revision = revision
    }
}

/// The order a host keeps, and where it was then.
public struct HostSidebarOrder: Hashable, Sendable {
    public var list: SidebarOrderRevision
    public var order: SidebarOrder
    /// The host's copy of the order of the user's Macs; nil from a host that keeps
    /// none, or has never been given one.
    public var machines: MachineOrder?

    public init(list: SidebarOrderRevision, order: SidebarOrder = SidebarOrder(), machines: MachineOrder? = nil) {
        self.list = list
        self.order = order
        self.machines = machines
    }
}

/// A host that keeps the sidebar's order for every device (a Portals bridge's
/// `sidebar_order`). Elsewhere the order is the device's own. Each call throws
/// `SidebarOrderError.unavailable`, sending nothing, to a host that keeps none.
public protocol SidebarOrderSyncing: Sendable {
    /// Whether the host keeps the order, as of the last connection; nil before the first.
    var syncsSidebarOrder: Bool? { get async }
    /// Both lists as the host keeps them.
    func sidebarOrder() async throws -> HostSidebarOrder
    /// Replaces the lists given, each whole; one left out stays as the host has it.
    /// Answers with both as they are on the host now.
    func setSidebarOrder(agents: [String]?, folders: [String]?) async throws -> HostSidebarOrder
    /// Whether the host keeps a copy of the order of the user's Macs, as of the last
    /// connection; nil before the first.
    var syncsMachineOrder: Bool? { get async }
    /// The id the host's bridge gave itself, by which that order names its Mac; nil
    /// from a host that gives none.
    var machineID: String? { get async }
    /// Gives the host the order of the user's Macs, which it keeps unless it has one
    /// arranged later. Answers with the host's order now, its copy of the Macs' among
    /// it. Throws `SidebarOrderError.unavailable` to a host that keeps no such copy.
    func setMachineOrder(_ order: MachineOrder) async throws -> HostSidebarOrder
}

public enum SidebarOrderError: LocalizedError, Hashable, Sendable {
    /// The host keeps no order (an older bridge, Hermes): nothing was sent.
    case unavailable

    public var errorDescription: String? {
        "This host does not keep the sidebar's order for every device."
    }
}

/// One host's order as this device holds it, with where it stands with the host.
///
/// The host's order is the one every device lists by. A list arranged here is this
/// device's until the host has taken it: meanwhile the host's own list of that kind is
/// not taken, so a move made out of reach is not undone by the next answer. The other
/// kind is taken as the host has it.
public struct HeldSidebarOrder: Hashable, Codable, Sendable {
    public var order: SidebarOrder
    /// The lists arranged here that the host has not taken yet.
    public var pending: Set<SidebarOrder.Kind>
    /// Where the host's order was when this device last took it or was answered; nil
    /// for an order that was never a host's.
    public var list: SidebarOrderRevision?
    /// The host's copy of the order of the user's Macs, as it last said; nil when it
    /// keeps none or was never given one.
    public var machines: MachineOrder?

    public init(
        order: SidebarOrder = SidebarOrder(), pending: Set<SidebarOrder.Kind> = [], list: SidebarOrderRevision? = nil, machines: MachineOrder? = nil
    ) {
        self.order = order
        self.pending = pending
        self.list = list
        self.machines = machines
    }

    /// Nothing arranged and nothing known of a host's order: not worth keeping.
    public var isEmpty: Bool {
        order == SidebarOrder() && pending.isEmpty && list == nil && machines == nil
    }

    /// Whether the host's copy of the order of the user's Macs is older than `order`,
    /// the one this device goes by, and is therefore to be given it (`isLater`).
    public func isBehind(_ order: MachineOrder?) -> Bool {
        guard let order else { return false }
        return order.isLater(than: machines)
    }

    /// The Macs' order to send next. A newer arrangement made while a send was on its
    /// way still goes next; the same copy is attempted only once in a sync pass, even
    /// if the host answers without keeping it.
    public func machinesToSend(_ order: MachineOrder?, after sent: MachineOrder?) -> MachineOrder? {
        guard let order, order != sent, isBehind(order) else { return nil }
        return order
    }

    /// The user arranged the rows of one kind here.
    public mutating func arrange(_ kind: SidebarOrder.Kind, _ names: [String]) {
        order[kind] = names
        pending.insert(kind)
    }

    /// What to send the host now: the lists arranged here, each whole. nil with none.
    public var toSend: (agents: [String]?, folders: [String]?)? {
        guard !pending.isEmpty else { return nil }
        return (pending.contains(.agents) ? order.agents : nil, pending.contains(.folders) ? order.folders : nil)
    }

    /// The host said how its order is: every list not waiting to be sent is the host's.
    public mutating func take(_ host: HostSidebarOrder) {
        for kind in SidebarOrder.Kind.allCases where !pending.contains(kind) {
            order[kind] = host.order[kind]
        }
        list = host.list
        machines = host.machines
    }

    /// The host answered a send of `sent`, the lists as they were when they left. A
    /// list arranged again since stays this device's, to be sent again.
    public mutating func sent(_ sent: (agents: [String]?, folders: [String]?), answered host: HostSidebarOrder) {
        if let agents = sent.agents, agents == order.agents { pending.remove(.agents) }
        if let folders = sent.folders, folders == order.folders { pending.remove(.folders) }
        take(host)
    }
}
