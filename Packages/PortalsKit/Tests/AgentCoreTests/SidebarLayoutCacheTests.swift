import Foundation
import Testing
@testable import AgentCore

/// The sidebar's layout is worked out again only when something it is made of changed.
@Suite struct SidebarLayoutCacheTests {
    private let mac = HostID(rawValue: "mac")

    private func inputs(_ threads: [ThreadRecord], running: Set<ThreadKey> = []) -> SidebarLayoutCache.Inputs {
        let host = HostConfig(id: mac, name: "Mac", url: URL(string: "http://127.0.0.1:9120")!, generalFolder: "/Users/dev/general")
        let agents = [Agent(id: Agent.ID(host: mac, name: "claude")), Agent(id: Agent.ID(host: mac, name: "codex"))]
        return SidebarLayoutCache.Inputs(hosts: [host], agents: agents, threads: threads, waiting: [], running: running, withFolders: [mac])
    }

    private func thread(_ index: Int, agent: String = "claude", ago: TimeInterval) -> ThreadRecord {
        let ref = ThreadRef(
            id: ThreadRef.ID(rawValue: "t\(index)"), agent: Agent.ID(host: mac, name: agent), title: "Thread \(index)",
            workingDirectory: "/Users/dev/project-\(index % 3)"
        )
        return ThreadRecord(ref: ref, updatedAt: Date(timeIntervalSince1970: 1_800_000_000 - ago))
    }

    /// Each choice of how much of Recent shows is a change of what the layout is made of,
    /// and asking again with the one it has is not.
    @Test func theChoiceOfRecentIsPartOfWhatTheLayoutIsMadeOf() {
        let threads = (0..<20).map { number in
            var record = thread(number, ago: Double(number) * 60)
            record.recent = true
            return record
        }
        var cache = SidebarLayoutCache()
        var given = inputs(threads)
        #expect(cache.layout(for: given).top.recent.count == 15)
        #expect(cache.builds == 1)
        given.recentChoice = RecentChoice(count: 5)
        #expect(cache.layout(for: given).top.recent.count == 5)
        #expect(cache.builds == 2)
        _ = cache.layout(for: given)
        #expect(cache.builds == 2)
        given.recentChoice = RecentChoice(shows: false, count: 5)
        #expect(cache.layout(for: given).top.recent.isEmpty)
        #expect(cache.builds == 3)
        given.recentChoice = RecentChoice()
        #expect(cache.layout(for: given).top.recent.count == 15)
        #expect(cache.builds == 4)
    }

    @Test func theSameInputsGiveTheKeptLayoutAndAChangeWorksItOutAgain() {
        var threads = (0..<12).map { thread($0, agent: $0 % 2 == 0 ? "claude" : "codex", ago: Double($0) * 60) }
        var cache = SidebarLayoutCache()
        let first = cache.layout(for: inputs(threads))
        #expect(cache.builds == 1)
        #expect(first == SidebarLayout.build(hosts: inputs(threads).hosts, agents: inputs(threads).agents, threads: threads, waiting: [], running: [], withFolders: [mac]))

        // Asked again with the same, as each time the sidebar is drawn: kept.
        #expect(cache.layout(for: inputs(threads.map { $0 })) == first)
        #expect(cache.builds == 1)

        // A thread starts running: worked out again, and it is on top.
        let running = cache.layout(for: inputs(threads, running: [threads[3].key]))
        #expect(cache.builds == 2)
        #expect(running.top.running.map(\.key) == [threads[3].key])

        // A title changes: worked out again, with the new title in its place.
        threads[5].ref.title = "Renamed"
        let renamed = cache.layout(for: inputs(threads, running: [threads[3].key]))
        #expect(cache.builds == 3)
        #expect((renamed.spaces[0].folders.flatMap(\.threads) + renamed.spaces[0].bots.flatMap(\.threads)).contains { $0.ref.title == "Renamed" })

        // Unseen after a turn: under Finished.
        threads[7].unseen = true
        let finished = cache.layout(for: inputs(threads, running: [threads[3].key]))
        #expect(cache.builds == 4)
        #expect(finished.top.finished.map(\.key) == [threads[7].key])
    }
}
