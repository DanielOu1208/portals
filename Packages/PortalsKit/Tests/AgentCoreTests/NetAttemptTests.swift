import Foundation
import Testing
@testable import AgentCore

/// A join, an Add a Mac or a switch of nets stops at the first await after its task was
/// cancelled or the membership moved on to another generation, with no further call to a
/// Mac (`NetAttempt`; Codex re-check of net, finding 3). A join that already succeeded
/// keeps its token despite cancellation, but not after another generation took over.
@MainActor
@Suite struct NetAttemptTests {
    /// A Mac as the device reaches it: what was asked of it, in order. A call named in
    /// `held` waits for `release` before it answers.
    actor Mac: NetReporting {
        private(set) var net: String
        let id: String
        private(set) var calls: [String] = []
        /// The members taken out, as a bridge does: not when the removal names another net
        /// than the one the Mac is in.
        private(set) var removed: [String] = []
        /// The net the Mac moves into right after it answers `netList`.
        var movesAfterListingTo: String?
        /// Its list has these members, as removed.
        var listsRemoved: [String] = []
        /// It does not answer.
        var isDown = false
        /// Its answer to a removal does not come.
        var losesRemovals = false
        private var held: Set<String>
        private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
        private var arrivals: [String: CheckedContinuation<Void, Never>] = [:]

        nonisolated let netNews = AsyncStream<NetNews> { _ in }

        init(net: String, id: String, holding held: Set<String> = []) {
            self.net = net
            self.id = id
            self.held = held
        }

        var offersNet: Bool? {
            get async {
                await answer("offersNet")
                return true
            }
        }

        func netList() async throws -> NetList {
            await answer("netList")
            if isDown { throw CancellationError() }
            let list = NetList(net: net, here: id, revision: 1, members: listsRemoved.map { NetMember(id: $0, kind: .device, name: $0, removed: true) })
            if let moved = movesAfterListingTo { net = moved }
            return list
        }

        func moves(afterListingTo net: String) {
            movesAfterListingTo = net
        }

        func lists(removed member: String) {
            listsRemoved.append(member)
        }

        func goesDown() {
            isDown = true
        }

        func losesItsRemovals() {
            losesRemovals = true
        }

        func netInvite() async throws -> NetInvite {
            await answer("netInvite")
            return NetInvite(link: "portals://join?net=\(net)", code: "code-\(net)", expiresAt: .distantFuture)
        }

        func netRemove(_ member: String, inNet asked: String?) async throws -> NetList {
            await answer("netRemove \(member)")
            if let asked, asked != net { throw NetError.refused("This Mac is not in that net any more: nothing was removed.") }
            if losesRemovals { throw CancellationError() }
            removed.append(member)
            return NetList(net: net, here: id, revision: 2, members: [])
        }

        func netJoin(with link: String) async throws -> NetList {
            await answer("netJoin \(link)")
            return NetList(net: "joined", here: id, revision: 2, members: [])
        }

        /// Waits until `call` was made and is held.
        func arrived(_ call: String) async {
            if waiting[call] != nil { return }
            await withCheckedContinuation { arrivals[call] = $0 }
        }

        func release(_ call: String) {
            held.remove(call)
            waiting.removeValue(forKey: call)?.resume()
        }

        private func answer(_ call: String) async {
            calls.append(call)
            let name = String(call.prefix { $0 != " " })
            guard held.contains(name) else { return }
            await withCheckedContinuation { continuation in
                waiting[name] = continuation
                arrivals.removeValue(forKey: name)?.resume()
            }
        }
    }

    /// The membership's generation, as `Net` holds it.
    final class Generation {
        var value = 1
    }

    private func attempt(_ generation: Generation) -> NetAttempt {
        NetAttempt(generation: generation.value) { generation.value }
    }

    @Test func anAddAMacWhoseNetWasSwitchedWhileTheNewMacAnsweredMakesNoCodeAndNoJoin() async throws {
        let generation = Generation()
        let new = Mac(net: "c", id: "new", holding: ["netList"])
        let ofA = Mac(net: "a", id: "a-mac")
        let ofB = Mac(net: "b", id: "b-mac")
        var maker: any NetReporting = ofA
        let attempt = attempt(generation)
        let adding = Task { try await attempt.add(new, to: "a", codeFrom: { maker }) }
        await new.arrived("netList")

        // The sheet is closed, and the device switches to net B, whose Mac is the one that
        // answers now.
        generation.value = 3
        maker = ofB
        await new.release("netList")

        await #expect(throws: NetError.overtaken) { try await adding.value }
        #expect(await ofA.calls.isEmpty)
        #expect(await ofB.calls.isEmpty)
        #expect(await new.calls == ["offersNet", "netList"])
    }

    @Test func anAddAMacWhoseSheetWasClosedStopsAtItsNextAwait() async throws {
        let generation = Generation()
        let new = Mac(net: "c", id: "new", holding: ["netList"])
        let ours = Mac(net: "a", id: "a-mac")
        let attempt = attempt(generation)
        let adding = Task { try await attempt.add(new, to: "a", codeFrom: { ours }) }
        await new.arrived("netList")
        adding.cancel()
        await new.release("netList")

        await #expect(throws: CancellationError.self) { try await adding.value }
        #expect(await ours.calls.isEmpty)
        #expect(await new.calls == ["offersNet", "netList"])
    }

    @Test func aCodeMadeAsTheNetChangedIsNotGivenToTheNewMac() async throws {
        let generation = Generation()
        let new = Mac(net: "c", id: "new")
        let ours = Mac(net: "a", id: "a-mac", holding: ["netInvite"])
        let attempt = attempt(generation)
        let adding = Task { try await attempt.add(new, to: "a", codeFrom: { ours }) }
        await ours.arrived("netInvite")
        generation.value = 2
        await ours.release("netInvite")

        await #expect(throws: NetError.overtaken) { try await adding.value }
        #expect(await new.calls == ["offersNet", "netList"])
    }

    @Test func aBridgeWithoutTheNetAnsweringAfterTheSheetClosedIsNotAddedByItself() async throws {
        let generation = Generation()
        let new = Mac(net: "c", id: "new", holding: ["offersNet"])
        let attempt = attempt(generation)
        let adding = Task { try await attempt.add(new, to: "a", codeFrom: { nil }) }
        await new.arrived("offersNet")
        adding.cancel()
        await new.release("offersNet")

        await #expect(throws: CancellationError.self) { try await adding.value }
        #expect(await new.calls == ["offersNet"])
    }

    @Test func anAddAMacLeftAloneJoinsWithTheNetsCode() async throws {
        let generation = Generation()
        let new = Mac(net: "c", id: "new")
        let ours = Mac(net: "a", id: "a-mac")
        let added = try await attempt(generation).add(new, to: "a", codeFrom: { ours })

        #expect(added == .joined(NetList(net: "joined", here: "new", revision: 2, members: [])))
        #expect(await ours.calls == ["netInvite"])
        #expect(await new.calls == ["offersNet", "netList", "netJoin portals://join?net=a"])
    }

    @Test func aMacOfTheNetAlreadyIsKnownWithNoCode() async throws {
        let new = Mac(net: "a", id: "new")
        let ours = Mac(net: "a", id: "a-mac")
        let added = try await attempt(Generation()).add(new, to: "a", codeFrom: { ours })

        #expect(added == .known(NetList(net: "a", here: "new", revision: 1, members: [])))
        #expect(await ours.calls.isEmpty)
    }

    @Test func joiningThroughAMacRedeemsNothingOnceTheNetChanged() async throws {
        let generation = Generation()
        let mac = Mac(net: "b", id: "b-mac", holding: ["netInvite"])
        var redeemed: [String] = []
        let attempt = attempt(generation)
        let joining = Task {
            try await attempt.joinThrough(mac) { invite in
                redeemed.append(invite.code)
                return NetJoined(net: "b", token: "t", members: [])
            }
        }
        await mac.arrived("netInvite")
        generation.value = 2
        await mac.release("netInvite")

        await #expect(throws: NetError.overtaken) { try await joining.value }
        #expect(redeemed.isEmpty)
    }

    @Test func aRedeemedCodeAnsweredAfterTheSheetClosedKeepsItsToken() async throws {
        let mac = Mac(net: "b", id: "b-mac")
        let joining = Task { @MainActor in
            try await attempt(Generation()).joinThrough(mac) { invite in
                withUnsafeCurrentTask { $0?.cancel() }
                return NetJoined(net: "b", token: "t-\(invite.code)", members: [])
            }
        }
        #expect(try await joining.value?.token == "t-code-b")

        let joined = try await attempt(Generation()).joinThrough(mac) { NetJoined(net: "b", token: "t-\($0.code)", members: []) }
        #expect(joined?.token == "t-code-b")
    }

    @Test func aSheetClosedBeforeRedemptionRedeemsNothing() async throws {
        var redeemed = false
        let joining = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await attempt(Generation()).redeem {
                redeemed = true
                return NetJoined(net: "b", token: "t", members: [])
            }
        }
        await #expect(throws: CancellationError.self) { try await joining.value }
        #expect(!redeemed)
    }

    @Test func aRedeemedCodeAnsweredAfterAnotherNetChangeIsNotTaken() async throws {
        let generation = Generation()
        let mac = Mac(net: "b", id: "b-mac")
        let attempt = attempt(generation)
        await #expect(throws: NetError.overtaken) {
            try await attempt.joinThrough(mac) { _ in
                generation.value += 1
                return NetJoined(net: "b", token: "new-token", members: [])
            }
        }
    }

    @Test func closingTheSheetBeforeTheCodeIsMadeRedeemsNothing() async throws {
        let mac = Mac(net: "b", id: "b-mac", holding: ["netInvite"])
        var redeemed = false
        let attempt = attempt(Generation())
        let joining = Task {
            try await attempt.joinThrough(mac) { _ in
                redeemed = true
                return NetJoined(net: "b", token: "new-token", members: [])
            }
        }
        await mac.arrived("netInvite")
        joining.cancel()
        await mac.release("netInvite")
        await #expect(throws: CancellationError.self) { try await joining.value }
        #expect(!redeemed)
    }

    @Test func aStepTakenUnderTheGenerationItStartedInPasses() async throws {
        let generation = Generation()
        let attempt = attempt(generation)
        #expect(try await attempt.step { 7 } == 7)
        generation.value = 2
        await #expect(throws: NetError.overtaken) { try await attempt.step { 7 } }
    }

    /// net-17: a device that switched nets asks a Mac of the old net to take it out, once
    /// the new join worked; not for the same net, nor with no net before or no Mac to ask.
    @Test func aSwitchOfNetsHasAMacOfTheOldNetTakeTheDeviceOut() async {
        let old = Mac(net: "old-net", id: "mini")
        let joined = NetJoined(net: "new-net", token: "t", members: [])
        await NetAttempt.leaveOldNet("old-net", for: joined, device: "phone-1", through: old)
        #expect(await old.calls == ["netList", "netRemove phone-1"])

        // The old net's Mac moved into the net joined meanwhile (Codex review): it is not
        // asked to take the device out of that one.
        let moved = Mac(net: "new-net", id: "mini")
        await NetAttempt.leaveOldNet("old-net", for: joined, device: "phone-1", through: moved)
        #expect(await moved.calls == ["netList"])

        // It moves into the net joined between its two answers: the removal names the old
        // net, and the Mac refuses it, so the device stays in the net it joined.
        let moving = Mac(net: "old-net", id: "mini")
        await moving.moves(afterListingTo: "new-net")
        await NetAttempt.leaveOldNet("old-net", for: joined, device: "phone-1", through: moving)
        #expect(await moving.calls == ["netList", "netRemove phone-1"])
        #expect(await moving.removed.isEmpty)
        #expect(await old.removed == ["phone-1"])

        let same = Mac(net: "new-net", id: "studio")
        await NetAttempt.leaveOldNet("new-net", for: joined, device: "phone-1", through: same)
        await NetAttempt.leaveOldNet(nil, for: joined, device: "phone-1", through: same)
        #expect(await same.calls.isEmpty)
        // No Mac of the old net connected: not answered, for the old net to be kept and asked again.
        #expect(await NetAttempt.leaveOldNet("old-net", for: joined, device: "phone-1", through: nil) == .unanswered)
        #expect(await NetAttempt.leaveOldNet("new-net", for: joined, device: "phone-1", through: nil) == nil)
    }

    /// net-17's leftover: asked again later, a Mac of the net left behind takes the device
    /// out; one that lists it removed already is done with no call; one in another net now,
    /// or that refuses the removal for being in another, cannot; one down is asked again.
    @Test func aMacOfANetLeftBehindTakesTheDeviceOutWhenItIsReachedAgain() async {
        let old = Mac(net: "old-net", id: "mini")
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: old) == .out)
        #expect(await old.removed == ["phone-1"])

        let knows = Mac(net: "old-net", id: "studio")
        await knows.lists(removed: "phone-1")
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: knows) == .out)
        #expect(await knows.calls == ["netList"])

        let moved = Mac(net: "new-net", id: "laptop")
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: moved) == .notThere)
        #expect(await moved.calls == ["netList"])

        let moving = Mac(net: "old-net", id: "laptop")
        await moving.moves(afterListingTo: "new-net")
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: moving) == .notThere)
        #expect(await moving.removed.isEmpty)

        let down = Mac(net: "old-net", id: "mini")
        await down.goesDown()
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: down) == .unanswered)
        #expect(await down.removed.isEmpty)

        // Codex's review: a removal whose answer does not come (it failed on the Mac, or was
        // made and the connection closed) is not taken as made: asked again.
        let losing = Mac(net: "old-net", id: "mini")
        await losing.losesItsRemovals()
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: losing) == .unanswered)
        let left = NetLeftBehind(net: "old-net", macs: [NetLeftBehind.Mac(id: "mini", url: URL(string: "https://mini.tailnet.ts.net:10010")!)])
        #expect(left.after(["mini": .unanswered]) == left)

        // Codex's review: the device joined that net again while the list was on its way:
        // no removal goes.
        let rejoined = Mac(net: "old-net", id: "mini")
        #expect(await NetAttempt.takeOut("phone-1", of: "old-net", through: rejoined, while: { false }) == .unanswered)
        #expect(await rejoined.calls == ["netList"])
    }

    /// The end of a switch, as Net holds it (`Net.become`): one cleanup owns the old net's
    /// removal; once the new net has taken the device, a closed sheet does not undo that,
    /// and only a switch, leave or move of nets meanwhile stops it saving the new token and
    /// membership. An old net whose Mac did not answer is kept to be asked again.
    @MainActor final class Switching {
        var membership = NetMembership(deviceID: "phone", net: "old", members: [
            NetMember(id: "mini", kind: .mac, name: "Mini", url: URL(string: "https://mini.tailnet.ts.net:10010")!),
        ])
        var token = "old-token"
        var leftTokens: [String: String] = [:]
        var leaving: (net: String?, attempt: NetAttempt)?
        let changes = NetChanges()

        /// A switch from its start, as `Net` runs one: through a pairing link, signed in to
        /// its Mac with the password first (`Net.signedIn`), which `signingIn`'s answer
        /// stands for, before the turn is taken; then, one at a time, the code redeemed at
        /// `bridge` (its first step checking the membership is the one it started from), and
        /// `become`.
        func switchTo(_ net: String, at bridge: Bridge, through old: Mac, signingIn: Mac? = nil) async throws {
            let attempt = NetAttempt(generation: membership.generation) { self.membership.generation }
            if let signingIn { _ = await signingIn.offersNet }
            try await changes.run {
                let joined = try await attempt.step { await bridge.join(net) }
                try await become(joined, through: old, attempt)
            }
        }

        func become(_ joined: NetJoined, through old: Mac, _ started: NetAttempt? = nil) async throws {
            let attempt = started ?? NetAttempt(generation: membership.generation) { self.membership.generation }
            try attempt.checkCurrent()
            if membership.isInNet {
                let left = NetLeftBehind(leaving: membership), oldToken = token
                leaving = (membership.net, attempt)
                defer {
                    if leaving?.attempt === attempt { leaving = nil }
                }
                let answer = await NetAttempt.leaveOldNet(membership.net, for: joined, device: membership.deviceID, through: old)
                try attempt.checkCurrent()
                membership.leave()
                if let answer, let left = left?.after([old.id: answer]) {
                    leftTokens[left.net] = oldToken
                    membership.keep(left)
                }
            }
            token = joined.token
            membership.joined(joined)
        }

        /// The old Mac's removal of this device, heard as its cleanup is under way.
        func removed() {
            let net = membership.net, asked = membership.generation
            membership.leave()
            if let leaving, leaving.net == net { leaving.attempt.leftOldNet(askedIn: asked) }
            token = ""
        }
    }

    /// The Mac of the net joined: each code redeemed gives the device a new token, which
    /// takes the place of the one before (`POST /net/join`).
    actor Bridge {
        private var issued = 0
        /// The token its Macs take now, by net.
        private(set) var valid: [String: String] = [:]

        func join(_ net: String) -> NetJoined {
            issued += 1
            let token = "\(net)-t\(issued)"
            valid[net] = token
            return NetJoined(net: net, token: token, members: [])
        }
    }

    /// Codex's review of the round 4 app fixes: two switches to the same net, both past
    /// their join and waiting on the old Mac, the net's second token taking the place of
    /// the first. The first, its sheet closed, saved its token, which no Mac took any
    /// more, and the second, overtaken, threw the good one away. One switch at a time:
    /// the second redeems its code only once the first has saved what it came to.
    @Test func twoSwitchesAtOnceKeepTheTokenTheNetTakes() async throws {
        let state = Switching()
        let bridge = Bridge()
        let first = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let second = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let switching = Task { try await state.switchTo("new", at: bridge, through: first) }
        await first.arrived("netRemove")
        let again = Task { try await state.switchTo("new", at: bridge, through: second) }
        // Far longer than the second takes to redeem its code and ask the old Mac, should it go on.
        try await Task.sleep(for: .milliseconds(100))
        switching.cancel()
        try await switching.value
        await second.release("netRemove")
        _ = try? await again.value

        #expect(state.membership.net == "new")
        #expect(state.token == (await bridge.valid["new"]))
        await first.release("netRemove")
    }

    final class Flag {
        var isSet = false
    }

    /// Codex's re-check of the round 4 app fixes: a change waiting its turn whose sheet was
    /// closed is dropped at once, with nothing of it run, and the turn goes on; one cancelled
    /// before it asked never runs.
    @Test func aChangeWaitingItsTurnIsDroppedAtOnceWhenCancelled() async throws {
        let changes = NetChanges()
        let holder = Mac(net: "a", id: "mini", holding: ["netList"])
        let first = Task { try await changes.run { _ = try await holder.netList() } }
        await holder.arrived("netList")
        let ran = Flag(), released = Flag()
        let waiting = Task { try await changes.run { ran.isSet = true } }
        try await Task.sleep(for: .milliseconds(20))
        waiting.cancel()
        // Should it wait for the one running after all, that one ends in a while.
        let late = Task {
            try await Task.sleep(for: .seconds(2))
            released.isSet = true
            await holder.release("netList")
        }
        await #expect(throws: CancellationError.self) { try await waiting.value }
        #expect(!released.isSet)
        late.cancel()
        await holder.release("netList")
        try await first.value
        #expect(!ran.isSet)

        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await changes.run { ran.isSet = true }
        }
        await #expect(throws: CancellationError.self) { try await cancelled.value }
        #expect(!ran.isSet)
        // The turn is free after both.
        try await changes.run { ran.isSet = true }
        #expect(ran.isSet)
    }

    /// Codex's re-check of the round 4 app fixes: a pairing whose password sign-in stalled,
    /// its sheet closed (a sign-in does not stop for a cancel), holds up no join after it:
    /// the sign-in comes before the turn is taken, and the abandoned one, once its Mac
    /// answers, redeems nothing.
    @Test func anAbandonedSignInHoldsUpNoLaterChange() async throws {
        let state = Switching()
        let bridge = Bridge()
        let stalled = Mac(net: "other", id: "studio", holding: ["offersNet"])
        let abandoned = Task { try await state.switchTo("other", at: bridge, through: Mac(net: "old", id: "mini"), signingIn: stalled) }
        await stalled.arrived("offersNet")
        abandoned.cancel()
        let released = Flag()
        let late = Task {
            try await Task.sleep(for: .seconds(2))
            released.isSet = true
            await stalled.release("offersNet")
        }
        try await state.switchTo("new", at: bridge, through: Mac(net: "old", id: "mini"))
        #expect(!released.isSet)
        #expect(state.membership.net == "new")
        #expect(state.token == "new-t1")

        late.cancel()
        await stalled.release("offersNet")
        await #expect(throws: CancellationError.self) { try await abandoned.value }
        #expect(await bridge.valid == ["new": "new-t1"])
    }

    /// A switch waiting its turn whose sheet was closed meanwhile redeems no code once the
    /// one before it is done: the net is given no token the device would not keep.
    @Test func aSwitchWaitingItsTurnWhoseSheetClosedRedeemsNothing() async throws {
        let state = Switching()
        let bridge = Bridge()
        let first = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let switching = Task { try await state.switchTo("new", at: bridge, through: first) }
        await first.arrived("netRemove")
        let waiting = Task { try await state.switchTo("other", at: bridge, through: Mac(net: "old", id: "mini")) }
        try await Task.sleep(for: .milliseconds(50))
        waiting.cancel()
        await first.release("netRemove")
        try await switching.value

        await #expect(throws: CancellationError.self) { try await waiting.value }
        #expect(await bridge.valid == ["new": "new-t1"])
        #expect(state.membership.net == "new")
        #expect(state.token == "new-t1")
    }

    /// Bug hunt round 4, APP1: the sheet closed while the old net's Mac was taking the
    /// device out, after the new net had taken it. The switch threw it all away, leaving
    /// the device in no net and listed in the new one. The new net is kept, and the old
    /// one, whose Mac did not answer in time, is kept to be asked again with its token.
    @Test func aSwitchWhoseSheetClosedWhileTheOldMacAnsweredKeepsTheNetItJoined() async throws {
        let state = Switching()
        let old = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let switching = Task { try await state.become(NetJoined(net: "new", token: "new-token", members: []), through: old) }
        await old.arrived("netRemove")
        switching.cancel()
        try await switching.value

        #expect(state.membership.net == "new")
        #expect(state.token == "new-token")
        #expect(state.membership.leftBehind?.map(\.net) == ["old"])
        #expect(state.leftTokens == ["old": "old-token"])
        #expect(state.leaving == nil)
        await old.release("netRemove")
    }

    /// The same with the sheet closed while the old Mac was still asked which net it is in:
    /// no removal goes from here, and the old net is asked again later.
    @Test func aSwitchWhoseSheetClosedWhileTheOldMacListedKeepsTheNetItJoined() async throws {
        let state = Switching()
        let old = Mac(net: "old", id: "mini", holding: ["netList"])
        let switching = Task { try await state.become(NetJoined(net: "new", token: "new-token", members: []), through: old) }
        await old.arrived("netList")
        switching.cancel()
        try await switching.value

        #expect(state.membership.net == "new")
        #expect(state.token == "new-token")
        #expect(state.membership.leftBehind?.map(\.net) == ["old"])
        await old.release("netList")
    }

    /// A Mac of the old net that never answers holds up neither the switch nor the sheet
    /// once it is closed: the wait ends with the cancel, unanswered, and the removal goes on
    /// by itself.
    @Test func aCancelledWaitForTheOldNetsMacEndsUnanswered() async throws {
        let old = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let joined = NetJoined(net: "new", token: "t", members: [])
        let leaving = Task { await NetAttempt.leaveOldNet("old", for: joined, device: "phone", through: old) }
        await old.arrived("netRemove")
        // Should the wait not end with the cancel, the Mac answers in a while, and the
        // removal it made is what comes back.
        let late = Task {
            try await Task.sleep(for: .seconds(2))
            await old.release("netRemove")
        }
        leaving.cancel()
        #expect(await leaving.value == .unanswered)
        late.cancel()
        await old.release("netRemove")
    }

    @Test func aSwitchSuspendedInOldNetCleanupDoesNotOverwriteANewerCompletedSwitch() async throws {
        let state = Switching()
        let slow = Mac(net: "old", id: "mini", holding: ["netList"])
        let first = Task { try await state.become(NetJoined(net: "first", token: "first-token", members: []), through: slow) }
        await slow.arrived("netList")
        // Even if the earlier task ignores its sheet's cancellation, a completed switch
        // has moved on to another generation and must not be undone by that answer.
        let later = Mac(net: "old", id: "studio")
        try await state.become(NetJoined(net: "latest", token: "latest-token", members: []), through: later)
        await slow.release("netList")

        await #expect(throws: NetError.overtaken) { try await first.value }
        #expect(state.membership.net == "latest")
        #expect(state.token == "latest-token")
    }

    @Test func theOldMacTakingTheDeviceOutDuringItsCleanupDoesNotOvertakeTheSwitch() async throws {
        let state = Switching()
        let old = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let switching = Task { try await state.become(NetJoined(net: "new", token: "new-token", members: []), through: old) }
        await old.arrived("netRemove")
        state.removed()
        await old.release("netRemove")
        try await switching.value

        #expect(state.membership.net == "new")
        #expect(state.token == "new-token")
        #expect(state.leaving == nil)
    }

    /// `become` by itself, two at once, the later one asking its old Mac as the earlier
    /// one's answer comes: the earlier one ends without letting go of the later one's
    /// removal, and the later one, overtaken, saves nothing. (`Net` runs no two at once
    /// since `NetChanges`; this pins `become`'s own guards. A closed sheet no longer stops
    /// the earlier one, since round 4's APP1: its new net has the device.)
    @Test func anOlderCleanupDoesNotClearTheNewerCleanupsRemovalOwner() async throws {
        let state = Switching()
        let slow = Mac(net: "old", id: "mini", holding: ["netList"])
        let first = Task { try await state.become(NetJoined(net: "first", token: "first-token", members: []), through: slow) }
        await slow.arrived("netList")
        let later = Mac(net: "old", id: "studio", holding: ["netRemove"])
        let second = Task { try await state.become(NetJoined(net: "latest", token: "latest-token", members: []), through: later) }
        await later.arrived("netRemove")
        let owner = state.leaving?.attempt
        await slow.release("netList")
        try await first.value
        #expect(state.leaving?.attempt === owner)

        await later.release("netRemove")
        await #expect(throws: NetError.overtaken) { try await second.value }
        #expect(state.membership.net == "first")
        #expect(state.token == "first-token")
        #expect(state.leaving == nil)
    }

    @Test func anUnrelatedLeaveIsNotTheCleanupsOwnRemoval() async {
        let state = Switching()
        let old = Mac(net: "old", id: "mini", holding: ["netRemove"])
        let switching = Task { try await state.become(NetJoined(net: "new", token: "new-token", members: []), through: old) }
        await old.arrived("netRemove")
        state.membership.leave()
        await old.release("netRemove")

        await #expect(throws: NetError.overtaken) { try await switching.value }
        #expect(state.membership.net == nil)
        #expect(state.token == "old-token")
    }
}
