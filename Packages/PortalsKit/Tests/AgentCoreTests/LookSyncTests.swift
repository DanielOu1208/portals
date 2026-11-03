import AgentCore
import Foundation
import Testing

/// How an agent looks on a host that keeps looks for every device (`LookStep`): what a
/// device does about one agent's look once it knows the host's, and what it keeps of it.
@Suite struct LookSyncTests {
    private let mine = AgentLook(shape: 1, face: 2, tint: 3)
    private let theirs = AgentLook(shape: 5, face: 0, tint: 8, showsLogo: false)

    private func step(_ held: HeldLook?, _ host: HostLook?) -> LookStep? {
        LookStep.step(held: held, host: host)
    }

    @Test func aNewDeviceDrawsAnAgentAsTheHostHasIt() {
        #expect(step(nil, HostLook(theirs, origin: .assigned)) == .take(HostLook(theirs, origin: .assigned)))
        #expect(step(nil, HostLook(theirs, origin: .chosen)) == .take(HostLook(theirs, origin: .chosen)))
        // An agent neither has a look for: the app gives it one first.
        #expect(step(nil, nil) == nil)
    }

    @Test func theHostsLookIsTakenInPlaceOfOneTheAppGaveHere() {
        let host = HostLook(theirs, origin: .assigned)
        #expect(step(HeldLook(mine, origin: .assigned), host) == .take(host))
        #expect(step(HeldLook(mine, origin: .assigned, state: .kept), host) == .take(host))
        // Also one somebody chose on another device.
        let chosen = HostLook(theirs, origin: .chosen)
        #expect(step(HeldLook(mine, origin: .assigned), chosen) == .take(chosen))
        #expect(step(HeldLook(mine, origin: .chosen, state: .kept), chosen) == .take(chosen))
    }

    @Test func aLookTheHostHasNoneForIsSentForAnAgentThatStillHasNone() {
        #expect(step(HeldLook(mine, origin: .assigned), nil) == .send(HostLook(mine, origin: .assigned), unless: .any))
        #expect(step(HeldLook(mine, origin: .chosen), nil) == .send(HostLook(mine, origin: .chosen), unless: .any))
        // A host that lost its looks gets back the one it had.
        #expect(step(HeldLook(mine, origin: .assigned, state: .kept), nil) == .send(HostLook(mine, origin: .assigned), unless: .any))
        // A look from before origins were kept may have been chosen, and is sent as one.
        #expect(step(HeldLook(mine), nil) == .send(HostLook(mine, origin: .chosen), unless: .any))
    }

    @Test func aLookChosenHereReplacesWhateverTheHostHas() {
        let sent = LookStep.send(HostLook(mine, origin: .chosen), unless: nil)
        #expect(step(HeldLook(mine, origin: .chosen, state: .pending), HostLook(theirs, origin: .chosen)) == sent)
        #expect(step(HeldLook(mine, origin: .chosen, state: .pending), HostLook(theirs, origin: .assigned)) == sent)
        #expect(step(HeldLook(mine, origin: .chosen, state: .pending), nil) == sent)
        // Also when the host has the same look already: it says so, and the look is kept.
        #expect(step(HeldLook(mine, origin: .chosen, state: .pending), HostLook(mine, origin: .chosen)) == sent)
    }

    @Test func aChoiceMadeBeforeTheHostKeptLooksBeatsOnlyALookAnAppGave() {
        // The host has a look another device's app gave: the choice goes up, and stays
        // down should another device's choice get there first.
        #expect(step(HeldLook(mine, origin: .chosen), HostLook(theirs, origin: .assigned)) == .send(HostLook(mine, origin: .chosen), unless: .chosen))
        #expect(step(HeldLook(mine), HostLook(theirs, origin: .assigned)) == .send(HostLook(mine, origin: .chosen), unless: .chosen))
        // The host has a choice already: that one is everyone's.
        #expect(step(HeldLook(mine, origin: .chosen), HostLook(theirs, origin: .chosen)) == .take(HostLook(theirs, origin: .chosen)))
        // Once the look has been the host's, a later look an app gave there is not overruled by it.
        #expect(step(HeldLook(mine, origin: .chosen, state: .kept), HostLook(theirs, origin: .assigned)) == .take(HostLook(theirs, origin: .assigned)))
        // The same look on both sides: only who decided it is taken.
        #expect(step(HeldLook(mine, origin: .chosen), HostLook(mine, origin: .assigned)) == .take(HostLook(mine, origin: .assigned)))
    }

    @Test func aLookTheHostAndTheDeviceAgreeOnNeedsNothing() {
        #expect(step(HeldLook(mine, origin: .assigned, state: .kept), HostLook(mine, origin: .assigned)) == nil)
        #expect(step(HeldLook(theirs, origin: .chosen, state: .kept), HostLook(theirs, origin: .chosen)) == nil)
        // The same look, not yet known to be the host's: taken once, to be kept as such.
        #expect(step(HeldLook(mine, origin: .assigned), HostLook(mine, origin: .assigned)) == .take(HostLook(mine, origin: .assigned)))
        // Whether the logo shows is part of the look.
        let shown = AgentLook(shape: 5, face: 0, tint: 8)
        #expect(step(HeldLook(shown, origin: .chosen, state: .kept), HostLook(theirs, origin: .chosen)) == .take(HostLook(theirs, origin: .chosen)))
    }

    @Test func aLookChosenWhileTheHostHasNotSaidWhetherItKeepsLooksIsSentNotLost() {
        // Chosen while the app connects, the host has an older choice of another device's.
        let state = LookSyncState.chosen(hostKeepsLooks: nil)
        #expect(state == .pending)
        #expect(step(HeldLook(mine, origin: .chosen, state: state), HostLook(theirs, origin: .chosen)) == .send(HostLook(mine, origin: .chosen), unless: nil))
        #expect(LookSyncState.chosen(hostKeepsLooks: true) == .pending)
        // A host that keeps none: the look is the device's own.
        #expect(LookSyncState.chosen(hostKeepsLooks: false) == nil)
    }

    @Test func anAnswerToALookSentBeforeAChoiceHereDoesNotSettleTheChoice() {
        let given = HostLook(mine, origin: .assigned)
        // Chosen while the look an app gave was on its way, even the same one: sent next.
        #expect(!LookStep.answerSettles(HeldLook(mine, origin: .chosen, state: .pending), sent: given, unless: .any))
        #expect(!LookStep.answerSettles(HeldLook(theirs, origin: .chosen, state: .pending), sent: given, unless: .any))
        #expect(!LookStep.answerSettles(HeldLook(theirs, origin: .chosen, state: .pending), sent: HostLook(mine, origin: .chosen), unless: nil))
        // Also while an old choice went only where the host had none of its own.
        #expect(!LookStep.answerSettles(HeldLook(mine, origin: .chosen, state: .pending), sent: HostLook(mine, origin: .chosen), unless: .chosen))
        // The answer to the choice itself, or with nothing chosen since, settles it.
        #expect(LookStep.answerSettles(HeldLook(mine, origin: .chosen, state: .pending), sent: HostLook(mine, origin: .chosen), unless: nil))
        #expect(LookStep.answerSettles(HeldLook(mine, origin: .assigned), sent: given, unless: .any))
        #expect(LookStep.answerSettles(nil, sent: given, unless: .any))
    }

    /// Two devices meet over a host: each step's send is answered as the bridge answers
    /// it (bridge/src/looks.ts, `Looks.set`), and both end on the same look.
    @Test func twoDevicesEndOnTheSameLook() {
        var host: HostLook?
        func answer(_ sent: HostLook, unless: LookCondition?) -> HostLook {
            let kept = host.map { held in unless == .any || (held.origin == .chosen && (unless == .chosen || sent.origin == .assigned)) } ?? false
            if !kept { host = sent }
            return host!
        }
        func sync(_ held: inout HeldLook?) {
            switch LookStep.step(held: held, host: host) {
            case let .take(look)?: held = HeldLook(look.look, origin: look.origin, state: .kept)
            case let .send(look, unless)?:
                let now = answer(look, unless: unless)
                held = HeldLook(now.look, origin: now.origin, state: .kept)
            case nil: break
            }
        }

        // The phone's app gave the agent a look; on the Mac it was chosen by hand long ago.
        var phone: HeldLook? = HeldLook(theirs, origin: .assigned)
        var mac: HeldLook? = HeldLook(mine, origin: .chosen)
        sync(&phone)
        #expect(host == HostLook(theirs, origin: .assigned))
        sync(&mac)
        #expect(host == HostLook(mine, origin: .chosen))
        sync(&phone)
        #expect(phone == HeldLook(mine, origin: .chosen, state: .kept))
        #expect(mac == phone)

        // On the phone another is chosen: the Mac takes it at its next step.
        let third = AgentLook(shape: 7, face: 4, tint: 10)
        phone = HeldLook(third, origin: .chosen, state: .pending)
        sync(&phone)
        sync(&mac)
        #expect(mac == HeldLook(third, origin: .chosen, state: .kept))
        #expect(mac == phone)
        // Nothing more to do on either.
        #expect(LookStep.step(held: mac, host: host) == nil)
        #expect(LookStep.step(held: phone, host: host) == nil)
    }

    // MARK: What a device keeps

    private final class Scratch {
        let store: ThreadStore

        init() {
            store = ThreadStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("portals-tests-\(UUID().uuidString)"))
        }

        deinit {
            try? FileManager.default.removeItem(at: store.directory)
        }

        func write(_ text: String, to file: String) throws {
            try FileManager.default.createDirectory(at: store.directory, withIntermediateDirectories: true)
            try Data(text.utf8).write(to: store.directory.appendingPathComponent(file))
        }
    }

    @Test func whereALookStandsIsSavedWithItAndOldFilesHaveNone() throws {
        let scratch = Scratch()
        let mac = HostID(rawValue: "mac"), mini = HostID(rawValue: "mini")
        let claude = Agent.ID(host: mac, name: "claude"), codex = Agent.ID(host: mac, name: "codex"), karina = Agent.ID(host: mini, name: "karina")
        try scratch.write(#"[{"agent":{"host":"mac","name":"claude"},"look":{"face":2,"shape":1,"tint":3},"origin":"chosen"}]"#, to: "looks.json")
        #expect(scratch.store.loadLooks() == [claude: mine])
        #expect(scratch.store.loadLookStates().isEmpty)

        let looks = [claude: mine, codex: theirs, karina: AgentLook(shape: 0, face: 1, tint: 6)]
        scratch.store.saveLooks(looks, origins: [claude: .chosen, codex: .assigned], states: [claude: .pending, codex: .kept, karina: .kept])
        #expect(scratch.store.loadLooks() == looks)
        #expect(scratch.store.loadLookOrigins() == [claude: .chosen, codex: .assigned])
        #expect(scratch.store.loadLookStates() == [claude: .pending, codex: .kept, karina: .kept])

        // Forgetting a host keeps where the others' looks stand.
        scratch.store.forgetHost(mini)
        #expect(scratch.store.loadLookStates() == [claude: .pending, codex: .kept])
        #expect(scratch.store.loadLookOrigins() == [claude: .chosen, codex: .assigned])
    }

    @Test func aStateThisVersionCannotReadCostsOnlyItself() throws {
        let scratch = Scratch()
        try scratch.write(
            #"[{"agent":{"host":"mac","name":"claude"},"look":{"face":2,"shape":1,"tint":3},"origin":"chosen","sync":"elsewhere"},"#
                + #"{"agent":{"host":"mac","name":"codex"},"look":{"face":0,"shape":5,"tint":8},"sync":"kept"}]"#,
            to: "looks.json"
        )
        let mac = HostID(rawValue: "mac")
        #expect(scratch.store.loadLooks().count == 2)
        #expect(scratch.store.loadLookStates() == [Agent.ID(host: mac, name: "codex"): .kept])
        #expect(scratch.store.loadLookOrigins() == [Agent.ID(host: mac, name: "claude"): .chosen])
    }
}
