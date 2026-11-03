import AgentCore
import Foundation
import HermesBackend
import Observation
import os
import Synchronization
import UIKit

/// This device's place in a net (docs/net-plan.md): the Macs and devices that reach each
/// other after pairing once. In a net, every Mac of it is a host signed in with the
/// device's token (`NetHosts`), kept in step with the list the Macs keep; a scanned code
/// or an opened link joins one, adds a Mac to it, or switches to another (`NetScan`).
///
/// The device's id and the list as last listed are in the app's data folder, the token in
/// the Keychain. One net per device.
@Observable
final class Net {
    /// What a scanned code or an opened link came to.
    enum Outcome: Equatable {
        /// The device joined a net.
        case joined
        /// A Mac joined the device's net; its host is this one, once listed.
        case added(HostID?)
        /// Nothing new: the Mac, or the net, is the device's already. Its host.
        case known(HostID?)
        /// The Mac's bridge has no net: it is added by itself, as before the net.
        case withoutNet
        /// The new Mac would not join the device's net, with its sentence: it is in a
        /// net with other Macs. The device may switch to that Mac's net instead.
        case refused(String)
    }

    private(set) var membership: NetMembership
    /// Why the device is in no net any more when that was not its own doing, for the
    /// screen to say once; nil once read.
    var notice: String?
    /// That a net the device switched away from was given up still listing it
    /// (`NetLeftBehind`), for the screen to say once; nil once read.
    var leftBehindNotice: String?

    /// The hosts are the fleet's: the net changes them through it.
    @ObservationIgnored private(set) weak var fleet: Fleet?
    /// The ways through the relay to the net's Macs, for their backends to read away from
    /// the main thread.
    @ObservationIgnored let relayRoutes: RelayRoutes
    @ObservationIgnored private let credentials: any CredentialStore
    @ObservationIgnored private let store: ThreadStore
    /// The membership is saved: not for a launch whose hosts are the launch environment's.
    @ObservationIgnored private let saves: Bool
    @ObservationIgnored private let joining: NetJoinClient
    /// Some Mac of the net has been asked for the list on this launch.
    @ObservationIgnored private var hasListed = false
    /// The Macs whose list is being asked for now, by host.
    @ObservationIgnored private var listing: Set<HostID> = []
    /// The hosts that did not take the token since they last did: when every Mac of the
    /// net is one, the device is out of it.
    @ObservationIgnored private var refusedBy: [HostID: String?] = [:]
    /// The membership was dropped as the app started, its token gone: the net's hosts are
    /// to go too, once the fleet has them (`attach`).
    @ObservationIgnored private var lostItsToken = false
    /// A Mac of the net is taking this device out at its own asking (a switch of nets):
    /// the net it ends here says nothing of being removed (`leaveHere`).
    @ObservationIgnored private var leavingOnPurpose: (net: String?, attempt: NetAttempt)?
    /// An explicit Leave owns its removal, not a switch's cleanup, while its Mac answers.
    @ObservationIgnored private var leavesInFlight = 0
    /// Asking the Macs of the nets left behind is under way, or waits for its next go.
    @ObservationIgnored private var askingLeftBehind: Task<Void, Never>?
    /// Joins, Adds a Mac and switches under way (`open`, `switchToNet`): no Mac of a net left
    /// behind is asked to take the device out meanwhile, which may be joining that net again
    /// with a token its Macs have not all heard of.
    @ObservationIgnored private var changesUnderWay = 0
    /// Those changes run one at a time, from a code's redemption until what it came to is
    /// saved, a password sign-in coming before: two switches at once could each redeem a
    /// code, and the one saved last keep a token the net had already replaced (`NetChanges`).
    @ObservationIgnored private let changes = NetChanges()
    /// How long between two goes at the nets left behind.
    private static let leftBehindEvery: Duration = .seconds(10 * 60)

    init(credentials: any CredentialStore, store: ThreadStore, saves: Bool, joining: NetJoinClient = NetJoinClient()) {
        self.credentials = credentials
        self.store = store
        self.saves = saves
        self.joining = joining
        relayRoutes = RelayRoutes(credentials: credentials)
        if saves, let saved = store.loadNet() {
            membership = saved
        } else {
            membership = NetMembership()
            // The device's id is made once, and kept from now on.
            if saves { store.saveNet(membership) }
        }
        // A list kept without its token is no net to be in: the Keychain was cleared, or the
        // data folder came back from a backup onto another device, whose Keychain item does
        // not move with it. A new id then, so that joining again from here does not take the
        // place of the device the backup was made on.
        if membership.isInNet, credentials.netToken() == nil {
            membership = NetMembership()
            lostItsToken = true
            save()
        }
        relayRoutes.update(membership)
    }

    /// The fleet whose hosts the net changes, as the app starts. Hosts left from a
    /// membership dropped for its lost token go, with no call to their Macs: they could not
    /// sign in.
    func attach(to fleet: Fleet) {
        self.fleet = fleet
        askLeftBehind()
        guard lostItsToken else { return }
        lostItsToken = false
        fleet.netLeft()
    }

    var isInNet: Bool { membership.isInNet }

    /// The token, for a net host's sign-in.
    var token: String? { credentials.netToken() }

    /// This device as it joins a net.
    var device: NetDevice { device(thisMac: nil) }

    /// This device as it joins a net; `thisMac`, the net's name for the bridge on this same
    /// Mac when the one joined through is that one.
    private func device(thisMac: String?) -> NetDevice {
        NetDevice(id: membership.deviceID, name: String(deviceName(thisMac: thisMac).prefix(80)), platform: Platform.netPlatform)
    }

    /// The name this device joins a net with: the one it was last given in a net
    /// (`NetMembership.givenName`), else its own. On a Mac that is the net's name for the
    /// bridge on this same Mac (`thisMac`, else a host of the fleet whose bridge is on this
    /// Mac), or "Mac": Mac Catalyst's own name for the device is "iPad", which a Mac
    /// app joined the net as (2026-10-28). On an iPhone or iPad it is the system's, which
    /// since iOS 16 is the model's alone ("iPhone") unless Apple grants an entitlement.
    private func deviceName(thisMac: String?) -> String {
        if let given = membership.givenName, !given.isEmpty { return given }
        guard Platform.isMac else { return UIDevice.current.name }
        if let thisMac, !thisMac.isEmpty { return thisMac }
        if let host = fleet?.hosts.first(where: \.isOnThisMac) { return host.host.netName ?? host.host.name }
        return "Mac"
    }

    // MARK: Keeping up

    /// A host said something of the net (`NetNews`). Only the device's net hosts count:
    /// a Mac added by hand speaks for a net the device is not signed in to. So does only a
    /// host the fleet has now: one let go of (its Mac gone from the net, or the net left or
    /// switched) shuts down in its own time, and what it says meanwhile is of before.
    func said(_ news: NetNews, by host: HostModel) {
        guard isInNet, host.host.isNetHost, isCurrent(host) else { return }
        switch news {
        case let .at(revision):
            refusedBy[host.id] = nil
            let mac = host.host.netMember ?? ""
            if !hasListed || membership.needsList(from: mac, at: revision) { list(from: host) }
        case let .refused(reason):
            refusedBy[host.id] = .some(reason)
            AppLog.chat.notice("\(host.host.name, privacy: .public) did not take the net's token")
            // Another Mac, should one take the token still, says whether the device is out.
            if let other = connectedNetHosts.first(where: { $0.id != host.id }) {
                list(from: other)
            } else {
                leaveIfEveryMacRefuses()
            }
        }
    }

    /// Asks `host` for the list, and takes it: unless the net was joined, left or switched
    /// meanwhile, or the host let go of (`NetMembership.heard`).
    private func list(from host: HostModel) {
        guard let remote = host.netHost, !listing.contains(host.id) else { return }
        listing.insert(host.id)
        hasListed = true
        let asked = membership.generation
        Task {
            defer { listing.remove(host.id) }
            do {
                let list = try await remote.netList()
                guard isCurrent(host) else { return }
                take(list, askedIn: asked)
            } catch {
                AppLog.chat.error("Could not list the net on \(host.host.name, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Takes a list a Mac gave the device signed in with its token, asked for in the
    /// membership's generation `asked`: one asked for before a join, a leave or a switch is
    /// dropped. One that says the device was taken out ends its membership; one of another
    /// net it is a member of is that net now (a Mac it joined through went into another net,
    /// and its devices came along).
    private func take(_ list: NetList, askedIn asked: Int) {
        guard membership.heard(list, askedIn: asked) else { return }
        if membership.ownEntry?.isRemoved == true {
            leaveHere(saying: "\(Platform.thisDeviceCapitalized) was removed from your net. Add it again from a portal in the net, or scan a host's code.")
            return
        }
        save()
        fleet?.netChanged(membership.members)
    }

    /// Every Mac of the net refused the token, or there is none: the device is out.
    private func leaveIfEveryMacRefuses() {
        let netHosts = fleet?.hosts.filter(\.host.isNetHost) ?? []
        guard isInNet, netHosts.allSatisfy({ refusedBy[$0.id] != nil }) else { return }
        let reason = netHosts.compactMap { refusedBy[$0.id] ?? nil }.first
        leaveHere(saying: reason.map { "\($0) Add \(Platform.thisDevice) again from a portal in the net, or scan a host's code." }
            ?? "No host of your net takes \(Platform.thisDevice) any more. Add it again from a portal in the net, or scan a host's code.")
    }

    /// Whether `host` is one the fleet has now, not one let go of.
    private func isCurrent(_ host: HostModel) -> Bool {
        fleet?.hosts.contains { $0 === host } == true
    }

    /// The net's hosts that are connected now.
    private var connectedNetHosts: [HostModel] {
        fleet?.hosts.filter { $0.host.isNetHost && $0.isConnected } ?? []
    }

    /// The net's hosts connected now, by id: read in a view, it is drawn again as one
    /// connects or drops (each host's connection is observed).
    var connectedNetHostIDs: [HostID] {
        connectedNetHosts.map(\.id)
    }

    /// The connected net host that makes join codes: one reached directly before one
    /// reached only through the relay (`NetHosts.forCodes`).
    private var codeHost: HostModel? {
        NetHosts.forCodes(connectedNetHosts, viaRelay: \.isViaRelay)
    }

    // MARK: Codes and links

    /// What `link` comes to here (`NetScan`), done: joining, adding a Mac, or nothing new.
    /// Stopped, with no further call to a Mac, once the task is cancelled (the sheet that
    /// started it closed) or the device joined, left or switched nets meanwhile
    /// (`NetAttempt`).
    func open(_ link: PortalsLink) async throws -> Outcome {
        changesUnderWay += 1
        defer { changesUnderWay -= 1 }
        let attempt = attempt()
        switch NetScan.decide(link, membership: membership, hosts: fleet?.hosts.map(\.host) ?? []) {
        case let .join(join):
            return try await self.join(join, attempt)
        case let .switchNet(join):
            // The old net is left only once the new one is joined (`become`): a code that
            // does not work leaves the device where it was.
            return try await self.join(join, attempt)
        case let .known(host):
            return .known(host)
        case let .pairIntoNet(pairing):
            return try await pairIntoNet(pairing, attempt)
        case let .addMac(pairing):
            return try await addMac(pairing, attempt)
        }
    }

    /// A join, an Add a Mac or a switch, starting now in the membership's generation.
    private func attempt() -> NetAttempt {
        NetAttempt(generation: membership.generation) { [weak self] in self?.membership.generation ?? -1 }
    }

    /// Joins the net of a join link: the code redeemed at its Mac, the token kept, every
    /// Mac of the net a host.
    private func join(_ link: JoinLink, _ attempt: NetAttempt) async throws -> Outcome {
        // One at a time from the code's redemption until what it came to is saved
        // (`NetChanges`); the redemption's first check finds a change made meanwhile.
        try await changes.run {
            let joined = try await attempt.redeem { try await joining.join(at: link.url, code: link.code, as: device) }
            try await become(joined, attempt)
        }
        return .joined
    }

    /// A Mac's pairing link in no net: signed in with its password once, the Mac makes a
    /// code, and the device redeems it, joining that Mac's net. A Mac without the net is
    /// added by itself.
    private func pairIntoNet(_ pairing: PairingLink, _ attempt: NetAttempt) async throws -> Outcome {
        try await signedIn(to: pairing) { mac in
            // A Mac app pairing with the bridge on its own Mac is named after it: the name its
            // code's link carries, the net's for it.
            let isThisMac = Platform.isMac ? await mac.machine.map(Platform.isThisMac) ?? false : false
            // Signed in, which does not stop for a cancel, before the turn is taken: a sign-in
            // that stalled, its sheet closed, held up every change after it (`NetChanges`).
            return try await changes.run {
                guard let joined = try await attempt.joinThrough(mac, redeem: { invite in
                    let thisMac = isThisMac ? (try? JoinLink(parsing: invite.link))?.name : nil
                    return try await joining.join(at: pairing.url, code: invite.code, as: device(thisMac: thisMac))
                }) else { return .withoutNet }
                try await become(joined, attempt)
                return .joined
            }
        }
    }

    /// A Mac's pairing link outside the device's net: signed in to it with its password, a
    /// Mac of the net makes a code, and the new Mac joins with it. A Mac in the net already
    /// is nothing new; one in a net with other Macs says why not (`Outcome.refused`).
    private func addMac(_ pairing: PairingLink, _ attempt: NetAttempt) async throws -> Outcome {
        try await signedIn(to: pairing) { mac in
            // Signed in first, as a pairing into a net is, then one at a time (`NetChanges`).
            try await changes.run {
                switch try await attempt.add(mac, to: membership.net, codeFrom: { codeHost?.netHost }) {
                case .withoutNet:
                    return .withoutNet
                case let .known(theirs):
                    fleet?.netChanged(membership.members)
                    return .known(fleet?.hosts.first { $0.host.netMember == theirs.here }?.id)
                case let .refused(reason):
                    return .refused(reason)
                case let .joined(joined):
                    take(joined, askedIn: attempt.generation)
                    return .added(fleet?.hosts.first { $0.host.netMember == joined.here }?.id)
                }
            }
        }
    }

    /// The Mac of a pairing link refused to join the device's net: the device joins that
    /// Mac's instead, and leaves its own (with no call to it) once it has.
    func switchToNet(of pairing: PairingLink) async throws -> Outcome {
        changesUnderWay += 1
        defer { changesUnderWay -= 1 }
        return try await pairIntoNet(pairing, attempt())
    }

    /// Runs `body` with a connection to the Mac of a pairing link, signed in with its
    /// password, and lets go of it after.
    private func signedIn(to pairing: PairingLink, _ body: (HermesBackend) async throws -> Outcome) async throws -> Outcome {
        let authenticator = PasswordAuthenticator(baseURL: pairing.url) {
            PasswordAuthenticator.Credentials(username: pairing.username, password: pairing.password)
        }
        let mac = HermesBackend(host: HostID(rawValue: "pairing"), authenticator: authenticator)
        do {
            try await mac.connect()
            let outcome = try await body(mac)
            await mac.disconnect()
            return outcome
        } catch {
            await mac.disconnect()
            throw error
        }
    }

    /// The device is a member of the net it joined: the token in the Keychain, the list
    /// kept, every Mac a host. The net it was in, if any, is left first: a Mac of it still
    /// connected takes the device out (`NetAttempt.leaveOldNet`, as Leave does), so the
    /// old net stops sending it notifications it can no longer open; then it is left here.
    ///
    /// The new net has the device by now: a cancel (the sheet closed) does not stop this,
    /// only a join, leave or switch meanwhile does. A cancel while the old Mac answered used
    /// to throw the new net's token away, which left the device in no net while the new
    /// net listed it (bug hunt round 4, APP1). Now a cancel ends only the wait for the old
    /// Mac, which then counts as not answered: the old net is kept and asked again
    /// (`NetLeftBehind`).
    private func become(_ joined: NetJoined, _ attempt: NetAttempt) async throws {
        try attempt.checkCurrent()
        guard leavesInFlight == 0 else { throw NetError.overtaken }
        if isInNet {
            // What is needed to ask the old net again, should its Mac not take the device
            // out now: its Macs and the token, both gone with it here.
            let left = NetLeftBehind(leaving: membership)
            let oldToken = credentials.netToken()
            let asked = connectedNetHosts.first
            // The Mac closes this device's connections as it takes it out, and its Macs may
            // say so before the call comes back: no "removed from your net" for that.
            leavingOnPurpose = (membership.net, attempt)
            defer {
                if leavingOnPurpose?.attempt === attempt { leavingOnPurpose = nil }
            }
            let answer = await NetAttempt.leaveOldNet(membership.net, for: joined, device: membership.deviceID, through: asked?.netHost)
            try attempt.checkCurrent()
            guard leavesInFlight == 0 else { throw NetError.overtaken }
            leaveHere(saying: nil)
            // No Mac connected, or the one asked did not answer: kept, and asked again.
            if let answer, let oldToken, let left = left?.after(asked?.host.netMember.map { [$0: answer] } ?? [:]) {
                credentials.setLeftNetToken(oldToken, for: left.net)
                membership.keep(left)
            }
        }
        // A net left behind and joined again is the device's: none of its Macs is to take it out.
        if membership.leftBehind?.contains(where: { $0.net == joined.net }) == true {
            membership.leftBehind(joined.net, is: nil)
            credentials.setLeftNetToken(nil, for: joined.net)
        }
        credentials.setNetToken(joined.token)
        membership.joined(joined)
        refusedBy = [:]
        hasListed = true
        save()
        fleet?.netChanged(membership.members)
        askLeftBehind()
    }

    // MARK: Nets left behind

    /// Asks the Macs of each net left behind (`NetLeftBehind`) to take the device out: now,
    /// and every ten minutes while one is kept, as the app runs and from one launch to the
    /// next. One whose time is up is given up, and the person told.
    private func askLeftBehind() {
        guard saves, askingLeftBehind == nil, membership.leftBehind?.isEmpty == false else { return }
        askingLeftBehind = Task { [weak self] in
            while true {
                guard let self, self.membership.leftBehind?.isEmpty == false else { break }
                await self.askLeftBehindOnce()
                guard self.membership.leftBehind?.isEmpty == false else { break }
                try? await Task.sleep(for: Self.leftBehindEvery)
            }
            self?.askingLeftBehind = nil
        }
    }

    /// One go at every net left behind: each of its Macs in turn, with the old token, until
    /// one takes the device out.
    private func askLeftBehindOnce() async {
        for left in membership.leftBehind ?? [] {
            guard left.net != membership.net, let token = credentials.leftNetToken(for: left.net) else {
                forget(left.net)
                continue
            }
            if left.isOver(at: .now) {
                forget(left.net)
                AppLog.chat.notice("Gave up taking this device out of a net it left: no host of it answered")
                leftBehindNotice = "No host of the net \(Platform.thisDevice) left could be reached to take it out, so that net may still list it and send it notifications it cannot open. Remove \(Platform.thisDevice) from Devices on a device still in that net."
                continue
            }
            var answers: [String: NetLeftBehindAnswer] = [:]
            for mac in left.macs {
                let answer = await ask(mac, toTakeOut: left.net, token: token) { [weak self] in
                    // Joined again, or joining a net (that one, maybe) meanwhile: none of its
                    // Macs is to take the device out.
                    guard let self, changesUnderWay == 0 else { return false }
                    return membership.net != left.net && membership.leftBehind?.contains { $0.net == left.net } == true
                }
                answers[mac.id] = answer
                if answer == .out { break }
            }
            // Joined again meanwhile: the device's net now, which none of its Macs is to leave.
            guard membership.leftBehind?.contains(left) == true else { continue }
            if let after = left.after(answers) {
                membership.leftBehind(left.net, is: after)
                save()
            } else {
                forget(left.net)
            }
        }
    }

    /// Lets go of a net left behind, and of its token.
    private func forget(_ net: String) {
        membership.leftBehind(net, is: nil)
        credentials.setLeftNetToken(nil, for: net)
        save()
    }

    /// Has `mac`, of the net `net` left behind, take the device out of it, signed in with the
    /// token the device had there (`NetAttempt.takeOut`), while `wanted`. One that does not
    /// take the token can do nothing for it: it left that net, or the device was taken out
    /// there; which, it does not say, so the net's other Macs are still asked.
    private func ask(_ mac: NetLeftBehind.Mac, toTakeOut net: String, token: String, while wanted: () -> Bool) async -> NetLeftBehindAnswer {
        let backend = HermesBackend(host: HostID(rawValue: "net-left-behind"), authenticator: TokenAuthenticator(baseURL: mac.url) { token })
        let answer: NetLeftBehindAnswer
        do {
            try await backend.connect()
            answer = await NetAttempt.takeOut(membership.deviceID, of: net, through: backend, while: wanted)
        } catch let closed as WebSocketClosed where closed.isUnauthorized {
            answer = .notThere
        } catch {
            answer = .unanswered
        }
        await backend.disconnect()
        return answer
    }

    // MARK: Add a device, Devices

    /// A join code for another device, from a Mac of the net that answers: none once the
    /// task is cancelled (Add a device closed) or the device joined, left or switched nets
    /// as the Mac made it, which would be a code into a net the device is not in.
    func invite() async throws -> NetInvite {
        let attempt = attempt()
        guard let host = codeHost?.netHost else { throw NetError.noMacAnswers }
        return try await attempt.step { try await host.netInvite() }
    }

    /// Takes a member out of the net, on every Mac, through a Mac of the net that answers:
    /// not the one taken out, which cannot take itself out. This device leaves instead
    /// (`leave`).
    func remove(_ member: NetMember) async throws {
        guard member.id != membership.deviceID else { return await leave() }
        let others = connectedNetHosts.filter { $0.host.netMember != member.id }
        guard let remote = others.first?.netHost else {
            if connectedNetHosts.isEmpty { throw NetError.noMacAnswers }
            throw NetError.refused("Only \(member.name) is connected, and a host cannot take itself out of the net. Try again once another host of your net is, or run `portals net leave` on \(member.name).")
        }
        let asked = membership.generation
        take(try await remote.netRemove(member.id), askedIn: asked)
    }

    // MARK: Names

    /// Whether renaming `host` here renames its Mac on every device and Mac of the net
    /// (feature `net_rename`; 2026-10-26: a Mac renamed in the app is renamed
    /// everywhere, on every Mac and device, the latest rename winning): a Mac of the net,
    /// with a Mac of it connected that takes the rename. Otherwise the name is this
    /// device's own, as before.
    func renamesEverywhere(_ host: HostConfig) async -> Bool {
        guard isInNet, host.isNetHost else { return false }
        return await renamer(for: host) != nil
    }

    /// The connected Mac of the net a rename of `host` goes through: the Mac itself, so that
    /// it goes by the name at once, else another that takes renames, which copies it to
    /// every Mac (any Mac of the net may rename any; the Mac renamed takes it as the list
    /// reaches it, also one asleep, or reached only through the relay).
    private func renamer(for host: HostConfig) async -> (any NetReporting)? {
        let connected = connectedNetHosts
        for model in connected.filter({ $0.id == host.id }) + connected.filter({ $0.id != host.id }) {
            if let remote = model.netHost, await remote.renamesNetMacs == true { return remote }
        }
        return nil
    }

    /// Renames the Mac of `host` `name` on every Mac and device of the net, and names the
    /// host here as the net does from then on: also when the name was the net's already,
    /// which a name given on this device alone was kept over. The rename comes after the
    /// name the device holds for it, which the Mac it goes through may not have heard of.
    /// Throws `NetError.noMacAnswers` when no Mac of the net that takes it is connected, or
    /// the Mac's sentence; the host keeps the name it had then. The net it is for is the one
    /// the device is in as it is asked: should the device join, leave or switch nets while a
    /// Mac is chosen, it stops there (`NetError.overtaken`), and a Mac that has moved into
    /// another net since refuses it, so an answer from the old net never stands for the new.
    func rename(_ host: HostConfig, to name: String) async throws {
        guard let member = host.netMember, isInNet else { throw NetError.unavailable }
        let asked = membership.generation, net = membership.net
        guard let remote = await renamer(for: host) else { throw NetError.noMacAnswers }
        guard membership.generation == asked else { throw NetError.overtaken }
        let held = membership.members.first { $0.id == member }?.named
        take(try await remote.netRename(member, to: name, after: held, inNet: net), askedIn: asked)
        guard membership.generation == asked, let entry = membership.members.first(where: { $0.id == member }),
              let model = fleet?.model(for: host.id), model.host.netMember == member else { return }
        let named = model.host.named(as: entry)
        guard named != model.host else { return }
        model.renamed(named)
        fleet?.hostChanged(named)
    }

    /// Whether a device of the net can be renamed from here on every Mac and device of it
    /// (feature `net_rename_devices`; 2026-10-28: as a Mac is): a Mac of the net is
    /// connected that takes it.
    func renamesDevices() async -> Bool {
        guard isInNet else { return false }
        return await deviceRenamer() != nil
    }

    /// The connected Mac of the net a device's rename goes through: any that takes it, which
    /// copies it to every Mac.
    private func deviceRenamer() async -> (any NetReporting)? {
        for model in connectedNetHosts {
            if let remote = model.netHost, await remote.renamesNetDevices == true { return remote }
        }
        return nil
    }

    /// Renames the device `member` of the net `name` on every Mac and device of it, after the
    /// name the device holds for it, and takes the list after: this device's own name too,
    /// which it joins a net with from then on (`NetMembership.givenName`). Throws as
    /// `rename(_:to:)` does: `NetError.noMacAnswers` with no Mac of the net connected that
    /// takes it, `.overtaken` when the device joined, left or switched nets meanwhile, or
    /// the Mac's sentence.
    func renameDevice(_ member: NetMember, to name: String) async throws {
        guard isInNet, member.kind == .device else { throw NetError.unavailable }
        let asked = membership.generation, net = membership.net
        guard let remote = await deviceRenamer() else { throw NetError.noMacAnswers }
        guard membership.generation == asked else { throw NetError.overtaken }
        let held = membership.members.first { $0.id == member.id }?.named
        take(try await remote.netRename(member.id, to: name, after: held, inNet: net), askedIn: asked)
    }

    /// This device leaves its net: a Mac of the net that answers takes it out, so its token
    /// is refused from then on, and its Macs go from it with their threads. Should no Mac
    /// answer, it leaves all the same; the others still list it until it is removed there.
    /// Unless it joined or left a net meanwhile: then the net it was to leave is gone already.
    func leave() async {
        leavesInFlight += 1
        defer { leavesInFlight -= 1 }
        leavingOnPurpose = nil
        let asked = membership.generation
        if let remote = connectedNetHosts.first?.netHost {
            // That Mac closes this connection as it takes the device out: its answer may
            // not come.
            do {
                _ = try await remote.netRemove(membership.deviceID)
            } catch {
                AppLog.chat.notice("Leaving the net: \(error.localizedDescription, privacy: .public)")
            }
        }
        guard membership.generation == asked else { return }
        leaveHere(saying: nil)
    }

    /// Ends the membership here: the net's hosts go with their threads, with no call to the
    /// Macs; the token is forgotten; the device's id stays.
    private func leaveHere(saying notice: String?) {
        guard isInNet else { return }
        let oldNet = membership.net, asked = membership.generation
        membership.leave()
        if notice != nil, let leaving = leavingOnPurpose, leaving.net == oldNet {
            leaving.attempt.leftOldNet(askedIn: asked)
        }
        refusedBy = [:]
        save()
        credentials.setNetToken(nil)
        fleet?.netLeft()
        if let notice, leavingOnPurpose == nil { self.notice = notice }
    }

    /// Keeps the membership: for the relay's routes at once, and in the data folder.
    private func save() {
        relayRoutes.update(membership)
        guard saves else { return }
        store.saveNet(membership)
    }
}

/// The ways through the relay to the Macs of the device's net (docs/net-plan.md, "The relay
/// as backup, per host"), as the hosts' backends ask for them when each attempt to connect
/// begins: away from the main thread, which reading the Keychain would hold up.
nonisolated final class RelayRoutes: Sendable {
    private struct Entry {
        var relay: String
        var key: String
    }

    private let credentials: any CredentialStore
    /// Each Mac's relay id and key, by its id, from the list as last kept; empty in no net.
    private let macs = Mutex<[String: Entry]>([:])

    init(credentials: any CredentialStore) {
        self.credentials = credentials
    }

    func update(_ membership: NetMembership) {
        var entries: [String: Entry] = [:]
        if membership.isInNet {
            for mac in membership.members where mac.kind == .mac && !mac.isRemoved {
                if let relay = mac.relay, let key = mac.key { entries[mac.id] = Entry(relay: relay, key: key) }
            }
        }
        macs.withLock { $0 = entries }
    }

    /// The way to the net's Mac `member`: the relay this build names, the Mac's relay id and
    /// key from its entry as last listed, and the token. nil in no net, with no relay, or for
    /// a Mac whose entry has neither.
    func route(to member: String) -> RelayRoute? {
        guard let entry = macs.withLock({ $0[member] }), let relay = RelayRegistration.relay,
              let token = credentials.netToken() else { return nil }
        return RelayRoute(relay: relay, relayID: entry.relay, macKey: entry.key, token: token)
    }
}
