import Foundation
import Testing
@testable import AgentCore

// What working out the sidebar's list costs (docs/perf-sidebar.md, docs/perf-tabs.md):
// `SidebarLayout.build` as the app calls it after any change on any host (`Fleet.layout`),
// with 600 and 2000 threads over five agents and twelve folders, one in a hundred
// finished and not opened yet, one in twenty pinned, one in twenty-five archived, three
// running, twelve open as tabs (as scripts/tabs-bench.sh has them). Only when asked:
//
//     PORTALS_BENCH=1 swift test -c release -Xswiftc -enable-testing --filter SidebarBenchmarks
//
// It prints the median of each row over its rounds, and the Mac's load beside it. "The
// new fields alone" is what the groups on top and the spaces cost (`top`, `spaces`)
// without the rest of the layout: until night n10 the layout also worked out the fields
// the sidebar had before 2026-10-23, a third of it.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["PORTALS_BENCH"] == "1", "Only with PORTALS_BENCH=1"))
struct SidebarBenchmarks {
    static let mac = HostID(rawValue: "mac")
    static let host = HostConfig(id: mac, name: "Mac", url: URL(string: "http://127.0.0.1:9120")!, generalFolder: "/Users/dev/general")
    static let agents = (1...5).map { Agent(id: Agent.ID(host: mac, name: $0 == 1 ? "fake" : "fake-\($0)")) }
    static let folderCount = 12

    /// `count` threads as the bench's scratch bridge lists them (scripts/sidebar-bench/bridge.mts).
    static func threads(_ count: Int) -> [ThreadRecord] {
        let now = Date.now
        return (0..<count).map { index in
            let ref = ThreadRef(
                id: ThreadRef.ID(rawValue: String(format: "51deba00-0000-4000-8000-%012lx", index + 1)),
                agent: agents[index % agents.count].id,
                title: "thread \(index) " + String(repeating: "sidebar sync ", count: 2 + index % 6),
                createdAt: now.addingTimeInterval(-3720 - Double(index) * 300),
                workingDirectory: String(format: "/Users/dev/folders/project-%02ld", (index * 7 + index / 5) % folderCount + 1)
            )
            var record = ThreadRecord(
                ref: ref, updatedAt: now.addingTimeInterval(-120 - Double(index) * 300), preview: "preview \(index)",
                pinned: index % 20 == 3, archived: index % 25 == 11
            )
            if index % 100 == 4 { record.unseen = true }
            record.revision = count - index
            return record
        }
    }

    /// The twelve threads open as tabs: the newest, three long ones, and short ones.
    static func tabs(of threads: [ThreadRecord]) -> Set<ThreadKey> {
        Set([0, 7, 47, 87, 1, 2, 3, 5, 6, 8, 9, 10].filter { $0 < threads.count }.map { threads[$0].key })
    }

    static func build(_ threads: [ThreadRecord], running: Set<ThreadKey>, tabs: Set<ThreadKey>) -> SidebarLayout {
        SidebarLayout.build(
            hosts: [host], agents: agents, threads: threads, waiting: [], running: running, withFolders: [mac], recent: RecentThreads(keys: tabs)
        )
    }

    /// What `build` does for the fields the sidebar reads now, `top` and `spaces`, and
    /// nothing else.
    static func buildNewFieldsOnly(_ threads: [ThreadRecord], running: Set<ThreadKey>, tabs: Set<ThreadKey>) -> (SidebarGroups, [SidebarSpace]) {
        let known = Set(agents.map(\.id))
        let newest = SidebarSections.newestFirst(threads.filter { known.contains($0.ref.agent) })
        let nested = StartedThreads.nested(newest, nesting: [], listed: known, machines: StartedThreads.machines(of: [host]))
        let tucked = StartedThreads.tucked(newest, nested: nested)
        let top = SidebarGroups.build(newestFirst: newest, recent: RecentThreads(keys: tabs), waiting: [], running: running, tucked: tucked)
        let (spaces, _) = SidebarLayout.spaces(
            hosts: [host], agentsByHost: [mac: agents], newest: newest, tucked: tucked, general: [mac: host.generalFolder],
            withFolders: [mac], folders: [:], order: [:], byLastUse: [], remembered: [:]
        )
        return (top, spaces)
    }

    static func median(rounds: Int, _ work: () -> Void) -> Double {
        var times: [Double] = []
        let clock = ContinuousClock()
        for _ in 0..<rounds {
            let took = clock.measure(work)
            times.append(Double(took.components.attoseconds) / 1e15 + Double(took.components.seconds) * 1000)
        }
        return times.sorted()[times.count / 2]
    }

    @Test(arguments: [600, 2000]) func whatTheSidebarsLayoutCosts(threads count: Int) {
        let listed = Self.threads(count)
        let running = Set(listed.prefix(3).map(\.key))
        let tabs = Self.tabs(of: listed)
        var layout = SidebarLayout()
        var load = [0.0, 0.0, 0.0]
        getloadavg(&load, 3)
        var rows: [(String, Double)] = []

        rows.append(("Fleet.allThreads: every host's threads sorted", Self.median(rounds: 30) {
            _ = listed.sorted { $0.updatedAt > $1.updatedAt }
        }))
        rows.append(("SidebarLayout.build: the whole list", Self.median(rounds: 30) {
            layout = Self.build(listed, running: running, tabs: tabs)
        }))
        var newOnly = (SidebarGroups(), [SidebarSpace]())
        rows.append(("  the new fields alone (top, spaces)", Self.median(rounds: 30) {
            newOnly = Self.buildNewFieldsOnly(listed, running: running, tabs: tabs)
        }))
        #expect(newOnly.0 == layout.top)
        #expect(newOnly.1 == layout.spaces)
        rows.append(("  of which the groups on top (SidebarGroups.build)", Self.median(rounds: 30) {
            _ = SidebarGroups.build(threads: listed, recent: RecentThreads(keys: tabs), waiting: [], running: running)
        }))
        rows.append(("The groups' lines (SidebarGroups.lines, read by each draw)", Self.median(rounds: 30) {
            _ = layout.top.lines
        }))
        // Comparing the list with the one before, as a cache keyed by what it is made of would.
        let again = Self.build(listed, running: running, tabs: tabs)
        rows.append(("Two layouts compared (==)", Self.median(rounds: 30) { _ = layout == again }))
        rows.append(("The threads compared with the ones before (==)", Self.median(rounds: 30) { _ = listed == listed.map { $0 } }))
        // What each draw of the sidebar (and of the tab strip's + menu) pays when nothing
        // changed: its inputs made and compared with the ones kept (`SidebarLayoutCache`).
        var cache = SidebarLayoutCache()
        func inputs() -> SidebarLayoutCache.Inputs {
            SidebarLayoutCache.Inputs(
                hosts: [Self.host], agents: Self.agents, threads: listed.map { $0 }, waiting: [], running: running,
                withFolders: [Self.mac], recent: RecentThreads(keys: tabs)
            )
        }
        _ = cache.layout(for: inputs())
        rows.append(("SidebarLayoutCache: nothing changed (inputs made and compared)", Self.median(rounds: 30) {
            _ = cache.layout(for: inputs())
        }))
        #expect(cache.builds == 1)

        print("SidebarBenchmarks, \(count) threads (load \(String(format: "%.2f", load[0])))")
        for (name, ms) in rows {
            print("  " + name.padding(toLength: 66, withPad: " ", startingAt: 0) + String(format: "%8.3f ms", ms))
        }
    }
}
