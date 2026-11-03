import Foundation
import Testing
@testable import AgentCore

/// The device's side of the net (docs/net-plan.md): its membership as kept, the join link,
/// which hosts the list makes, and what a scanned code comes to.
@Suite struct NetTests {
    private static let studio = URL(string: "https://studio.tailnet.ts.net:10010")!
    private static let mini = URL(string: "https://mini.tailnet.ts.net:10010")!
    private static let laptop = URL(string: "https://laptop.tailnet.ts.net:10010")!

    private func mac(_ id: String, _ name: String, _ url: URL?, removed: Bool = false) -> NetMember {
        NetMember(id: id, kind: .mac, name: name, url: url, key: "k-\(id)", relay: "r-\(id)", removed: removed, changed: 1, by: id)
    }

    private func device(_ id: String, _ name: String, platform: String = "ios", removed: Bool = false) -> NetMember {
        NetMember(id: id, kind: .device, name: name, platform: platform, removed: removed, changed: 1, by: "studio-0001")
    }

    private var members: [NetMember] {
        [
            mac("studio-0001", "Studio", Self.studio),
            mac("mini-00002", "Mac mini", Self.mini),
            device("phone-0003", "iPhone"),
        ]
    }

    // MARK: Membership

    @Test func theMembershipIsKeptInTheDataFolderAndItsDeviceIDStays() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ThreadStore(directory: directory)
        #expect(store.loadNet() == nil)

        var membership = NetMembership()
        let id = membership.deviceID
        #expect(UUID(uuidString: id) != nil)
        #expect(!membership.isInNet)
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "secret", members: members))
        membership.revisions["studio-0001"] = 4
        #expect(store.saveNet(membership))
        // The token is not in the file: it is the Keychain's.
        let text = try String(contentsOf: directory.appendingPathComponent("net.json"), encoding: .utf8)
        #expect(!text.contains("secret"))

        var loaded = try #require(store.loadNet())
        #expect(loaded == membership)
        #expect(loaded.macs.map(\.id) == ["studio-0001", "mini-00002"])

        loaded.leave()
        #expect(!loaded.isInNet && loaded.members.isEmpty && loaded.revisions.isEmpty)
        #expect(loaded.deviceID == id)
    }

    /// net-17's leftover: a net the device switched away from with no Mac of it taking it
    /// out is kept, with its Macs, through the switch's leave and join and an app launch
    /// (the file), and its token is not in the file.
    @Test func aNetLeftBehindIsKeptThroughTheSwitchAndALaunch() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ThreadStore(directory: directory)
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "old-secret", members: members))
        let left = try #require(NetLeftBehind(leaving: membership, at: Date(timeIntervalSince1970: 1_000)))
        #expect(left.net == "3e5a9c1f0b7d2468")
        #expect(left.macs == [NetLeftBehind.Mac(id: "studio-0001", url: Self.studio), NetLeftBehind.Mac(id: "mini-00002", url: Self.mini)])
        membership.leave()
        membership.keep(left)
        membership.joined(NetJoined(net: "aaaaaaaaaaaaaaaa", token: "new-secret", members: []))
        #expect(membership.leftBehind == [left])
        #expect(store.saveNet(membership))
        let text = try String(contentsOf: directory.appendingPathComponent("net.json"), encoding: .utf8)
        #expect(!text.contains("secret"))
        #expect(try #require(store.loadNet()).leftBehind == [left])
        // A file from before has none.
        #expect(NetLeftBehind(leaving: NetMembership()) == nil)
        membership.leftBehind("3e5a9c1f0b7d2468", is: nil)
        #expect(membership.leftBehind == nil)
    }

    /// One go at a net left behind: done once a Mac takes the device out, or none of them
    /// can; else kept without those that cannot; given up after its lifetime.
    @Test func aNetLeftBehindIsAskedUntilAMacTakesTheDeviceOutOrNoneCan() {
        let since = Date(timeIntervalSince1970: 1_000)
        let left = NetLeftBehind(
            net: "3e5a9c1f0b7d2468", macs: [NetLeftBehind.Mac(id: "studio-0001", url: Self.studio), NetLeftBehind.Mac(id: "mini-00002", url: Self.mini)],
            since: since
        )
        #expect(left.after(["studio-0001": .unanswered, "mini-00002": .out]) == nil)
        #expect(left.after(["studio-0001": .notThere, "mini-00002": .notThere]) == nil)
        #expect(left.after(["studio-0001": .notThere, "mini-00002": .unanswered])?.macs.map(\.id) == ["mini-00002"])
        #expect(left.after([:]) == left)
        #expect(!left.isOver(at: since.addingTimeInterval(NetLeftBehind.lifetime - 1)))
        #expect(left.isOver(at: since.addingTimeInterval(NetLeftBehind.lifetime)))
    }

    @Test func joinCodesComeFromAMacReachedDirectlyBeforeOneReachedThroughTheRelay() {
        // In the order the hosts are listed: the first through the relay is passed over.
        let hosts = [("studio", true), ("mini", false), ("laptop", false)]
        #expect(NetHosts.forCodes(hosts, viaRelay: \.1)?.0 == "mini")
        // Only through the relay: that one, rather than none.
        #expect(NetHosts.forCodes([("studio", true), ("laptop", true)], viaRelay: \.1)?.0 == "studio")
        #expect(NetHosts.forCodes([(String, Bool)](), viaRelay: \.1) == nil)
    }

    @Test func aMacIsAskedForTheListOnlyWhenItSaysAnotherRevision() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        let at = NetRevision(net: "3e5a9c1f0b7d2468", revision: 7)
        // Not listed from that Mac yet.
        #expect(membership.needsList(from: "studio-0001", at: at))
        let took = membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 7, members: members))
        #expect(took)
        #expect(!membership.needsList(from: "studio-0001", at: at))
        #expect(membership.needsList(from: "studio-0001", at: NetRevision(net: "3e5a9c1f0b7d2468", revision: 8)))
        // Each Mac counts its own revisions.
        #expect(membership.needsList(from: "mini-00002", at: at))
        #expect(membership.needsList(from: "studio-0001", at: NetRevision(net: "0000000000000000", revision: 7)))
        // Another net's list is not taken.
        let tookOther = membership.take(NetList(net: "0000000000000000", here: "mini-00002", revision: 1, members: []))
        #expect(!tookOther)
        #expect(membership.members == members)
    }

    /// A Mac that missed a change gives a copy without it: merged, as the Macs merge, so the
    /// device keeps what a fresher copy had.
    @Test func aListFromAMacThatMissedAChangeDoesNotTakeAwayWhatAFresherOneHad() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        var laptop = mac("laptop-003", "Laptop", Self.laptop)
        laptop.changed = 5
        laptop.by = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 3, members: members + [laptop]))
        // The mini slept through the laptop's joining, and has the Studio renamed since.
        var renamed = mac("studio-0001", "Studio Max", Self.studio)
        renamed.changed = 6
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", you: "phone-0003", revision: 9, members: [renamed] + members.dropFirst()))
        #expect(membership.members.map(\.id) == ["studio-0001", "mini-00002", "phone-0003", "laptop-003"])
        #expect(membership.members.first?.name == "Studio Max")
        #expect(NetHosts.apply(membership.members, to: []).compactMap(\.netMember) == ["studio-0001", "mini-00002", "laptop-003"])
        #expect(membership.revisions == ["studio-0001": 3, "mini-00002": 9])

        // An older copy of an entry does not win; a tie goes to the greater `by`.
        var older = mac("laptop-003", "Old name", Self.laptop)
        older.changed = 4
        var tie = mac("mini-00002", "Mini", Self.mini)
        tie.by = "zz-mac-0009"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", you: "phone-0003", revision: 10, members: [older, tie]))
        #expect(membership.members.first { $0.id == "laptop-003" }?.name == "Laptop")
        #expect(membership.members.first { $0.id == "mini-00002" }?.name == "Mini")

        // A removal wins when newer; the removed Mac's own copy, newer still, does not undo it.
        var removed = mac("laptop-003", "Laptop", Self.laptop, removed: true)
        removed.changed = 7
        removed.by = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 4, members: [removed]))
        var itsOwn = mac("laptop-003", "Laptop 2", Self.laptop)
        itsOwn.changed = 8
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "laptop-003", you: "phone-0003", revision: 2, members: [itsOwn]))
        #expect(membership.members.first { $0.id == "laptop-003" }?.isRemoved == true)
    }

    /// The other order of the last step above: a Mac removed while it was off starts again,
    /// writes its entry anew (a new address, say) and gives the device its list before it
    /// has heard of its removal. Its entry is then newer than the removal another Mac gives
    /// after, as the Macs' own merge (`isNewer` in bridge/src/net/members.ts) allows: a Mac's
    /// own word that it is in does not stand against its removal. Else the device kept a
    /// host for it that no Mac of the net has, refusing the token, for good.
    @Test func aMacsOwnCopyTakenBeforeItsRemovalDoesNotKeepItIn() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        var itsOwn = mac("mini-00002", "Mac mini", Self.laptop)
        itsOwn.changed = 8
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", you: "phone-0003", revision: 2, members: [itsOwn]))
        #expect(membership.macs.map(\.id) == ["studio-0001", "mini-00002"])
        var removed = mac("mini-00002", "Mac mini", Self.mini, removed: true)
        removed.changed = 7
        removed.by = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 4, members: [removed]))
        #expect(membership.members.first { $0.id == "mini-00002" }?.isRemoved == true)
        #expect(membership.macs.map(\.id) == ["studio-0001"])

        // A device's entry is never its own word: a newer one stands against an older removal.
        var phone = device("ipad-000004", "iPad")
        phone.changed = 9
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 5, members: [phone]))
        var gone = device("ipad-000004", "iPad", removed: true)
        gone.changed = 8
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", you: "phone-0003", revision: 3, members: [gone]))
        #expect(membership.members.first { $0.id == "ipad-000004" }?.isRemoved == false)
    }

    /// net-5: the device judges a member's own word as the Macs do, by its token's tag. A
    /// removed Mac's own newer entry, passed on by another Mac that missed the removal,
    /// does not bring its host back; taken in again under another token, its own later word
    /// stands against a removal from a Mac that slept through it.
    @Test func aMacsOwnWordIsJudgedByItsTokensTagAsTheMacsJudgeIt() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        var removed = mac("mini-00002", "Mac mini", Self.mini, removed: true)
        removed.changed = 7
        removed.by = "studio-0001"
        removed.tokenTag = "aaaaaaaaaaaaaaaa"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 2, members: [removed]))
        #expect(membership.macs.map(\.id) == ["studio-0001"])
        // Its own entry, newer, under the token it was removed with, from a Mac that missed the removal.
        var itsOwn = mac("mini-00002", "Mac mini", Self.laptop)
        itsOwn.changed = 9
        itsOwn.tokenTag = "aaaaaaaaaaaaaaaa"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "laptop-0003", you: "phone-0003", revision: 3, members: [itsOwn]))
        #expect(membership.members.first { $0.id == "mini-00002" }?.isRemoved == true)
        #expect(membership.macs.map(\.id) == ["studio-0001"])

        // Taken in again under a new token: its own later word is in, and a removal of the
        // old token from a Mac that slept through it does not take it out.
        var again = itsOwn
        again.changed = 11
        again.tokenTag = "bbbbbbbbbbbbbbbb"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", you: "phone-0003", revision: 4, members: [again]))
        #expect(membership.macs.map(\.id) == ["studio-0001", "mini-00002"])
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 5, members: [removed]))
        #expect(membership.macs.map(\.id) == ["studio-0001", "mini-00002"])
        #expect(membership.members.first { $0.id == "mini-00002" }?.tokenTag == "bbbbbbbbbbbbbbbb")
    }

    /// An entry kept from a bridge from before the tags takes its tag when a newer one gives
    /// the same change with it.
    @Test func anEntryKeptWithoutItsTagTakesItFromTheSameChange() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        var tagged = membership.members.first { $0.id == "studio-0001" }!
        tagged.tokenTag = "cccccccccccccccc"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 2, members: [tagged]))
        #expect(membership.members.first { $0.id == "studio-0001" }?.tokenTag == "cccccccccccccccc")
    }

    /// A list asked for in one net and answered after the device joined another is that
    /// other net's past: dropped, so it brings back neither the old net nor its Macs, and
    /// takes none of the new one's away (Codex review of net, finding 5).
    @Test func aListAskedForBeforeAJoinALeaveOrASwitchIsDropped() throws {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "aaaaaaaaaaaaaaaa", token: "a", members: members))
        let inA = membership.generation
        let fromA = NetList(net: "aaaaaaaaaaaaaaaa", here: "studio-0001", you: "phone-0003", revision: 3, members: members)
        let takenInA = membership.heard(fromA, askedIn: inA)
        #expect(takenInA)

        // Asked of A's Studio, then the device joined B: A's answer comes late.
        let inB = [mac("laptop-003", "Laptop", Self.laptop), device("phone-0003", "iPhone")]
        membership.joined(NetJoined(net: "bbbbbbbbbbbbbbbb", token: "b", members: inB))
        #expect(membership.generation != inA)
        let lateFromA = membership.heard(fromA, askedIn: inA)
        #expect(!lateFromA)
        #expect(membership.net == "bbbbbbbbbbbbbbbb")
        #expect(membership.members == inB)
        #expect(membership.revisions.isEmpty)

        // One asked for in B is taken.
        let fromB = NetList(net: "bbbbbbbbbbbbbbbb", here: "laptop-003", you: "phone-0003", revision: 1, members: inB)
        let asked = membership.generation
        let takenInB = membership.heard(fromB, askedIn: asked)
        #expect(takenInB)

        // Left meanwhile: nothing is taken, nothing brings a net back.
        membership.leave()
        let askedBeforeLeaving = membership.heard(fromB, askedIn: asked)
        #expect(!askedBeforeLeaving)
        let inNoNet = membership.heard(fromB, askedIn: membership.generation)
        #expect(!inNoNet)
        #expect(!membership.isInNet && membership.members.isEmpty)
    }

    /// The Mac the device joined through went into another net, its devices along: the
    /// device is in that net now, a generation on, and a list of the old net asked for
    /// before does not take it back.
    @Test func aListOfAnotherNetThatListsTheDeviceIsThatNetAGenerationOn() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "aaaaaaaaaaaaaaaa", token: "t", members: members))
        let asked = membership.generation
        let moved = NetList(net: "cccccccccccccccc", here: "studio-0001", you: "phone-0003", revision: 1, members: members)
        let followed = membership.heard(moved, askedIn: asked)
        #expect(followed)
        #expect(membership.net == "cccccccccccccccc")
        #expect(membership.generation != asked)
        let late = NetList(net: "aaaaaaaaaaaaaaaa", here: "mini-00002", you: "phone-0003", revision: 5, members: members)
        let lateFromTheOldNet = membership.heard(late, askedIn: asked)
        #expect(!lateFromTheOldNet)
        #expect(membership.net == "cccccccccccccccc")
        // Another net's list that does not list the device is not that net.
        let other = NetList(net: "dddddddddddddddd", here: "mini-00002", you: nil, revision: 1, members: [])
        let notListedThere = membership.heard(other, askedIn: membership.generation)
        #expect(!notListedThere)
        #expect(membership.net == "cccccccccccccccc")
    }

    /// The generation is this launch's: not kept, and not what makes two memberships the same.
    @Test func theGenerationIsNotKept() throws {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "aaaaaaaaaaaaaaaa", token: "t", members: members))
        let text = String(decoding: try JSONEncoder().encode(membership), as: UTF8.self)
        #expect(!text.contains("generation"))
        let loaded = try JSONDecoder().decode(NetMembership.self, from: Data(text.utf8))
        #expect(loaded == membership)
        #expect(loaded.generation == 0)
    }

    @Test func devicesListsMacsFirstAndLeavesOutTheRemoved() {
        let membership = NetMembership(
            deviceID: "phone-0003", net: "3e5a9c1f0b7d2468",
            members: [device("phone-0003", "iPhone"), mac("studio-0001", "Studio", Self.studio), device("pad-000004", "iPad", removed: true),
                      mac("mini-00002", "Mac mini", Self.mini, removed: true), device("pad-000005", "iPad", platform: "ipados")]
        )
        #expect(membership.shownMembers.map(\.id) == ["studio-0001", "phone-0003", "pad-000005"])
        #expect(membership.ownEntry?.name == "iPhone")
        #expect(membership.macs.map(\.id) == ["studio-0001"])
    }

    // MARK: The join link

    private func link(_ values: [String: String]) -> String {
        var components = URLComponents()
        components.scheme = "portals"
        components.host = "join"
        components.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.string!
    }

    @Test func aJoinLinkIsRead() throws {
        let join = try JoinLink(parsing: link(["v": "1", "url": Self.studio.absoluteString, "code": "x7Hq2b9LkPz0aW4vR1sYtA", "name": "Studio", "later": "1"]))
        #expect(join == JoinLink(url: Self.studio, code: "x7Hq2b9LkPz0aW4vR1sYtA", name: "Studio"))
        #expect(join.macName == "Studio")
        let unnamed = try JoinLink(parsing: "PORTALS://Join?url=http%3A%2F%2F127.0.0.1%3A9311&code=abc \n")
        #expect(unnamed.url == URL(string: "http://127.0.0.1:9311")!)
        #expect(unnamed.macName == "127")
    }

    @Test func aJoinLinkThatCannotBeUsedSaysWhy() {
        #expect(throws: JoinLink.Problem.newerVersion) { try JoinLink(parsing: link(["v": "2", "url": Self.studio.absoluteString, "code": "c"])) }
        #expect(JoinLink.Problem.newerVersion.localizedDescription == "Update Portals to join this net.")
        #expect(throws: JoinLink.Problem.missingCode) { try JoinLink(parsing: link(["v": "1", "url": Self.studio.absoluteString, "code": " "])) }
        #expect(throws: JoinLink.Problem.missingAddress) { try JoinLink(parsing: link(["v": "1", "code": "c"])) }
        #expect(throws: JoinLink.Problem.badAddress) { try JoinLink(parsing: link(["url": "ftp://studio", "code": "c"])) }
        #expect(throws: JoinLink.Problem.notALink) { try JoinLink(parsing: "portals://pair?url=https://studio") }
    }

    @Test func aPortalsLinkIsAMacsPairingLinkOrAWayIntoANet() throws {
        let pairing = "portals://pair?v=1&url=https%3A%2F%2Fstudio.tailnet.ts.net%3A10010&user=dana&password=s3cret"
        #expect(try PortalsLink(parsing: pairing) == .pair(PairingLink(url: Self.studio, username: "dana", password: "s3cret")))
        let join = link(["url": Self.studio.absoluteString, "code": "c"])
        #expect(try PortalsLink(parsing: join) == .join(JoinLink(url: Self.studio, code: "c")))
        #expect(throws: JoinLink.Problem.newerVersion) { try PortalsLink(parsing: link(["v": "9", "url": Self.studio.absoluteString, "code": "c"])) }
        #expect(throws: PairingLink.Problem.notALink) { try PortalsLink(parsing: "https://example.com") }
    }

    // MARK: Hosts from the list

    @Test func everyMacOfTheNetIsAHostSignedInWithTheToken() {
        let hosts = NetHosts.apply(members + [mac("gone-00004", "Old", Self.laptop, removed: true), mac("nowhere-05", "No address", nil)], to: [])
        #expect(hosts.map(\.name) == ["Studio", "Mac mini"])
        #expect(hosts.map(\.netMember) == ["studio-0001", "mini-00002"])
        #expect(hosts.map(\.machineID) == ["studio-0001", "mini-00002"])
        #expect(hosts.allSatisfy { $0.isNetHost && $0.username == nil && $0.kind == .bridge })
        #expect(hosts.map(\.url) == [Self.studio, Self.mini])
        // Taken again, the same list changes nothing.
        #expect(NetHosts.apply(members, to: hosts) == hosts)
    }

    @Test func aHostAddedByHandForAMacOfTheNetBecomesTheNetsNotASecondOne() {
        let byID = HostConfig(id: HostID(rawValue: "hand-1"), name: "My studio", url: URL(string: "https://studio.old-name.ts.net:10010")!, username: "dana", machineID: "studio-0001")
        let byAddress = HostConfig(id: HostID(rawValue: "hand-2"), name: "mini", url: URL(string: "HTTPS://mini.tailnet.ts.net:10010/")!, username: "dana")
        let other = HostConfig(id: HostID(rawValue: "hermes"), name: "Hermes", url: URL(string: "https://hermes.tailnet.ts.net")!, username: "dana")
        let hosts = NetHosts.apply(members, to: [other, byID, byAddress])
        #expect(hosts.map(\.id.rawValue) == ["hermes", "hand-1", "hand-2"])
        #expect(hosts[0] == other)
        // Its threads stay under its id; its name the user's; its address and sign-in the net's.
        #expect(hosts[1].name == "My studio" && hosts[1].url == Self.studio && hosts[1].username == nil && hosts[1].netMember == "studio-0001")
        #expect(hosts[2].name == "mini" && hosts[2].netName == "Mac mini" && hosts[2].machineID == "mini-00002" && hosts[2].isNetHost)
    }

    @Test func aMacTakenOutOfTheNetGoesAndAHostAddedByHandForItStays() {
        let hosts = NetHosts.apply(members, to: [])
        let byHand = HostConfig(id: HostID(rawValue: "hand-9"), name: "Laptop", url: Self.laptop, username: "dana", machineID: "laptop-006")
        var after = members
        after[1].removed = true
        #expect(NetHosts.apply(after, to: hosts + [byHand]).map(\.name) == ["Studio", "Laptop"])
        #expect(NetHosts.apply(Array(members.prefix(1)), to: hosts).map(\.name) == ["Studio"])
    }

    @Test func aNewNameInTheListIsTakenUnlessTheUserGaveTheHostOne() {
        var hosts = NetHosts.apply(members, to: [])
        hosts[1].name = "Downstairs"
        var renamed = members
        renamed[0].name = "Studio Pro"
        renamed[1].name = "Mini"
        renamed[1].url = URL(string: "https://mini2.tailnet.ts.net:10010")!
        let after = NetHosts.apply(renamed, to: hosts)
        #expect(after.map(\.name) == ["Studio Pro", "Downstairs"])
        #expect(after[1].netName == "Mini" && after[1].url == URL(string: "https://mini2.tailnet.ts.net:10010")!)
        #expect(after.map(\.id) == hosts.map(\.id))
    }

    // MARK: Names set from the app (feature net_rename)

    /// 2026-10-28: a device is renamed across the net as a Mac is (feature
    /// `net_rename_devices`): its name merged apart from the rest of its entry, the later
    /// stamp winning whichever entry wins.
    @Test func aDevicesNameSetFromTheAppIsMergedAsAMacsIs() {
        var membership = NetMembership(deviceID: "ipad-0009")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        var renamed = device("phone-0003", "Dana's iPhone")
        renamed.named = 5000
        renamed.namedBy = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", revision: 2, members: [renamed]))
        #expect(membership.members.first { $0.id == "phone-0003" }?.name == "Dana's iPhone")
        // A Mac that has not heard of it gives the entry newer (removed meanwhile): removed, under the later name.
        var removed = device("phone-0003", "iPhone", removed: true)
        removed.changed = 9
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", revision: 3, members: [removed]))
        let entry = membership.members.first { $0.id == "phone-0003" }
        #expect(entry?.isRemoved == true && entry?.name == "Dana's iPhone" && entry?.named == 5000)
        // Not this device: the name it was given stays its own business.
        #expect(membership.givenName == nil)
    }

    /// The name this device was given in its net is the one it joins a net with from then
    /// on (`Net.device`), kept through leaving, switching and launches, as a Mac keeps one.
    @Test func theNameThisDeviceWasGivenIsKeptThroughLeavingAndJoiningAgain() throws {
        var membership = NetMembership(deviceID: "macapp-0004")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members + [device("macapp-0004", "iPad", platform: "macos")]))
        #expect(membership.givenName == nil)
        var renamed = device("macapp-0004", "MacBook Pro 16", platform: "macos")
        renamed.named = 5000
        renamed.namedBy = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", revision: 2, members: [renamed]))
        #expect(membership.givenName == "MacBook Pro 16")
        // Kept with the membership, and read from one saved before there was such a name.
        let saved = try JSONDecoder().decode(NetMembership.self, from: JSONEncoder().encode(membership))
        #expect(saved.givenName == "MacBook Pro 16" && saved == membership)
        let older = try JSONDecoder().decode(NetMembership.self, from: Data(#"{"deviceID":"d","members":[],"revisions":{}}"#.utf8))
        #expect(older.givenName == nil)
        // Out of the net, and into another where it joined under that name, unstamped: kept.
        membership.leave()
        #expect(membership.givenName == "MacBook Pro 16")
        membership.joined(NetJoined(net: "0000000000000001", token: "u", members: [device("macapp-0004", "MacBook Pro 16", platform: "macos")]))
        #expect(membership.givenName == "MacBook Pro 16")
        // Renamed there: the new name.
        renamed.name = "Desk"
        membership.take(NetList(net: "0000000000000001", here: "studio-0001", revision: 1, members: [renamed]))
        #expect(membership.givenName == "Desk")
        // Joined again under a name of its own: the Mac stamps it at the entry's own change,
        // which is no name it was given, and the one given stays (Codex's re-check, 2026-10-29).
        var joinedAgain = device("macapp-0004", "Mac", platform: "macos")
        joinedAgain.changed = 9000
        joinedAgain.named = 9000
        joinedAgain.namedBy = "studio-0001"
        membership.take(NetList(net: "0000000000000001", here: "studio-0001", revision: 2, members: [joinedAgain]))
        #expect(membership.members.first { $0.id == "macapp-0004" }?.name == "Mac")
        #expect(membership.givenName == "Desk")
        // Renamed on another Mac at that very stamp, the greater id's name winning: given, by
        // another Mac than the one that made the entry (Codex's re-check, 2026-10-29).
        var tie = joinedAgain
        tie.name = "Desk Two"
        tie.namedBy = "zz-mac-0009"
        membership.take(NetList(net: "0000000000000001", here: "zz-mac-0009", revision: 1, members: [tie]))
        #expect(membership.givenName == "Desk Two")
    }

    /// 2026-10-26: a Mac renamed in the app is renamed everywhere, on every Mac and
    /// device, the latest rename winning. A name given on this device alone, before any
    /// rename through the net (or for a Mac whose bridge has none), stays as before.
    @Test func aRenameMadeThroughTheNetReplacesANameGivenOnThisDeviceAndTheNextOneStaysTillAnotherRename() {
        var hosts = NetHosts.apply(members, to: [])
        hosts[1].name = "Downstairs"
        #expect(hosts[1].netNamed == nil)
        // Its Computer Name changed, with no rename from the app: the user's name stays.
        var listed = members
        listed[1].name = "Dana's Mac mini"
        hosts = NetHosts.apply(listed, to: hosts)
        #expect(hosts.map(\.name) == ["Studio", "Downstairs"])
        // Renamed from another device: the net's name is this one's too, over the user's.
        listed[1].name = "Office"
        listed[1].named = 5000
        listed[1].namedBy = "studio-0001"
        hosts = NetHosts.apply(listed, to: hosts)
        #expect(hosts.map(\.name) == ["Studio", "Office"])
        #expect(hosts[1].netName == "Office" && hosts[1].netNamed == 5000)
        // Given a name here alone again (the Mac's bridge could not take it): kept, as the
        // same list, or one with the same stamp, comes again.
        hosts[1].name = "Den"
        #expect(NetHosts.apply(listed, to: hosts).map(\.name) == ["Studio", "Den"])
        // Until the next rename, here or anywhere.
        listed[1].name = "Office 2"
        listed[1].named = 6000
        #expect(NetHosts.apply(listed, to: hosts).map(\.name) == ["Studio", "Office 2"])
        // The Studio, followed all along, follows a rename as any new name.
        listed[0].name = "Atelier"
        listed[0].named = 7000
        listed[0].namedBy = "mini-00002"
        #expect(NetHosts.apply(listed, to: hosts).first?.name == "Atelier")
    }

    /// Two renames at the same stamp from two Macs: the greater Mac's wins on every Mac and in
    /// the device's list, and it replaces a name given on this device as any other rename
    /// does (Codex review of n13/names, finding 3).
    @Test func aRenameAtTheSameStampByAnotherMacReplacesANameGivenOnThisDevice() {
        var listed = members
        listed[1].name = "Office"
        listed[1].named = 5000
        listed[1].namedBy = "mini-00002"
        var hosts = NetHosts.apply(listed, to: NetHosts.apply(members, to: []))
        hosts[1].name = "Den"
        listed[1].name = "Zed"
        listed[1].namedBy = "zz-mac-0009"
        hosts = NetHosts.apply(listed, to: hosts)
        #expect(hosts[1].name == "Zed" && hosts[1].netNamedBy == "zz-mac-0009")
        // Taken again, the same list keeps a name given here after it.
        hosts[1].name = "Den again"
        #expect(NetHosts.apply(listed, to: hosts)[1].name == "Den again")
    }

    @Test func aHostAddedByHandKeepsItsNameAsItBecomesTheNetsAndFollowsTheRenamesAfter() {
        var listed = members
        listed[0].name = "Atelier"
        listed[0].named = 5000
        listed[0].namedBy = "mini-00002"
        let byHand = HostConfig(id: HostID(rawValue: "hand-1"), name: "My studio", url: Self.studio, username: "dana", machineID: "studio-0001")
        var hosts = NetHosts.apply(listed, to: [byHand])
        #expect(hosts.first?.name == "My studio" && hosts.first?.netNamed == 5000)
        listed[0].name = "Atelier Two"
        listed[0].named = 5001
        hosts = NetHosts.apply(listed, to: hosts)
        #expect(hosts.first?.name == "Atelier Two")
        // A new host for a Mac of the net has the stamp of its name from the start.
        #expect(HostConfig(netMac: listed[0]).netNamed == 5001)
    }

    @Test func aRenameThisDeviceMadeNamesTheHostAsTheNetDoesAlsoWhenTheNameWasTheNetsAlready() {
        var hosts = NetHosts.apply(members, to: [])
        hosts[1].name = "Downstairs"
        // Renamed to "Mac mini", the net's name already: the Mac changes nothing, and the host
        // follows the net from now on.
        let named = hosts[1].named(as: members[1])
        #expect(named.name == "Mac mini" && named.netName == "Mac mini" && named.netNamed == nil)
        var listed = members
        listed[1].name = "Mini"
        #expect(NetHosts.apply(listed, to: [hosts[0], named]).map(\.name) == ["Studio", "Mini"])
    }

    @Test func aMacsNameSetFromTheAppIsMergedApartFromItsEntryTheLaterWinning() {
        var membership = NetMembership(deviceID: "phone-0003")
        membership.joined(NetJoined(net: "3e5a9c1f0b7d2468", token: "t", members: members))
        // Renamed on the Studio.
        var renamed = mac("mini-00002", "Office", Self.mini)
        renamed.named = 5000
        renamed.namedBy = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 3, members: [renamed]))
        #expect(membership.members[1].name == "Office")
        // The mini wrote its entry anew (a new address) before it heard: newer, under the
        // name before and no stamp, as a bridge from before gives it too. The address is
        // taken, the rename stays.
        var rewritten = mac("mini-00002", "Mac mini", URL(string: "https://mini2.tailnet.ts.net:10010")!)
        rewritten.changed = 9
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "mini-00002", you: "phone-0003", revision: 4, members: [rewritten]))
        #expect(membership.members[1].name == "Office" && membership.members[1].url == URL(string: "https://mini2.tailnet.ts.net:10010")!)
        #expect(membership.members[1].changed == 9 && membership.members[1].named == 5000)
        // Of two renames the later stamp, whichever entry is newer; at the same stamp the greater Mac's.
        var later = renamed
        later.name = "Later"
        later.named = 6000
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 5, members: [later]))
        #expect(membership.members[1].name == "Later" && membership.members[1].changed == 9)
        var tie = later
        tie.name = "Tie"
        tie.namedBy = "zz-mac-0009"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 6, members: [tie]))
        #expect(membership.members[1].name == "Tie")
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 7, members: [later]))
        #expect(membership.members[1].name == "Tie")
        // A removal made apart from a rename keeps the Mac out, under the later name.
        var removed = mac("mini-00002", "Mac mini", Self.mini, removed: true)
        removed.changed = 20
        removed.by = "studio-0001"
        membership.take(NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 8, members: [removed]))
        #expect(membership.members[1].isRemoved && membership.members[1].name == "Tie")
    }

    @Test func aHostAddedByHandThatTurnsOutToBeAMacTheNetHasAHostForGoes() {
        let hosts = NetHosts.apply(members, to: [])
        let late = HostConfig(id: HostID(rawValue: "hand-3"), name: "Mini by hand", url: URL(string: "https://192.168.1.4:10010")!, username: "dana", machineID: "mini-00002")
        #expect(NetHosts.apply(members, to: hosts + [late]) == hosts)
    }

    @Test func aHostKeepsTheStampOfItsNetNameAndOneSavedBeforeHasNone() throws {
        var host = HostConfig(netMac: mac("mini-00002", "Office", Self.mini))
        host.netNamed = 5000
        let saved = try JSONEncoder().encode([host])
        #expect(try JSONDecoder().decode([HostConfig].self, from: saved).first?.netNamed == 5000)
        let old = #"[{"id":"h","name":"Mini","url":"https://mini.tailnet.ts.net:10010","netMember":"mini-00002","netName":"Mini"}]"#
        #expect(try JSONDecoder().decode([HostConfig].self, from: Data(old.utf8)).first?.netNamed == nil)
    }

    @Test func aHostSavedBeforeTheNetReadsAsAddedByHand() throws {
        let old = #"[{"id":"h","name":"Mini","url":"https://mini.tailnet.ts.net:10010","username":"dana","machineID":"mini-00002"}]"#
        let decoded = try JSONDecoder().decode([HostConfig].self, from: Data(old.utf8))
        #expect(decoded.first?.isNetHost == false)
        let net = NetHosts.apply(members, to: [])
        #expect(try JSONDecoder().decode([HostConfig].self, from: JSONEncoder().encode(net)) == net)
    }

    // MARK: Scanning

    private var inNet: (membership: NetMembership, hosts: [HostConfig]) {
        let membership = NetMembership(deviceID: "phone-0003", net: "3e5a9c1f0b7d2468", members: members)
        return (membership, NetHosts.apply(members, to: []))
    }

    @Test func aWayIntoANetJoinsItInNoNetAndAsksBeforeSwitchingFromAnother() {
        let join = JoinLink(url: Self.laptop, code: "c")
        #expect(NetScan.decide(.join(join), membership: NetMembership(), hosts: []) == .join(join))
        let (membership, hosts) = inNet
        #expect(NetScan.decide(.join(join), membership: membership, hosts: hosts) == .switchNet(join))
        // One made by a Mac of the device's own net is nothing new.
        let ours = JoinLink(url: URL(string: "https://mini.tailnet.ts.net:10010/")!, code: "c")
        #expect(NetScan.decide(.join(ours), membership: membership, hosts: hosts) == .known(hosts[1].id))
    }

    @Test func aMacsPairingLinkJoinsItsNetInNoNetAndAddsItToTheDevicesOtherwise() {
        let laptop = PairingLink(url: Self.laptop, username: "dana", password: "s3cret")
        // Hosts added by hand are no net.
        let byHand = [HostConfig(name: "Laptop", url: Self.laptop, username: "dana")]
        #expect(NetScan.decide(.pair(laptop), membership: NetMembership(), hosts: byHand) == .pairIntoNet(laptop))
        let (membership, hosts) = inNet
        #expect(NetScan.decide(.pair(laptop), membership: membership, hosts: hosts) == .addMac(laptop))
        // A Mac of the net already: that host, nothing new.
        let studio = PairingLink(url: Self.studio, username: "dana", password: "s3cret")
        #expect(NetScan.decide(.pair(studio), membership: membership, hosts: hosts) == .known(hosts[0].id))
    }
}
