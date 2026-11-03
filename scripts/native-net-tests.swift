import Foundation
import AgentCore
import os

enum AppLog {
    static let chat = Logger(subsystem: "PortalsNetTests", category: "net")
}
enum Platform {
    static let thisDevice = "this device"
}
@MainActor final class Credentials {
    var token: String? = "old-token"
    var leftTokens: [String: String] = [:]
    func netToken() -> String? { token }
    func setNetToken(_ token: String?) { self.token = token }
    func setLeftNetToken(_ token: String?, for net: String) { leftTokens[net] = token }
}
struct Host {
    var isNetHost = true
    var netMember: String? = "mini"
    var name = "Test Mac"
}
@MainActor final class HostModel {
    let id = HostID(rawValue: UUID().uuidString)
    let host = Host()
    let netHost: (any NetReporting)?
    init(_ mac: any NetReporting) { netHost = mac }
}
@MainActor final class Fleet {
    var hosts: [HostModel] = []
    func netChanged(_ members: [NetMember]) {}
    func netLeft() { hosts = [] }
}
@MainActor final class Net {
    // APP_OUTCOME
    var membership = NetMembership(deviceID: "phone", net: "old")
    var credentials = Credentials()
    var fleet: Fleet? = Fleet()
    var refusedBy: [HostID: String?] = [:]
    var hasListed = false
    var leavingOnPurpose: (net: String?, attempt: NetAttempt)?
    var leavesInFlight = 0
    var connectedNetHosts: [HostModel] = []
    var notice: String?
    var isInNet: Bool { membership.isInNet }
    init(_ mac: any NetReporting) { use(mac) }
    func use(_ mac: any NetReporting) {
        connectedNetHosts = [HostModel(mac)]
        fleet?.hosts = connectedNetHosts
    }
    var askedLeftBehind = 0
    func save() {}
    func askLeftBehind() { askedLeftBehind += 1 }
    func list(from host: HostModel) { preconditionFailure("No listing expected") }
    func leftHere() { leaveHere(saying: nil) }
    func removed() {
        // The same news a backend whose token was refused gives Net: said, then
        // leaveIfEveryMacRefuses, then leaveHere. Never a direct membership.leave.
        said(.refused("This device was removed from the net."), by: connectedNetHosts[0])
    }
    func switchTo(_ name: String) async throws {
        // Redemption already succeeded, as it has when the app calls become.
        let attempt = NetAttempt(generation: membership.generation) { self.membership.generation }
        try await become(NetJoined(net: name, token: "\(name)-token", members: []), attempt)
    }
    // APP_METHODS
}
@MainActor func withAnimation(_ body: () -> Void) { body() }
@MainActor final class Sheet {
    let net: Net?
    var isWorking = false
    var netProblem: String?
    var netWork: Task<Void, Never>?
    var macRefused: String?
    var didDismiss = false
    init(_ net: Net) { self.net = net }
    func save() { preconditionFailure("No host saved by itself") }
    func dismiss() { didDismiss = true }
    func start(_ name: String) {
        run { net in
            try await net.switchTo(name)
            return .joined
        }
    }
    // SHEET_RUN
}
actor Mac: NetReporting {
    nonisolated let netNews = AsyncStream<NetNews> { _ in }
    var offersNet: Bool? { true }
    var held: String?
    let cancellable: Bool
    let failing: Bool
    let net: String
    var waiting: [CheckedContinuation<Void, Never>] = []
    var arrival: CheckedContinuation<Void, Never>?
    init(_ held: String? = nil, net: String = "old", cancellable: Bool = false, failing: Bool = false) {
        self.held = held
        self.net = net
        self.cancellable = cancellable
        self.failing = failing
    }
    func arrived() async {
        if !waiting.isEmpty { return }
        await withCheckedContinuation { arrival = $0 }
    }
    func release() {
        held = nil
        let due = waiting
        waiting = []
        for continuation in due { continuation.resume() }
    }
    func pause(_ name: String) async {
        guard held == name else { return }
        await withCheckedContinuation {
            waiting.append($0)
            arrival?.resume()
            arrival = nil
        }
    }
    func netList() async throws -> NetList {
        await pause("netList")
        if cancellable { try Task.checkCancellation() }
        if failing { throw URLError(.timedOut) }
        return NetList(net: net, here: "mini", revision: 1, members: [])
    }
    func netRemove(_ id: String, inNet net: String?) async throws -> NetList {
        await pause("netRemove")
        return NetList(net: self.net, here: "mini", revision: 2, members: [])
    }
    func netInvite() async throws -> NetInvite { preconditionFailure("No invite expected") }
    func netJoin(with: String) async throws -> NetList { preconditionFailure("No join expected") }
}
@main struct Regression {
    @MainActor static func main() async throws {
        do {
            let mac = Mac("netList", cancellable: true), net = Net(Mac())
            net.use(mac)
            let work = Task { try await net.switchTo("cancelled") }
            await mac.arrived()
            work.cancel()
            await mac.release()
            try await work.value
            precondition(net.membership.net == "cancelled" && net.credentials.token == "cancelled-token")
            print("PASS: cancellation during cleanup keeps the already-joined net and its token")
        }
        for cancel in [false, true] {
            let mac = Mac("netList"), net = Net(Mac())
            net.use(mac)
            let first = Task { try await net.switchTo("first") }
            await mac.arrived()
            if cancel {
                first.cancel()
                // Cancellation finishes an already-successful join. The app's NetChanges
                // lets the next redemption start only after that completion.
                try await first.value
            }
            net.use(Mac(net: cancel ? "first" : "old"))
            try await net.switchTo("latest")
            await mac.release()
            if !cancel {
                do { try await first.value; preconditionFailure("Old switch committed") }
                catch NetError.overtaken {}
            }
            precondition(net.membership.net == "latest" && net.credentials.token == "latest-token")
            print("PASS: newer completed switch wins, cancelled=\(cancel)")
        }
        do {
            let mac = Mac("netRemove"), net = Net(Mac())
            net.use(mac)
            let work = Task { try await net.switchTo("new") }
            await mac.arrived()
            net.removed()
            await mac.release()
            try await work.value
            precondition(net.membership.net == "new" && net.credentials.token == "new-token")
            precondition(net.notice == nil)
            print("PASS: owned old-net removal notification still permits switch")
        }
        do {
            let slow = Mac("netList"), later = Mac("netRemove", net: "first"), net = Net(Mac())
            net.use(slow)
            let first = Task { try await net.switchTo("first") }
            await slow.arrived()
            first.cancel()
            try await first.value
            net.use(later)
            let second = Task { try await net.switchTo("latest") }
            await later.arrived()
            let owner = net.leavingOnPurpose?.attempt
            await slow.release()
            precondition(net.leavingOnPurpose?.attempt === owner)
            net.removed()
            await later.release()
            try await second.value
            precondition(net.membership.net == "latest" && net.credentials.token == "latest-token")
            print("PASS: old cancelled cleanup preserves newer cleanup owner")
        }
        do {
            // Leave is already waiting when a join-link sheet starts a switch.
            let mac = Mac("netRemove"), net = Net(mac)
            let leaving = Task { await net.leave() }
            await mac.arrived()
            var finished = false
            let switching = Task {
                defer { finished = true }
                try await net.switchTo("new")
            }
            while !finished && net.leavingOnPurpose == nil { await Task.yield() }
            net.removed()
            await mac.release()
            await leaving.value
            do { try await switching.value; preconditionFailure("Leave's notification credited to switch") } catch NetError.overtaken {}
            precondition(net.membership.net == nil && net.credentials.token == nil)
            precondition(net.notice != nil && net.leavingOnPurpose == nil)
            print("PASS: pending explicit Leave's removal notification is not a switch's")
        }
        do {
            // A switch is cleaning up when an explicit Leave starts. Its pending RPC
            // must prevent the switch from committing even before any notice arrives.
            let slow = Mac("netList"), later = Mac("netRemove"), net = Net(slow)
            let switching = Task { try await net.switchTo("new") }
            await slow.arrived()
            net.use(later)
            let leaving = Task { await net.leave() }
            await later.arrived()
            await slow.release()
            do { try await switching.value; preconditionFailure("Switch committed during explicit Leave") } catch NetError.overtaken {}
            net.removed()
            await later.release()
            await leaving.value
            precondition(net.membership.net == nil && net.credentials.token == nil)
            print("PASS: explicit Leave invalidates a switch already cleaning up")
        }
        do {
            // The real sheet's run method must finish a rejected switch as an ordinary
            // failure, and the same sheet can join again after Leave finishes.
            let mac = Mac("netRemove"), net = Net(mac)
            let sheet = Sheet(net)
            let leaving = Task { await net.leave() }
            await mac.arrived()
            sheet.start("rejected")
            await sheet.netWork?.value
            precondition(!sheet.isWorking && !sheet.didDismiss)
            precondition(sheet.netProblem == NetError.overtaken.localizedDescription)
            precondition(net.membership.net == "old" && net.credentials.token == "old-token")
            net.removed()
            await mac.release()
            await leaving.value
            precondition(net.membership.net == nil && net.credentials.token == nil)
            net.use(Mac())
            sheet.start("again")
            await sheet.netWork?.value
            precondition(!sheet.isWorking && sheet.didDismiss && sheet.netProblem == nil)
            precondition(net.membership.net == "again" && net.credentials.token == "again-token")
            print("PASS: rejected switch ends the sheet's spinner with an error, saves nothing, and rejoin succeeds")
        }
        do {
            let mac = Mac("netRemove"), net = Net(mac)
            let work = Task { try await net.switchTo("new") }
            await mac.arrived()
            net.leftHere()
            await mac.release()
            do { try await work.value; preconditionFailure("Explicit local leave overwritten") } catch NetError.overtaken {}
            precondition(net.membership.net == nil && net.credentials.token == nil)
            print("PASS: unrelated generation change overtakes cleanup")
        }
        let oldMac = NetMember(id: "mini", kind: .mac, name: "mini", url: URL(string: "http://mini.local:9120"))
        do {
            // No Mac of the old net answered the switch: the old net is kept, with its
            // token, to be asked again (net-17's leftover).
            let net = Net(Mac(failing: true))
            net.membership = NetMembership(deviceID: "phone", net: "old", members: [oldMac])
            try await net.switchTo("new")
            precondition(net.membership.net == "new" && net.credentials.token == "new-token")
            precondition(net.membership.leftBehind?.map(\.net) == ["old"] && net.credentials.leftTokens["old"] == "old-token")
            precondition(net.askedLeftBehind > 0)
            print("PASS: a switch no Mac of the old net answered keeps that net and its token to ask again")
        }
        do {
            // The join already worked: cancelling its old-net cleanup keeps the new token
            // and the old net to ask again.
            let mac = Mac("netList", failing: true), net = Net(mac)
            net.membership = NetMembership(deviceID: "phone", net: "old", members: [oldMac])
            let work = Task { try await net.switchTo("new") }
            await mac.arrived()
            work.cancel()
            await mac.release()
            try await work.value
            precondition(net.membership.net == "new" && net.credentials.token == "new-token")
            precondition(net.membership.leftBehind?.map(\.net) == ["old"] && net.credentials.leftTokens["old"] == "old-token")
            print("PASS: a cancelled cleanup keeps the joined token and the unanswered old net to ask again")
        }
        do {
            // Overtaken by an explicit Leave while its old Mac did not answer: nothing kept.
            let slow = Mac("netList", failing: true), later = Mac("netRemove"), net = Net(slow)
            net.membership = NetMembership(deviceID: "phone", net: "old", members: [oldMac])
            let switching = Task { try await net.switchTo("new") }
            await slow.arrived()
            net.use(later)
            let leaving = Task { await net.leave() }
            await later.arrived()
            await slow.release()
            do { try await switching.value; preconditionFailure("Switch committed during explicit Leave") } catch NetError.overtaken {}
            net.removed()
            await later.release()
            await leaving.value
            precondition(net.membership.net == nil && net.membership.leftBehind == nil && net.credentials.leftTokens.isEmpty)
            print("PASS: a switch an explicit Leave overtakes keeps no net left behind")
        }
        do {
            // Joining again a net left behind lets go of it and its token.
            let net = Net(Mac())
            net.membership = NetMembership(deviceID: "phone", net: "old", members: [oldMac])
            net.membership.keep(NetLeftBehind(net: "new", macs: [.init(id: "studio", url: URL(string: "http://studio.local:9120")!)]))
            net.credentials.setLeftNetToken("new-old-token", for: "new")
            try await net.switchTo("new")
            precondition(net.membership.net == "new" && net.membership.leftBehind == nil && net.credentials.leftTokens.isEmpty)
            print("PASS: a net left behind and joined again is let go of")
        }
    }
}
