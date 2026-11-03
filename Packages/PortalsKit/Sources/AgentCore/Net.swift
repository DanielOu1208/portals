import Foundation

// The net (docs/net-plan.md): the Macs and devices that reach each other after pairing
// once. Every Mac keeps a copy of the member list; a device joins with a one-use code and
// signs in to every Mac in the list with the token it was given. This is the device's side
// of it: who is in the net as last listed, the join link, which hosts the list makes, and
// what a scanned code comes to.

/// A member of the net, as `net.list` gives it: a Mac or a device. Never with the hash of
/// its token, which only the Macs keep.
public struct NetMember: Identifiable, Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case mac, device
    }

    /// A Mac's machine id (`HostMachine.id`), or the id a device made for itself.
    public var id: String
    public var kind: Kind
    public var name: String
    /// A Mac's address, with scheme and port; nil for a device.
    public var url: URL?
    /// A Mac's X25519 public key, raw, in base64url; nil for a device.
    public var key: String?
    /// A Mac's relay id; nil for a device.
    public var relay: String?
    /// A device's platform: `ios`, `ipados` or `macos`.
    public var platform: String?
    /// Taken out of the net; the entry is kept so that a Mac that slept through it cannot
    /// bring it back. nil is false.
    public var removed: Bool?
    /// When it last changed, in milliseconds since 1970.
    public var changed: Int
    /// The member that made the change.
    public var by: String?
    /// Which token the entry is under, as a tag the Macs make of its hash (`token_tag`, 16
    /// hex digits): the same for two entries under one token, and telling nothing of it.
    /// nil from a bridge from before 2026-10-26, or for an entry with no token.
    public var tokenTag: String?
    /// The member's name was set from the app (`net.rename`, feature `net_rename`, and
    /// `net_rename_devices` for a device's): when, a stamp past every name of that member
    /// the Mac that set it had seen. nil while a Mac goes by its own name (`fleet.name` or
    /// its Computer Name) and a device by the one it joined with, and from a bridge from before.
    public var named: Int?
    /// The Mac that set the name: of two set at the same moment, the greater id's wins.
    public var namedBy: String?

    public init(
        id: String, kind: Kind, name: String, url: URL? = nil, key: String? = nil, relay: String? = nil, platform: String? = nil,
        removed: Bool = false, changed: Int = 0, by: String? = nil, tokenTag: String? = nil, named: Int? = nil, namedBy: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.url = url
        self.key = key
        self.relay = relay
        self.platform = platform
        self.removed = removed ? true : nil
        self.changed = changed
        self.by = by
        self.tokenTag = tokenTag
        self.named = named
        self.namedBy = namedBy
    }

    public var isRemoved: Bool { removed == true }

    /// Whether this entry's name was set after `other`'s, the same member's, as the Macs
    /// tell it: the later stamp, at the same stamp the greater Mac that set it. A name never
    /// set from the app comes before every one that was.
    public func isNamed(after other: NetMember) -> Bool {
        if (named ?? 0) != (other.named ?? 0) { return (named ?? 0) > (other.named ?? 0) }
        return (namedBy ?? "") > (other.namedBy ?? "")
    }

    /// This entry with the name of `other`, the same member's, and its stamp.
    func withName(of other: NetMember) -> NetMember {
        var entry = self
        entry.name = other.name
        entry.named = other.named
        entry.namedBy = other.namedBy
        return entry
    }

    /// A Mac the device can reach: one not removed, with an address.
    public var isReachableMac: Bool { kind == .mac && !isRemoved && url != nil }

    /// Whether this entry wins over `other`, the same member's, when the copy of the Mac
    /// `mac` meets the one held: the newer `changed`, a tie going to the greater `by`, as the
    /// Macs merge. But a member's own word under the token it was removed with does not undo
    /// the removal, whatever the clocks say, as the Macs' merge has it (`isNewer` in
    /// bridge/src/net/members.ts): a Mac removed while it was off writes its entry anew as it
    /// starts, and gives that to a device, or another Mac that missed the removal passes it
    /// on, before it hears of it. Taken in again, under another token, its own later word
    /// stands. The Macs tell the two apart by the token's hash, a device by its tag
    /// (`tokenTag`). An entry without one (a bridge from before 2026-10-26) is judged as
    /// before: a Mac's own word that it is in does not undo its removal when that Mac says
    /// it, and held, gives way to a removal that comes after, so a Mac taken in again whose
    /// own later word meets a removal from a Mac that slept through it is out here until
    /// that Mac has caught up and is listed again.
    func wins(over other: NetMember, saidBy mac: String) -> Bool {
        if let tag = tokenTag, let otherTag = other.tokenTag {
            if isRemoved != other.isRemoved, tag == otherTag {
                if !isRemoved, by == id { return false }
                if !other.isRemoved, other.by == other.id { return true }
            }
        } else {
            if !isRemoved, other.isRemoved, id == mac, by == id { return false }
            if isRemoved, !other.isRemoved, other.kind == .mac, other.by == other.id { return true }
        }
        if changed != other.changed { return changed > other.changed }
        return (by ?? "") > (other.by ?? "")
    }

    /// Whether this is `other` as a newer bridge gives it: the same change, with the token's
    /// tag that a list kept from before 2026-10-26 lacks.
    func addsTag(to other: NetMember) -> Bool {
        tokenTag != nil && other.tokenTag == nil && changed == other.changed && by == other.by && isRemoved == other.isRemoved
    }
}

/// Where a Mac's copy of the list is: the net's id and the copy's revision, which goes up
/// with every change that Mac saves (its own count, not the net's). `gateway.ready` and
/// `poll.now` say it, so the device asks `net.list` again only when it moved.
public struct NetRevision: Hashable, Sendable {
    public var net: String
    public var revision: Int

    public init(net: String, revision: Int) {
        self.net = net
        self.revision = revision
    }
}

/// What `net.list` answers.
public struct NetList: Hashable, Sendable {
    /// The net's id, 16 hex digits.
    public var net: String
    /// The id of the Mac that answered.
    public var here: String
    /// The caller's member id: this device's, when it signed in with its token; nil for a
    /// password.
    public var you: String?
    public var revision: Int
    public var members: [NetMember]

    public init(net: String, here: String, you: String? = nil, revision: Int, members: [NetMember]) {
        self.net = net
        self.here = here
        self.you = you
        self.revision = revision
        self.members = members
    }

    public var at: NetRevision { NetRevision(net: net, revision: revision) }
}

/// A join code `net.invite` made on a Mac: one use, for ten minutes.
public struct NetInvite: Hashable, Sendable {
    /// The `portals://join` link that carries it, which the QR code holds.
    public var link: String
    public var code: String
    /// When it stops working.
    public var expiresAt: Date

    public init(link: String, code: String, expiresAt: Date) {
        self.link = link
        self.code = code
        self.expiresAt = expiresAt
    }
}

/// What a Mac answers a device that joined with a code (`POST /net/join`).
public struct NetJoined: Hashable, Sendable {
    public var net: String
    /// The device's token, which it signs in to every Mac of the net with.
    public var token: String
    public var members: [NetMember]

    public init(net: String, token: String, members: [NetMember]) {
        self.net = net
        self.token = token
        self.members = members
    }
}

/// Who this device is to the net, as it joins: its id, its name and its platform.
public struct NetDevice: Hashable, Sendable {
    public var id: String
    public var name: String
    /// `ios`, `ipados` or `macos`.
    public var platform: String

    public init(id: String, name: String, platform: String) {
        self.id = id
        self.name = name
        self.platform = platform
    }
}

// MARK: - Membership

/// This device's place in a net, kept in the app's data folder (`ThreadStore.loadNet`).
/// One per device. Its token is not here but in the Keychain (`CredentialStore.netToken`).
public struct NetMembership: Codable, Hashable, Sendable {
    /// The device's id in any net: a UUID made once, kept when it leaves a net and joins
    /// another.
    public var deviceID: String
    /// The net the device is in; nil in none.
    public var net: String?
    /// Every member as last listed, removed ones too.
    public var members: [NetMember]
    /// Each Mac's revision of its list, by its id, as last listed from it: a Mac is asked
    /// for the list again only when it says another.
    public var revisions: [String: Int]
    /// The nets the device switched away from that no Mac of has taken it out of yet, to
    /// be asked again (`NetLeftBehind`); nil is none. Kept through joins, leaves and
    /// switches, and app launches.
    public var leftBehind: [NetLeftBehind]?
    /// The name this device was last given from the app (`net.rename` of its own entry,
    /// feature `net_rename_devices`), as listed: the one it joins a net with from then on,
    /// over the one it would make for itself (`Net.device`). Kept through leaves, joins and
    /// switches, as a Mac keeps a name set from the app; nil while it was never renamed so.
    /// A name it joined with again is stamped too, at its entry's own change by the Mac that
    /// made it, which every rename comes after: that one is not a name it was given (a Mac
    /// app's "Mac" would otherwise be kept over its bridge's name).
    public var givenName: String?
    /// Moves on every join, leave and switch of nets, for this launch only (not kept, and
    /// not part of what makes two memberships the same). What was asked of a Mac under an
    /// earlier one, a list or a removal, is dropped when it comes back (`heard`): it is of
    /// a net the device is not in any more, and taken it would bring that net back.
    public private(set) var generation = 0

    public init(deviceID: String = UUID().uuidString, net: String? = nil, members: [NetMember] = [], revisions: [String: Int] = [:]) {
        self.deviceID = deviceID
        self.net = net
        self.members = members
        self.revisions = revisions
    }

    private enum CodingKeys: String, CodingKey {
        case deviceID, net, members, revisions, leftBehind, givenName
    }

    public static func == (lhs: NetMembership, rhs: NetMembership) -> Bool {
        lhs.deviceID == rhs.deviceID && lhs.net == rhs.net && lhs.members == rhs.members && lhs.revisions == rhs.revisions
            && lhs.leftBehind == rhs.leftBehind && lhs.givenName == rhs.givenName
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(deviceID)
        hasher.combine(net)
        hasher.combine(members)
        hasher.combine(revisions)
        hasher.combine(leftBehind)
        hasher.combine(givenName)
    }

    public var isInNet: Bool { net != nil }

    /// The Macs of the net the device can reach, in the list's order.
    public var macs: [NetMember] { members.filter(\.isReachableMac) }

    /// Every member not removed, Macs first, each kind in the list's order: the Devices list.
    public var shownMembers: [NetMember] {
        let kept = members.filter { !$0.isRemoved }
        return kept.filter { $0.kind == .mac } + kept.filter { $0.kind == .device }
    }

    /// This device's own entry, as last listed.
    public var ownEntry: NetMember? {
        members.first { $0.id == deviceID }
    }

    /// Takes a list a Mac of the device's net gave: its members merged into those held, as
    /// the Macs merge their copies, and that Mac's revision. A list of another net is not
    /// taken: false.
    ///
    /// Merged, not taken whole: a Mac that missed a change (asleep as another Mac joined)
    /// gives a copy without it, which must not take that Mac away from the device. Per id
    /// the newer `changed` wins, a tie going to the greater `by`, and no entry goes because a
    /// copy lacks it. A Mac's name set from the app is merged apart, as the Macs merge it:
    /// the one set later, whichever entry wins (a bridge from before gives no stamp, and a
    /// Mac that wrote its entry anew before hearing of its rename gives the name before).
    /// New members come after those held, in the copy's order.
    @discardableResult
    public mutating func take(_ list: NetList) -> Bool {
        guard list.net == net else { return false }
        var place = Dictionary(members.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        for member in list.members {
            if let index = place[member.id] {
                let held = members[index]
                let wins = member.wins(over: held, saidBy: list.here) || member.addsTag(to: held)
                let newer = wins ? member : held, older = wins ? held : member
                members[index] = older.isNamed(after: newer) ? newer.withName(of: older) : newer
            } else {
                place[member.id] = members.count
                members.append(member)
            }
        }
        revisions[list.here] = list.revision
        keepGivenName()
        return true
    }

    /// The name of the device's own entry, kept when it was given from the app: the name a
    /// device joined with again is stamped at the entry's own change, by the Mac that made the
    /// entry, and a rename past it, or at it by another Mac (one made at the same moment,
    /// whose greater id won).
    private mutating func keepGivenName() {
        guard let own = ownEntry, let named = own.named else { return }
        if named > own.changed || (named == own.changed && own.namedBy != own.by) { givenName = own.name }
    }

    /// Takes a list a Mac gave the device signed in with its token, asked for in `asked` (the
    /// `generation` as the call went). One asked for in an earlier generation is dropped,
    /// and so is any in no net: false. One of another net that lists the device is that net
    /// now, a generation on (a Mac it joined through went into another net, and its devices
    /// came along): that net's list alone, not merged with the one before. Else as `take`.
    public mutating func heard(_ list: NetList, askedIn asked: Int) -> Bool {
        guard asked == generation, isInNet else { return false }
        if list.net != net {
            guard list.you == deviceID else { return false }
            net = list.net
            members = []
            revisions = [:]
            generation += 1
        }
        return take(list)
    }

    /// Whether a Mac's list is to be asked for again: it says a revision other than the one
    /// last listed from it, or another net.
    public func needsList(from mac: String, at said: NetRevision) -> Bool {
        said.net != net || revisions[mac] != said.revision
    }

    /// The device joined a net: its list, with no revision of any Mac yet.
    public mutating func joined(_ joined: NetJoined) {
        net = joined.net
        members = joined.members
        revisions = [:]
        generation += 1
        keepGivenName()
    }

    /// Keeps `left` to be asked again, in place of one kept for the same net.
    public mutating func keep(_ left: NetLeftBehind) {
        var kept = (leftBehind ?? []).filter { $0.net != left.net }
        kept.append(left)
        leftBehind = kept
    }

    /// `net`, left behind, as one go at it left it (`NetLeftBehind.after`): nil lets go of it.
    public mutating func leftBehind(_ net: String, is left: NetLeftBehind?) {
        var kept = (leftBehind ?? []).filter { $0.net != net }
        if let left { kept.append(left) }
        leftBehind = kept.isEmpty ? nil : kept
    }

    /// The device is in no net now; its id stays, and so does the name it was given.
    public mutating func leave() {
        net = nil
        members = []
        revisions = [:]
        generation += 1
    }
}

// MARK: - A net left behind

/// What a Mac of a net the device left said when asked to take the device out of it.
public enum NetLeftBehindAnswer: Hashable, Sendable {
    /// The device is out of that net: taken out now, or listed as removed already.
    case out
    /// The Mac cannot take it out: it is in another net now, or does not take the old
    /// token (it left that net, or the device was taken out there and the word has gone round).
    case notThere
    /// It did not answer, a removal's answer included: asked again later. A removal whose
    /// answer did not come may have been made (the Mac closes the device's connection as it
    /// makes it) or not (it could not save it, the request was lost): asked again, the Mac
    /// refuses the old token, or lists the device, which it is asked again to take out.
    case unanswered
}

/// A net this device switched away from while no Mac of it took the device out: none was
/// connected at the switch, or the one asked did not answer. Its Macs keep the device as a
/// member and go on sending it notifications it can no longer open ("New activity"). It is
/// kept, with the old token (`CredentialStore.leftNetToken`), and its Macs are asked again
/// (`NetAttempt.takeOut`) until one takes the device out, or none of them can any more; for
/// `lifetime` at most, after which it is given up and the person told.
public struct NetLeftBehind: Codable, Hashable, Sendable {
    /// A Mac of that net, as last listed: its id and address.
    public struct Mac: Codable, Hashable, Sendable {
        public var id: String
        public var url: URL

        public init(id: String, url: URL) {
            self.id = id
            self.url = url
        }
    }

    /// How long its Macs are asked before it is given up.
    public static let lifetime: TimeInterval = 7 * 24 * 60 * 60

    public var net: String
    public var macs: [Mac]
    /// When it was left.
    public var since: Date

    public init(net: String, macs: [Mac], since: Date = .now) {
        self.net = net
        self.macs = macs
        self.since = since
    }

    /// The net `membership` is in, as it is left behind: the Macs of it the device can
    /// reach. nil in no net, or with none.
    public init?(leaving membership: NetMembership, at since: Date = .now) {
        guard let net = membership.net else { return nil }
        let macs = membership.macs.compactMap { mac in mac.url.map { Mac(id: mac.id, url: $0) } }
        guard !macs.isEmpty else { return nil }
        self.init(net: net, macs: macs, since: since)
    }

    /// Whether its time is up at `now`: it is given up.
    public func isOver(at now: Date) -> Bool {
        now.timeIntervalSince(since) >= Self.lifetime
    }

    /// What is left of it after one go, each Mac asked by its id: nil once the device is
    /// out of that net, or no Mac of it can take it out any more; else without the Macs
    /// that cannot.
    public func after(_ answers: [String: NetLeftBehindAnswer]) -> NetLeftBehind? {
        if answers.values.contains(.out) { return nil }
        var left = self
        left.macs.removeAll { answers[$0.id] == .notThere }
        return left.macs.isEmpty ? nil : left
    }
}

// MARK: - The join link

/// A way into a net, as `net.invite` makes it on a Mac and the code Add a device shows
/// holds (docs/pairing-and-relay.md):
///
///     portals://join?v=1&url=https%3A%2F%2Fmac.tailnet.ts.net%3A10010&code=…&name=MacBook
///
/// Every value is percent-encoded. Parameters this version does not know are ignored.
public struct JoinLink: Hashable, Sendable {
    /// The newest version of the link this app reads.
    public static let version = 1

    /// The address of the Mac that made the code, where it is redeemed.
    public var url: URL
    public var code: String
    /// That Mac's name; nil when the link gives none.
    public var name: String?

    public init(url: URL, code: String, name: String? = nil) {
        self.url = url
        self.code = code
        self.name = name
    }

    /// Why a link could not be read, in words for the person who scanned it.
    public enum Problem: Error, Equatable, Sendable, LocalizedError {
        case notALink
        case newerVersion
        case missingAddress
        case missingCode
        case badAddress

        public var errorDescription: String? {
            switch self {
            case .notALink: "This isn't a code from Portals."
            case .newerVersion: "Update Portals to join this net."
            case .missingAddress: "The code has no address for the host."
            case .missingCode: "The code has no join code in it."
            case .badAddress: "The code's address isn't one Portals can connect to."
            }
        }
    }

    public init(parsing text: String) throws {
        guard let values = PortalsLink.values(of: text, kind: "join") else { throw Problem.notALink }
        if let version = values["v"] {
            guard let number = Int(version), number <= Self.version else { throw Problem.newerVersion }
        }
        let trimmed = { (name: String) in values[name]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        let address = trimmed("url")
        guard !address.isEmpty else { throw Problem.missingAddress }
        guard let url = HostConfig.url(fromTyped: address) else { throw Problem.badAddress }
        let code = trimmed("code")
        guard !code.isEmpty else { throw Problem.missingCode }
        let name = trimmed("name")
        self.init(url: url, code: code, name: name.isEmpty ? nil : name)
    }

    /// What to call the Mac that made the code: its name, else its address's first label.
    public var macName: String {
        name ?? HostConfig.suggestedName(for: url)
    }
}

/// A `portals://` link the app can be opened with or scan: a Mac's pairing link, or a way
/// into a net.
public enum PortalsLink: Hashable, Sendable {
    case pair(PairingLink)
    case join(JoinLink)

    /// Reads either. A text that is neither says so as a pairing link would.
    public init(parsing text: String) throws {
        if Self.values(of: text, kind: "join") != nil {
            self = .join(try JoinLink(parsing: text))
        } else {
            self = .pair(try PairingLink(parsing: text))
        }
    }

    /// The link's values by name, the first of a name counting, when `text` is a
    /// `portals://<kind>` link; nil otherwise.
    static func values(of text: String, kind: String) -> [String: String]? {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "portals", components.host?.lowercased() == kind,
              components.path.isEmpty || components.path == "/" else { return nil }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] where values[item.name] == nil {
            values[item.name] = item.value ?? ""
        }
        return values
    }
}

// MARK: - Hosts from the list

/// The hosts the net's list makes: every Mac of the net is a host signed in with the
/// device's token. A host the user added by hand for the same Mac becomes the net's, so
/// there is one host for it, not two; a Mac taken out of the net goes.
public enum NetHosts {
    /// `hosts` as the list `members` makes them: each net host still in the net with its
    /// address and, unless the user renamed it, its name from the entry; each hand-added
    /// host for a Mac of the net made the net's; a host for each other Mac of the net,
    /// after them. A net host whose Mac is removed or gone from the list is left out, and
    /// so is a second host for a Mac that has one already.
    public static func apply(_ members: [NetMember], to hosts: [HostConfig]) -> [HostConfig] {
        let macs = members.filter(\.isReachableMac)
        var covered: [String: HostID] = [:]
        var kept: [HostConfig] = []
        // A Mac's host: the one that is its net host already, else the first added by hand
        // for it, by its machine id or, before it said one, its address.
        var chosen: [String: HostID] = [:]
        for mac in macs {
            let host = hosts.first { $0.netMember == mac.id }
                ?? hosts.first { $0.netMember == nil && $0.machineID == mac.id }
                ?? hosts.first { $0.netMember == nil && $0.machineID == nil && HostConfig.isSameAddress($0.url, mac.url!) }
            if let host, !chosen.values.contains(host.id) { chosen[mac.id] = host.id }
        }
        let macsByHost = Dictionary(chosen.map { ($0.value, $0.key) }, uniquingKeysWith: { first, _ in first })
        let macsByID = Dictionary(macs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for host in hosts {
            if let id = macsByHost[host.id], let mac = macsByID[id] {
                kept.append(host.joined(mac))
                covered[mac.id] = host.id
            } else if host.netMember != nil {
                // Its Mac was taken out of the net, or another host is that Mac's.
                continue
            } else if let id = host.machineID, macsByID[id] != nil {
                // Added by hand for a Mac the net has a host for already.
                continue
            } else {
                kept.append(host)
            }
        }
        for mac in macs where covered[mac.id] == nil {
            kept.append(HostConfig(netMac: mac))
        }
        return kept
    }

    /// The connected net host to ask for a join code (Add a device, Add a Mac), of
    /// `connected` in order: the first reached directly, since the device or Mac to join
    /// goes to that Mac's address, which it may not reach when this device reaches the Mac
    /// only through the relay; the first reached through the relay only when no other is
    /// connected.
    public static func forCodes<Host>(_ connected: [Host], viaRelay: (Host) -> Bool) -> Host? {
        connected.first { !viaRelay($0) } ?? connected.first
    }
}

extension HostConfig {
    /// A new host for a Mac of the net.
    public init(netMac mac: NetMember) {
        self.init(name: mac.name, url: mac.url!, kind: .bridge, machineID: mac.id)
        netMember = mac.id
        netName = mac.name
        netNamed = mac.named
        netNamedBy = mac.namedBy
    }

    /// This host as the net's host for `mac`: its address from the entry, signed in with
    /// the device's token, named by the entry unless the user gave it a name of its own on
    /// this device; and named by the entry all the same once the Mac was renamed from the
    /// app since (2026-10-26: a Mac renamed in the app is renamed everywhere, on
    /// every Mac and device, the latest rename winning).
    func joined(_ mac: NetMember) -> HostConfig {
        var host = self
        if host.netMember == nil {
            // Added by hand: the name the user gave it stays, and so does the one the
            // entry gives, should they be the same. A rename after this one replaces it.
            host.username = nil
            host.kind = .bridge
        } else if host.netName == nil || host.name == host.netName || (mac.named != nil && (mac.named != host.netNamed || mac.namedBy != host.netNamedBy)) {
            host.name = mac.name
        }
        host.netMember = mac.id
        host.netName = mac.name
        host.netNamed = mac.named
        host.netNamedBy = mac.namedBy
        host.machineID = mac.id
        host.url = mac.url!
        return host
    }

    /// This host named as the net names `mac`, its Mac, from now on: after a rename this
    /// device made through the net, also one to the name the net had already, which a name
    /// given on this device alone was kept over.
    public func named(as mac: NetMember) -> HostConfig {
        var host = self
        host.name = mac.name
        host.netName = mac.name
        host.netNamed = mac.named
        host.netNamedBy = mac.namedBy
        return host
    }

    /// Whether the host is a Mac of the device's net, signed in with its token.
    public var isNetHost: Bool { netMember != nil }
}

// MARK: - Scanning

/// What a scanned code or an opened link comes to, by whether the device is in a net and
/// which Macs it has (docs/net-plan.md, "Scanning"). Whether the Mac offers the net at all
/// is known only once it is reached: one that does not is added as before.
public enum NetScan {
    public enum Decision: Hashable, Sendable {
        /// A way into a net, and the device is in none: join it.
        case join(JoinLink)
        /// A way into another net than the device's: ask, then leave this one (with no
        /// call to it) and join that one.
        case switchNet(JoinLink)
        /// A Mac's pairing link, and the device is in no net: sign in with the password
        /// once, have that Mac make a code, and redeem it.
        case pairIntoNet(PairingLink)
        /// A Mac outside the device's net: sign in to it, have a Mac of the net make a code,
        /// and have the new Mac join with it.
        case addMac(PairingLink)
        /// A Mac of the device's net already, or a way into the net the device is in:
        /// nothing new. The host is that Mac's.
        case known(HostID)
    }

    public static func decide(_ link: PortalsLink, membership: NetMembership, hosts: [HostConfig]) -> Decision {
        switch link {
        case let .join(join):
            guard membership.isInNet else { return .join(join) }
            if let host = netHost(at: join.url, membership: membership, hosts: hosts) { return .known(host) }
            return .switchNet(join)
        case let .pair(pairing):
            guard membership.isInNet else { return .pairIntoNet(pairing) }
            if let host = netHost(at: pairing.url, membership: membership, hosts: hosts) { return .known(host) }
            return .addMac(pairing)
        }
    }

    /// The device's host for the Mac of its net at `url`, if there is one.
    private static func netHost(at url: URL, membership: NetMembership, hosts: [HostConfig]) -> HostID? {
        if let host = hosts.first(where: { $0.isNetHost && HostConfig.isSameAddress($0.url, url) }) { return host.id }
        guard let mac = membership.macs.first(where: { HostConfig.isSameAddress($0.url!, url) }) else { return nil }
        return hosts.first { $0.netMember == mac.id }?.id
    }
}

// MARK: - The host's side

/// What a host that is a Mac of a net says of it, besides answering.
public enum NetNews: Hashable, Sendable {
    /// Where its copy of the list is, as a connection opened (`gateway.ready`) or as it
    /// said something moved (`poll.now`).
    case at(NetRevision)
    /// It did not take the device's token: it closed the socket with 4401, and this
    /// sentence when it gave one ("This device was removed from the net.").
    case refused(String?)
}

/// Why something asked of the net did not happen, in words for the person.
public enum NetError: Error, Hashable, Sendable, LocalizedError {
    /// The host is not a Mac that offers the net (a bridge from before it, or Hermes).
    case unavailable
    /// A Mac said no, with its sentence: a code used or expired, a Mac in a net with
    /// other Macs.
    case refused(String)
    /// No Mac of the net answers to make a code, or to take a change.
    case noMacAnswers
    /// The device joined, left or switched nets while a join, an Add a Mac or a switch was
    /// under way (`NetAttempt`): it stopped, with no further call to a Mac.
    case overtaken

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host's bridge is too old for a net. Update it, or add the host by itself."
        case let .refused(reason): reason
        case .noMacAnswers: "No host of your net is connected. Try again once one is."
        case .overtaken: "Your net changed while this was under way. Try again."
        }
    }
}

/// A host that is a Mac of a net (a Portals bridge's `net`): it lists the members, makes
/// join codes, takes a member out, and joins another net.
public protocol NetReporting: Sendable {
    /// Whether the host offers the net, as of the last connection; nil before the first.
    var offersNet: Bool? { get async }
    /// What the host says of the net, from any connection, for as long as the backend
    /// lives. One consumer.
    var netNews: AsyncStream<NetNews> { get }
    func netList() async throws -> NetList
    /// A join code for another device or Mac.
    func netInvite() async throws -> NetInvite
    /// Takes a member out of the net, on every Mac; answers with the list after. With
    /// `net`, only while the host is in that net: one that has moved into another since
    /// refuses (`NetError.refused`), and a bridge from before 2026-10-26 does not look.
    func netRemove(_ member: String, inNet net: String?) async throws -> NetList
    /// The host joins the net of a `portals://join` link, bringing its devices. Throws
    /// `NetError.refused` with the other Mac's sentence when it is refused.
    func netJoin(with link: String) async throws -> NetList
    /// Whether the host renames a Mac for the whole net (`net_rename`), as of the last
    /// connection; nil before the first.
    var renamesNetMacs: Bool? { get async }
    /// Whether the host renames a device for the whole net too (`net_rename_devices`), as
    /// of the last connection; nil before the first.
    var renamesNetDevices: Bool? { get async }
    /// Names the member `member` (a Mac, or with `renamesNetDevices` a device) `name` on every
    /// Mac and device of the net, the latest rename winning; `after` is the stamp of the name
    /// the device holds for it (`NetMember.named`).
    /// With `net`, only while the host is in that net, as `netRemove`. Answers with the list
    /// after. Throws `NetError.refused` with the Mac's sentence (a name that cannot be one,
    /// another net), and `.unavailable` from a host without the feature.
    func netRename(_ member: String, to name: String, after: Int?, inNet net: String?) async throws -> NetList
}

extension NetReporting {
    public var renamesNetMacs: Bool? {
        get async { false }
    }

    public var renamesNetDevices: Bool? {
        get async { false }
    }

    public func netRename(_ member: String, to name: String, after: Int?, inNet net: String?) async throws -> NetList {
        throw NetError.unavailable
    }
}

extension NetReporting {
    /// Takes a member out of the net the host is in, whichever that is.
    public func netRemove(_ member: String) async throws -> NetList {
        try await netRemove(member, inNet: nil)
    }
}

// MARK: - Joining, adding a Mac, switching

/// One go at joining a net, adding a Mac to it or switching to another, under the membership
/// generation it started in (`NetMembership.generation`). After each await, and so before
/// each call that changes something on a Mac (`net.invite`, `net.join_with`,
/// `POST /net/join`), it checks that its task was not cancelled (the sheet that started it
/// was closed) and that the generation is still that one (no join, leave or switch
/// meanwhile); else it stops there, with no further call. Gone on, an Add a Mac started in
/// one net would have a Mac of the net the device is in now make the code, and the new Mac
/// join that one.
@MainActor
public final class NetAttempt {
    /// What a Mac reached with its pairing link came to, as Add a Mac goes.
    public enum Added: Hashable, Sendable {
        /// Its bridge has no net: it is added by itself.
        case withoutNet
        /// It is in the device's net already: its list.
        case known(NetList)
        /// It joined the device's net: its list after.
        case joined(NetList)
        /// It would not join, with its sentence: it is in a net with other Macs.
        case refused(String)
    }

    /// The generation it started in.
    public let generation: Int
    /// The generation still owned by this attempt, including its own old net's removal.
    private var expectedGeneration: Int
    /// The membership's generation now.
    private let current: () -> Int

    public init(generation: Int, current: @escaping () -> Int) {
        self.generation = generation
        expectedGeneration = generation
        self.current = current
    }

    /// Throws `CancellationError` once the task is cancelled, and `NetError.overtaken` once
    /// the membership is in another generation.
    public func check() throws {
        try Task.checkCancellation()
        try checkCurrent()
    }

    /// Throws `NetError.overtaken` once the membership is in another generation, cancelled or
    /// not: for what comes after a join that worked, which a closed sheet does not undo, as
    /// the new net has the device already (`Net.become`).
    public func checkCurrent() throws {
        guard current() == expectedGeneration else { throw NetError.overtaken }
    }

    /// The old net's removal was heard during this attempt's cleanup. Only its owner
    /// calls this, just after leaving that net, with the generation before the leave.
    /// A leave or switch that overtook it is not its own removal.
    public func leftOldNet(askedIn generation: Int) {
        guard expectedGeneration == generation else { return }
        expectedGeneration = current()
    }

    /// `call` to a Mac, checked before it goes and after it comes back: a late answer is not
    /// taken.
    public func step<T>(_ call: () async throws -> T) async throws -> T {
        try check()
        let answer = try await call()
        try check()
        return answer
    }

    /// Redeems a code unless cancelled or overtaken. Once it works, a closed sheet does
    /// not undo the join: keep its token so `Net.become` can save it. Another membership
    /// generation still owns the net if this attempt was overtaken.
    public func redeem(_ call: () async throws -> NetJoined) async throws -> NetJoined {
        try check()
        let joined = try await call()
        try checkCurrent()
        return joined
    }

    /// Into a net through a Mac's pairing link, signed in to `mac` with its password: it
    /// makes a code, which `redeem` redeems at it (`POST /net/join`). nil for a Mac whose
    /// bridge has no net.
    public func joinThrough(_ mac: any NetReporting, redeem: (NetInvite) async throws -> NetJoined) async throws -> NetJoined? {
        guard try await step({ await mac.offersNet }) == true else { return nil }
        let invite = try await step { try await mac.netInvite() }
        return try await self.redeem { try await redeem(invite) }
    }

    /// Add a Mac: `mac`, signed in to with its password, joins the device's net `net` with a
    /// code that a Mac of the net makes, `maker` (asked for once `mac` has answered).
    public func add(_ mac: any NetReporting, to net: String?, codeFrom maker: () -> (any NetReporting)?) async throws -> Added {
        guard try await step({ await mac.offersNet }) == true else { return .withoutNet }
        let theirs = try await step { try await mac.netList() }
        if theirs.net == net { return .known(theirs) }
        guard let from = maker() else { throw NetError.noMacAnswers }
        let invite = try await step { try await from.netInvite() }
        do {
            return .joined(try await step { try await mac.netJoin(with: invite.link) })
        } catch let NetError.refused(reason) {
            return .refused(reason)
        }
    }

    /// Once the device has joined `joined` from the net `oldNet` (a switch): `old`, a Mac
    /// of the old net it is still connected to, takes the device (`device`, its id in both)
    /// out of the old net, as Leave has one do. Else the old net's Macs kept it as a member
    /// and went on sending it notifications sealed for a key it no longer has ("New
    /// activity"). The device asks, not a Mac: no Mac of the old net knows of the switch.
    /// Only once the join worked (a code that fails leaves it in its net), and only for
    /// another net. Not checked against the generation: the old net is left whatever
    /// follows. What it answered says whether the old net is to be kept and asked again
    /// (`NetLeftBehind`): none connected, or a removal whose answer did not come, is
    /// `.unanswered`.
    /// The Mac is asked first which net it is in: one that has moved into another net
    /// meanwhile (the very net joined, maybe, bringing the device's old token) would take the
    /// device out of that one instead. The removal names the old net too, so a Mac that moves
    /// between the two answers refuses it rather than take the device out of the net it
    /// moved into (a bridge from before 2026-10-26 does not look: the list's answer alone).
    /// nil when there is no old net to leave.
    ///
    /// A cancel (the sheet that started the switch was closed) ends the wait at once, as
    /// `.unanswered`, however long the Mac takes: the new net has the device already, and
    /// the switch is to be finished, not held up or undone (bug hunt round 4, APP1). The
    /// removal goes on by itself; the old net is asked again later either way.
    @discardableResult
    public static func leaveOldNet(_ oldNet: String?, for joined: NetJoined, device: String, through old: (any NetReporting)?) async -> NetLeftBehindAnswer? {
        guard let oldNet, oldNet != joined.net else { return nil }
        guard let old else { return .unanswered }
        let answer = FirstAnswer<NetLeftBehindAnswer>()
        Task { answer.give(await takeOut(device, of: oldNet, through: old)) }
        return await withTaskCancellationHandler {
            await answer.value()
        } onCancel: {
            Task { @MainActor in answer.give(.unanswered) }
        }
    }

    /// Has `mac`, signed in to with the device's token in the net `net`, take the device out
    /// of that net: asked first which net it is in, and the removal naming that net, so a
    /// Mac in another (the device's own now, maybe) takes nothing out. A removal whose
    /// answer does not come is `.unanswered`: the Mac closes the device's connection as it
    /// takes it out, but may also have failed to. `wanted`, asked once the list has come, before
    /// the removal goes: false (the device joined that net again meanwhile) sends none.
    public static func takeOut(
        _ device: String, of net: String, through mac: any NetReporting, while wanted: () -> Bool = { true }
    ) async -> NetLeftBehindAnswer {
        do {
            let list = try await mac.netList()
            guard list.net == net else { return .notThere }
            if list.members.first(where: { $0.id == device })?.isRemoved == true { return .out }
        } catch NetError.refused(_) {
            return .notThere
        } catch {
            return .unanswered
        }
        guard wanted() else { return .unanswered }
        do {
            _ = try await mac.netRemove(device, inNet: net)
        } catch NetError.refused(_) {
            return .notThere
        } catch {
            return .unanswered
        }
        return .out
    }
}

/// Joins, Adds a Mac and switches of nets, run one at a time (`Net`), each from the code's
/// redemption (or, for Add a Mac, the new Mac's first answer) until it has saved what it
/// came to. Two at once could each redeem a code: the net gave the device a second token,
/// which took the place of the first on its Macs, and the switch that saved last could save
/// the first, which no Mac takes any more, the device then in no net it could reach, the
/// good token thrown away (Codex's review of the round 4 app fixes). One that comes while
/// another runs waits for it, then checks the membership that one left (`NetAttempt`).
///
/// A password sign-in to a pairing link's Mac comes before the turn is taken: it does not
/// stop for a cancel, and a stalled one, its sheet closed, held up every change after it
/// (Codex's re-check). A change cancelled while it waits is dropped at once, and one
/// cancelled before its turn comes runs nothing.
@MainActor
public final class NetChanges {
    /// One is running.
    private var isRunning = false
    /// Those waiting for it, in the order they came, each with its number.
    private var waiting: [(number: Int, continuation: CheckedContinuation<Void, any Error>)] = []
    private var numbered = 0

    public init() {}

    /// Runs `change` once no other is running; throws `CancellationError`, with nothing of
    /// it run, once the task is cancelled before then. Ended, it hands the turn straight to
    /// the next waiting, if any.
    public func run<T>(_ change: () async throws -> T) async throws -> T {
        try await takeTurn()
        defer { handOn() }
        // Cancelled as the turn came to it: none of it runs.
        try Task.checkCancellation()
        return try await change()
    }

    private func takeTurn() async throws {
        try Task.checkCancellation()
        guard isRunning else {
            isRunning = true
            return
        }
        numbered += 1
        let number = numbered
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiting.append((number, $0)) }
        } onCancel: {
            Task { @MainActor in self.drop(number) }
        }
    }

    /// A change whose task was cancelled as it waited: out of the line, at once. One given
    /// the turn already gives it on (`run`).
    private func drop(_ number: Int) {
        guard let index = waiting.firstIndex(where: { $0.number == number }) else { return }
        waiting.remove(at: index).continuation.resume(throwing: CancellationError())
    }

    private func handOn() {
        if waiting.isEmpty {
            isRunning = false
        } else {
            waiting.removeFirst().continuation.resume()
        }
    }
}

/// The first of several answers to one question, for whoever waits on it: those given after
/// it are dropped (`NetAttempt.leaveOldNet`, the Mac's answer or a cancel's).
@MainActor
private final class FirstAnswer<Answer: Sendable> {
    private var given: Answer?
    private var waiting: CheckedContinuation<Answer, Never>?

    func give(_ answer: Answer) {
        guard given == nil else { return }
        given = answer
        waiting?.resume(returning: answer)
        waiting = nil
    }

    func value() async -> Answer {
        if let given { return given }
        return await withCheckedContinuation { waiting = $0 }
    }
}
