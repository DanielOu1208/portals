// Current HostSettingsSheet action/config/invalidation bodies are inserted by the
// runner. Only SwiftUI state and the app Net collaborator are stood in. No sockets,
// preferences, Keychain, installed apps or real net memberships are used.
import AgentCore
import Darwin
import Foundation

enum Platform {
    // As on a Mac or in the simulator, where 127.0.0.1 can be a host: run() goes on to its action.
    static let loopbackIsNeverAHost = false
}

final class Net {
    enum Outcome { case joined, added, known, withoutNet, refused(String) }
    var membership = NetMembership()
    var opened: [PortalsLink] = []
    var switched: [PairingLink] = []
    var outcome = Outcome.added

    func open(_ link: PortalsLink) async throws -> Outcome {
        opened.append(link)
        return outcome
    }

    func switchToNet(of pairing: PairingLink) async throws -> Outcome {
        switched.append(pairing)
        return outcome
    }
}

func withAnimation(_ body: () -> Void) { body() }

final class HostSettingsSheet {
    var host: HostConfig?
    var existing: [HostConfig] = []
    var net: Net?
    var name = ""
    var address = ""
    var username = ""
    var password = ""
    var matched: HostConfig?
    var pairing: PairingLink?
    var joinLink: JoinLink?
    var isWorking = false
    var netProblem: String?
    var macRefused: String?
    var netWork: Task<Void, Never>?
    var trial = ConnectionTrial()
    var stoppedTrials = 0
    var saved: [(HostConfig, String)] = []
    var dismissals = 0

    init(_ pairing: PairingLink, net: Net? = Net()) {
        self.pairing = pairing
        self.net = net
        name = pairing.name ?? HostConfig.suggestedName(for: pairing.url)
        address = pairing.url.absoluteString
        username = pairing.username
        password = pairing.password
    }

    func dismiss() { dismissals += 1 }
    func stopTrial() { stoppedTrials += 1 }
    func save() {
        guard let config else { return }
        saved.append((config, password))
        dismiss()
    }

    func invalidateFields() {
        /* PRODUCTION_INVALIDATION */
    }

    /* PRODUCTION_ACTIONS */
}

extension HostSettingsSheet {
    static func verify() async -> Int32 {
        var failures = 0
        func check(_ condition: Bool, _ description: String) {
            print("\(condition ? "PASS" : "FAIL") \(description)")
            if !condition { failures += 1 }
        }
        let original = PairingLink(
            url: URL(string: "https://first.invalid:10010")!, username: "first-user",
            password: "synthetic-first", name: "First"
        )
        let edited = PairingLink(
            url: URL(string: "https://other-net.invalid:10011")!, username: "edited-user",
            password: " synthetic-edited ", name: "Edited"
        )
        func editedSheet(net: Net? = Net()) -> HostSettingsSheet {
            let sheet = HostSettingsSheet(original, net: net)
            sheet.address = edited.url.absoluteString
            sheet.name = "  Edited  "
            sheet.username = "  edited-user  "
            sheet.password = edited.password
            return sheet
        }

        let add = editedSheet()
        add.addFromCode()
        await add.netWork?.value
        check(add.net?.opened == [.pair(edited)], "Add forwards the tested address, normalized user/name and exact password")
        check(add.dismissals == 1 && add.saved.isEmpty, "successful net Add closes without a second local save")

        let switching = editedSheet()
        switching.switchNet()
        await switching.netWork?.value
        check(switching.net?.switched == [edited], "Switch forwards the current pairing fields")

        var known = HostConfig(name: "First", url: original.url)
        known.netMember = "first-mac"
        let knownToOther = editedSheet()
        knownToOther.existing = [known]
        knownToOther.net?.membership = NetMembership(net: "current-net", members: [
            NetMember(id: "first-mac", kind: .mac, name: "First", url: original.url),
        ])
        check(knownToOther.decision == .addMac(edited), "editing a known address to another net's host offers Add, not Done")

        let otherToKnown = editedSheet()
        otherToKnown.address = original.url.absoluteString
        otherToKnown.pairing = edited
        otherToKnown.existing = [known]
        otherToKnown.net?.membership = NetMembership(net: "current-net")
        check(otherToKnown.decision == .known(known.id), "editing another net's address to a known host offers Done")

        let noMembership = editedSheet()
        check(noMembership.decision == .pairIntoNet(edited), "a device without a net pairs using current form values")

        let unchanged = HostSettingsSheet(original)
        unchanged.addFromCode()
        await unchanged.netWork?.value
        check(unchanged.net?.opened == [.pair(original)], "an unedited pairing retains its original values")

        let withoutNet = editedSheet(net: nil)
        withoutNet.addFromCode()
        check(withoutNet.saved.first?.0.url == edited.url && withoutNet.saved.first?.1 == edited.password,
              "no-net fallback saves the edited host and password")

        let oldBridge = editedSheet()
        oldBridge.net?.outcome = .withoutNet
        oldBridge.addFromCode()
        await oldBridge.netWork?.value
        check(oldBridge.saved.first?.0.username == edited.username && oldBridge.saved.first?.1 == edited.password,
              "a bridge without net support keeps local edited-field saving")

        let join = JoinLink(url: URL(string: "https://join.invalid")!, code: "synthetic-code", name: "Join")
        let joining = editedSheet()
        joining.joinLink = join
        joining.switchNet()
        await joining.netWork?.value
        check(joining.net?.opened == [.join(join)] && joining.net?.switched.isEmpty == true,
              "join-link switching ignores hidden pairing fields")
        check(joining.decision == .join(join), "join-link decisions remain based on the join link")

        let invalidation = editedSheet()
        invalidation.netProblem = "Old connection failed"
        invalidation.macRefused = "Old host refused"
        _ = invalidation.trial.begin(cancelled: false)
        invalidation.invalidateFields()
        check(invalidation.netProblem == nil && invalidation.macRefused == nil,
              "editing connection fields clears refusal/errors for the old host")
        check(invalidation.stoppedTrials == 1 && invalidation.trial.phase == .none,
              "editing connection fields still cancels and resets Test connection")

        let manual = editedSheet()
        manual.pairing = nil
        manual.addFromCode()
        check(manual.saved.count == 1 && manual.net?.opened.isEmpty == true,
              "a manually entered host still follows local Save")

        let invalid = editedSheet()
        invalid.address = ""
        invalid.addFromCode()
        invalid.switchNet()
        await invalid.netWork?.value
        check(invalid.net?.opened.isEmpty == true && invalid.net?.switched.isEmpty == true && invalid.saved.isEmpty,
              "an invalid edited address never sends the original pairing")
        check(invalid.decision == nil, "an invalid edited address has no net decision")

        let unnamed = editedSheet()
        unnamed.name = " "
        unnamed.username = " "
        unnamed.addFromCode()
        await unnamed.netWork?.value
        let unnamedPair = PairingLink(url: edited.url, username: "", password: edited.password, name: "other-net")
        check(unnamed.net?.opened == [.pair(unnamedPair)],
              "blank user and name match the validated Test connection config")
        return failures == 0 ? 0 : 1
    }
}

@main struct NativePairingTests {
    static func main() async { exit(await HostSettingsSheet.verify()) }
}
