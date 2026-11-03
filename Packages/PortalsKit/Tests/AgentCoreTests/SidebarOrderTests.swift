import Foundation
import Testing
@testable import AgentCore

private let local = HostID(rawValue: "local")
private let mini = HostID(rawValue: "mini")
private let t0 = Date(timeIntervalSince1970: 1_791_000_000)

private func agent(_ name: String, on host: HostID = local) -> Agent {
    Agent(id: Agent.ID(host: host, name: name))
}

private func coding(_ id: String, _ agent: String, in folder: String?, updated: TimeInterval, pinned: Bool = false) -> ThreadRecord {
    ThreadRecord(
        ref: ThreadRef(id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: local, name: agent), createdAt: t0, workingDirectory: folder),
        updatedAt: t0.addingTimeInterval(updated),
        pinned: pinned
    )
}

/// The order the user gave a host's agents and folders in the sidebar (`SidebarOrder`):
/// how the rows are arranged by it, how one is moved, and what a device holds of the
/// order of a host that keeps it for every device.
@Suite struct SidebarOrderTests {
    // MARK: Arranging

    @Test func agentsTheUserPlacedComeInThatOrderAndTheOthersAfterAsTheHostListsThem() {
        let listed = [agent("claude"), agent("codex"), agent("pi"), agent("cursor")]
        #expect(SidebarOrder().arranged(listed) == listed)
        let order = SidebarOrder(agents: ["pi", "gone", "claude"])
        // An agent the host no longer lists has no row; the two not placed keep the host's order.
        #expect(order.arranged(listed).map(\.id.name) == ["pi", "claude", "codex", "cursor"])
        #expect(order.arranged([]).isEmpty)
    }

    @Test func foldersTheUserPlacedComeInThatOrderAfterAnyNewOneWhichStaysByLastUse() {
        let byLastUse = ["/w/new", "/w/app", "/w/notes", "/w/newer", "/w/site"]
        // No order: by last use, as before folders could be arranged.
        #expect(SidebarOrder(agents: ["codex"]).arranged(byLastUse, path: \.self) == byLastUse)
        let order = SidebarOrder(folders: ["/w/site", "/w/gone", "/w/app", "/w/notes"])
        #expect(order.arranged(byLastUse, path: \.self) == ["/w/new", "/w/newer", "/w/site", "/w/app", "/w/notes"])
    }

    @Test func aNameListedTwiceHasTheFirstPlace() {
        let order = SidebarOrder(agents: ["codex", "claude", "codex"])
        #expect(order.arranged([agent("claude"), agent("codex")]).map(\.id.name) == ["codex", "claude"])
    }

    // MARK: Moving

    @Test func aRowIsPutJustBeforeAnotherOrLast() {
        let rows = ["a", "b", "c", "d"]
        #expect(SidebarOrder.moving("d", before: "b", in: rows) == ["a", "d", "b", "c"])
        #expect(SidebarOrder.moving("a", before: "d", in: rows) == ["b", "c", "a", "d"])
        #expect(SidebarOrder.moving("b", before: nil, in: rows) == ["a", "c", "d", "b"])
        #expect(SidebarOrder.moving("c", before: "a", in: rows) == ["c", "a", "b", "d"])
        // Before the one already after it: nothing moves.
        #expect(SidebarOrder.moving("b", before: "c", in: rows) == rows)
        // Its own target, a row that is not listed, a target that is not: as said.
        #expect(SidebarOrder.moving("b", before: "b", in: rows) == rows)
        #expect(SidebarOrder.moving("x", before: "a", in: rows) == rows)
        #expect(SidebarOrder.moving("a", before: "x", in: rows) == ["b", "c", "d", "a"])
    }

    @Test func aRowsMenuMovesItOnePlaceOrToAnEndAndOffersNoMoveThatDoesNothing() {
        let rows = ["a", "b", "c", "d"]
        func made(_ move: SidebarMove, _ row: String) -> [String]? {
            move.step(of: row, among: rows).map { SidebarOrder.moving($0.moved, before: $0.before, in: rows) }
        }
        #expect(made(.up, "c") == ["a", "c", "b", "d"])
        #expect(made(.down, "b") == ["a", "c", "b", "d"])
        #expect(made(.top, "d") == ["d", "a", "b", "c"])
        #expect(made(.bottom, "a") == ["b", "c", "d", "a"])
        // At an end there is nothing that way, and one place from it up or down does it.
        #expect(made(.up, "a") == nil && made(.top, "a") == nil && made(.top, "b") == nil)
        #expect(made(.down, "d") == nil && made(.bottom, "d") == nil && made(.bottom, "c") == nil)
        #expect(made(.up, "b") == ["b", "a", "c", "d"] && made(.down, "c") == ["a", "b", "d", "c"])
        // A row that is not listed, and one listed alone.
        #expect(made(.up, "x") == nil)
        #expect(SidebarMove.allCases.allSatisfy { $0.step(of: "a", among: ["a"]) == nil })
    }

    // MARK: The sidebar

    private let hosts = [
        HostConfig(id: mini, name: "Mini", url: URL(string: "https://mini.example")!),
        HostConfig(id: local, name: "MacBook", url: URL(string: "http://127.0.0.1:9120")!, kind: .bridge, generalFolder: "/Users/dev/Portals"),
    ]

    @Test func theSidebarListsBotsAndFoldersInTheUsersOrderAndThreadsAsBefore() {
        let agents = [agent("claude"), agent("codex"), agent("pi"), agent("hanni", on: mini), agent("karina", on: mini)]
        let app = "/Users/dev/app", notes = "/Users/dev/notes", site = "/Users/dev/site"
        let threads = [
            coding("s1", "claude", in: site, updated: 90),
            coding("a1", "claude", in: app, updated: 80),
            coding("a2", "codex", in: app, updated: 70, pinned: true),
            coding("n1", "codex", in: notes, updated: 60),
            coding("g1", "pi", in: "/Users/dev/Portals", updated: 50),
        ]
        func layout(_ order: [HostID: SidebarOrder]) -> SidebarLayout {
            SidebarLayout.build(hosts: hosts, agents: agents, threads: threads, waiting: [], running: [], withFolders: [local], order: order)
        }

        // With no order: bots as each host lists them, folders where they stay (when each
        // was first seen, here all at once: by their paths).
        let plain = layout([:])
        #expect(plain.spaces[0].bots.map(\.agent.id.name) == ["hanni", "karina"])
        #expect(plain.spaces[1].folders.map(\.name) == ["app", "notes", "site", "No project"])

        let arranged = layout([local: SidebarOrder(agents: ["pi", "claude"], folders: [notes, "/Users/dev/Portals", app])])
        // The mini's bots are not this order's.
        #expect(arranged.spaces[0].bots.map(\.agent.id.name) == ["hanni", "karina"])
        // The folders as placed, the one that was not placed after them; No project at
        // the foot, wherever the order put it.
        #expect(arranged.spaces[1].folders.map(\.name) == ["notes", "app", "site", "No project"])
        // Threads are never arranged: a pinned one first, then the others.
        #expect(arranged.spaces[1].folders[1].threads.map(\.id.rawValue) == ["a2", "a1"])
        #expect(arranged.top.waiting.isEmpty && arranged.top.running.isEmpty)

        // An order for another host changes nothing here.
        #expect(layout([mini: SidebarOrder(agents: ["karina"], folders: [notes])]).spaces[1] == plain.spaces[1])
        #expect(layout([mini: SidebarOrder(agents: ["karina"])]).spaces[0].bots.map(\.agent.id.name) == ["karina", "hanni"])
    }

    // MARK: What a device holds

    private let first = SidebarOrderRevision(id: "4be07c1d9a2f6e35", revision: 3)

    @Test func aDeviceThatArrangedNothingTakesTheHostsOrder() {
        var held = HeldSidebarOrder()
        #expect(held.isEmpty && held.toSend == nil)
        held.take(HostSidebarOrder(list: first, order: SidebarOrder(agents: ["codex", "claude"], folders: ["/w/app"])))
        #expect(held.order == SidebarOrder(agents: ["codex", "claude"], folders: ["/w/app"]))
        #expect(held.list == first)
        #expect(held.pending.isEmpty && !held.isEmpty)
    }

    @Test func aListArrangedHereIsSentWholeAndIsTheHostsOnceItAnswers() {
        var held = HeldSidebarOrder(order: SidebarOrder(agents: ["claude", "codex"], folders: ["/w/app"]), list: first)
        held.arrange(.agents, ["codex", "claude"])
        #expect(held.pending == [.agents])
        let sending = try! #require(held.toSend)
        // Only the list arranged here: the folders are left as the host has them.
        #expect(sending.agents == ["codex", "claude"] && sending.folders == nil)

        // Meanwhile the folders were arranged on another device: the answer brings them.
        let answer = HostSidebarOrder(
            list: SidebarOrderRevision(id: first.id, revision: 5), order: SidebarOrder(agents: ["codex", "claude"], folders: ["/w/notes", "/w/app"])
        )
        held.sent(sending, answered: answer)
        #expect(held.pending.isEmpty && held.toSend == nil)
        #expect(held.order == answer.order)
        #expect(held.list == answer.list)
    }

    @Test func aMoveMadeOutOfReachIsNotUndoneByWhatTheHostSays() {
        var held = HeldSidebarOrder(order: SidebarOrder(agents: ["claude", "codex"], folders: ["/w/app", "/w/notes"]), list: first)
        held.arrange(.folders, ["/w/notes", "/w/app"])
        // The host's order, as it is before the move reached it.
        held.take(HostSidebarOrder(list: SidebarOrderRevision(id: first.id, revision: 4), order: SidebarOrder(agents: ["codex", "claude"], folders: ["/w/app", "/w/notes"])))
        // The folders stay as arranged here, still to be sent; the agents are the host's.
        #expect(held.order == SidebarOrder(agents: ["codex", "claude"], folders: ["/w/notes", "/w/app"]))
        #expect(held.pending == [.folders])
    }

    @Test func aListArrangedAgainWhileItsSendWasOnItsWayIsSentAgain() {
        var held = HeldSidebarOrder()
        held.arrange(.agents, ["codex", "claude", "pi"])
        let sending = try! #require(held.toSend)
        held.arrange(.agents, ["pi", "codex", "claude"])
        held.sent(sending, answered: HostSidebarOrder(list: first, order: SidebarOrder(agents: ["codex", "claude", "pi"])))
        // The answer is to the older move: the newer one is still this device's.
        #expect(held.order.agents == ["pi", "codex", "claude"])
        #expect(held.pending == [.agents])
        #expect(held.toSend?.agents == ["pi", "codex", "claude"])
    }

    @Test func sortingFoldersByLastUseAgainIsAnEmptyListWhichIsSentLikeAnyOther() {
        var held = HeldSidebarOrder(order: SidebarOrder(folders: ["/w/notes", "/w/app"]), list: first)
        held.arrange(.folders, [])
        let sending = try! #require(held.toSend)
        #expect(sending.folders == [] && sending.agents == nil)
        held.sent(sending, answered: HostSidebarOrder(list: SidebarOrderRevision(id: first.id, revision: 4)))
        #expect(held.order == SidebarOrder() && held.pending.isEmpty)
        // It still knows where the host's order is, so it is kept.
        #expect(!held.isEmpty)
    }

    // MARK: The Macs

    private let miniMac = "aa11aa11aa11aa11", macbookMac = "bb22bb22bb22bb22", studioMac = "cc33cc33cc33cc33"

    @Test func theMacsAreListedByTheOrderAndOneThatIsNotOnItKeepsItsPlace() {
        struct Mac: Equatable { var name: String; var id: String? }
        let rows = [Mac(name: "Old Hermes", id: nil), Mac(name: "MacBook", id: macbookMac), Mac(name: "Mini", id: miniMac), Mac(name: "Studio", id: studioMac)]
        let order = MachineOrder(ids: [studioMac, "dd44dd44dd44dd44", miniMac, macbookMac], at: 10)
        // The Mac with no id stays first, where this device has it; the rest take the other places in the list's order.
        #expect(order.arranged(rows, id: \.id).map(\.name) == ["Old Hermes", "Studio", "Mini", "MacBook"])
        // One added since the Macs were arranged stays where it is too.
        #expect(MachineOrder(ids: [miniMac, macbookMac], at: 10).arranged(rows, id: \.id).map(\.name) == ["Old Hermes", "Mini", "MacBook", "Studio"])
        #expect(MachineOrder(ids: [], at: 10).arranged(rows, id: \.id) == rows)
    }

    @Test func arrangingTheMacsHereKeepsAMacThisDeviceDoesNotHaveAfterTheOneItFollowed() {
        // Every Mac on the list is this device's: the new order is the list.
        let all = MachineOrder(ids: [miniMac, macbookMac], at: 1000).rearranged([macbookMac, miniMac], now: 2000)
        #expect(all == MachineOrder(ids: [macbookMac, miniMac], at: 2000))
        // The studioMac is another device's Mac, after the miniMac: it stays after the miniMac.
        let some = MachineOrder(ids: [miniMac, studioMac, macbookMac], at: 1000).rearranged([macbookMac, miniMac], now: 2000)
        #expect(some.ids == [macbookMac, miniMac, studioMac])
        // One that led the list still leads it, and a Mac new to the list is where this device has it.
        #expect(MachineOrder(ids: [studioMac, miniMac], at: 1000).rearranged([macbookMac, miniMac], now: 2000).ids == [studioMac, macbookMac, miniMac])
        #expect(MachineOrder(ids: [], at: 0).rearranged([miniMac, macbookMac], now: 2000).ids == [miniMac, macbookMac])
    }

    @Test func anOrderArrangedHereIsAlwaysLaterThanTheOneItReplacesWhateverTheClockSays() {
        // This device's clock is behind the one the Macs were last arranged on.
        let behind = MachineOrder(ids: [miniMac, macbookMac], at: 5000).rearranged([macbookMac, miniMac], now: 3000)
        #expect(behind.at == 5001)
        #expect(MachineOrder.newest([nil, MachineOrder(ids: [miniMac], at: 5000), behind, nil]) == behind)
        #expect(MachineOrder.newest([nil, nil]) == nil)
    }

    @Test func twoOrdersOfTheSameMomentAreToldApartTheSameWayEverywhere() {
        let one = MachineOrder(ids: [miniMac, macbookMac], at: 3000)
        let other = MachineOrder(ids: [macbookMac, miniMac], at: 3000)
        // Exactly one of them replaces the other, whichever was met first.
        #expect(one.isLater(than: other) != other.isLater(than: one))
        let winner = one.isLater(than: other) ? one : other
        #expect(MachineOrder.newest([one, other]) == winner && MachineOrder.newest([other, one]) == winner)
        // The same order is not later than itself, and a later moment still wins.
        #expect(!one.isLater(than: one))
        #expect(MachineOrder(ids: [miniMac], at: 3001).isLater(than: winner))
        // A host holding the one that loses is behind the winner; one holding the winner is not behind the loser.
        let loser = winner == one ? other : one
        var held = HeldSidebarOrder()
        held.take(HostSidebarOrder(list: first, machines: loser))
        #expect(held.isBehind(winner))
        held.take(HostSidebarOrder(list: first, machines: winner))
        #expect(!held.isBehind(loser))
    }

    @Test func aHostIsBehindWhenItsCopyOfTheMacsOrderIsOlderOrItHasNone() {
        let order = MachineOrder(ids: [miniMac, macbookMac], at: 2000)
        var held = HeldSidebarOrder()
        #expect(held.isBehind(order) && !held.isBehind(nil))
        held.take(HostSidebarOrder(list: first, machines: MachineOrder(ids: [macbookMac, miniMac], at: 1500)))
        #expect(held.isBehind(order))
        // Its answer to being given the order is its copy now, which is the one given or a later one.
        held.take(HostSidebarOrder(list: first, machines: order))
        #expect(!held.isBehind(order) && held.machines == order && !held.isEmpty)
        held.take(HostSidebarOrder(list: first, machines: MachineOrder(ids: [macbookMac, miniMac], at: 2500)))
        #expect(!held.isBehind(order))
    }

    // MARK: Kept on the device

    @Test func aMacsOrderArrangedDuringASendGoesNextButTheSameCopyIsNotRetriedInALoop() {
        var held = HeldSidebarOrder()
        let sending = MachineOrder(ids: [miniMac, macbookMac], at: 2000)
        #expect(held.machinesToSend(sending, after: nil) == sending)

        let newer = sending.rearranged([macbookMac, miniMac], now: 2001)
        held.take(HostSidebarOrder(list: first, machines: sending))
        #expect(held.machinesToSend(newer, after: sending) == newer)
        held.take(HostSidebarOrder(list: first, machines: newer))
        #expect(held.machinesToSend(newer, after: newer) == nil)

        // A host that does not keep the copy is tried once, without a tight retry loop.
        held.take(HostSidebarOrder(list: first))
        #expect(held.machinesToSend(newer, after: newer) == nil)
        #expect(held.machinesToSend(newer, after: nil) == newer)
    }

    @Test func eachHostsOrderIsKeptOnTheDeviceAndGoesWithItsHost() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-order-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ThreadStore(directory: directory)
        #expect(store.loadOrders().isEmpty)

        var held = HeldSidebarOrder(order: SidebarOrder(agents: ["codex", "claude"], folders: ["/w/app"]), list: first)
        held.arrange(.folders, ["/w/notes", "/w/app"])
        store.saveOrder(held, for: local)
        store.saveOrder(HeldSidebarOrder(order: SidebarOrder(agents: ["karina"])), for: mini)
        let again = ThreadStore(directory: directory).loadOrders()
        #expect(again[local] == held)
        #expect(again[mini]?.order.agents == ["karina"])

        // One with nothing in it is not kept, and a host that is removed takes its own along.
        store.saveOrder(HeldSidebarOrder(), for: mini)
        #expect(store.loadOrders().keys.map(\.rawValue) == ["local"])
        store.forgetHost(local)
        #expect(store.loadOrders().isEmpty)

        // The order of the Macs is the device's, whichever hosts it has.
        #expect(store.loadMachineOrder() == nil)
        store.saveMachineOrder(MachineOrder(ids: ["aa11aa11aa11aa11", "bb22bb22bb22bb22"], at: 1_791_940_000_000))
        #expect(ThreadStore(directory: directory).loadMachineOrder() == MachineOrder(ids: ["aa11aa11aa11aa11", "bb22bb22bb22bb22"], at: 1_791_940_000_000))
    }

    @Test func aHostKeepsItsMacsIdAndOneSavedBeforeHasNone() throws {
        let host = HostConfig(id: local, name: "MacBook", url: URL(string: "https://mbp.example")!, kind: .bridge, machineID: "bb22bb22bb22bb22")
        let again = try JSONDecoder().decode(HostConfig.self, from: JSONEncoder().encode(host))
        #expect(again.machineID == "bb22bb22bb22bb22" && again == host)
        let before = try JSONDecoder().decode(HostConfig.self, from: Data(#"{"id":"local","name":"MacBook","url":"https://mbp.example"}"#.utf8))
        #expect(before.machineID == nil)
    }
}
