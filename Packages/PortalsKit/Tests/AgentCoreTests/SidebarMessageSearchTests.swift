import Foundation
import Testing
@testable import AgentCore

@Suite @MainActor struct SidebarMessageSearchTests {
    private actor Searcher: ThreadSearching {
        var searchesThreads: Bool? = true
        var calls: [ThreadSearchQuery] = []
        var cancellations = 0
        let page: ThreadSearchPage
        let slowQuery: String?
        let fails: Bool

        init(_ results: [ThreadSearchResult] = [], supported: Bool = true, replaced: Bool = false, slowQuery: String? = nil, fails: Bool = false) {
            page = ThreadSearchPage(threads: results, replaced: replaced)
            searchesThreads = supported
            self.slowQuery = slowQuery
            self.fails = fails
        }

        func searchThreads(_ query: ThreadSearchQuery, cursor: String?) async throws -> ThreadSearchPage {
            #expect(cursor == nil)
            calls.append(query)
            if query.text == slowQuery {
                do { try await Task.sleep(for: .milliseconds(800)) } catch { cancellations += 1 }
            }
            if fails { throw ThreadSearchError.unavailable }
            var answer = page
            if slowQuery != nil, !answer.threads.isEmpty, !answer.threads[0].hits.isEmpty {
                answer.threads[0].hits[0].snippet = query.text
            }
            return answer
        }
    }

    private let north = HostID(rawValue: "north")
    private let south = HostID(rawValue: "south")

    private func record(_ id: String, host: HostID) -> ThreadRecord {
        ThreadRecord(ref: ThreadRef(id: .init(rawValue: id), agent: .init(host: host, name: "fake"), createdAt: .distantPast), updatedAt: .distantPast)
    }

    private func result(_ id: String, at time: Double, hits: Bool = true) -> ThreadSearchResult {
        ThreadSearchResult(threadID: .init(rawValue: id), agent: "fake", agentName: "Fake", folder: "/project", updated: Date(timeIntervalSince1970: time), count: 1,
                           hits: hits ? [.init(role: .user, snippet: "Dana chose deployment", utf16Ranges: [11..<17], timestamp: .distantPast)] : [])
    }

    @Test func queryThresholdAndScope() {
        for text in ["", "  ", "de", " de ", "\"\"\""] { #expect(SidebarMessageSearch.query(for: text) == nil) }
        #expect(SidebarMessageSearch.query(for: "  deploy  ") == ThreadSearchQuery(text: "deploy", limit: 20, hits: 1))
        #expect(SidebarMessageSearch.query(for: "部署先") != nil)
    }

    @Test func mergesOnePageAndLeavesOutTitlesUnknownAndDuplicateThreads() async {
        let search = SidebarMessageSearch()
        let first = Searcher([result("a", at: 10), result("a", at: 9), result("title", at: 30), result("unknown", at: 40), result("empty", at: 50, hits: false)])
        let second = Searcher([result("a", at: 20)])
        let hosts = [SidebarMessageSearch.Host(id: north, backend: first), .init(id: south, backend: second)]
        await search.search("deploy", hosts: hosts + [hosts[0]])
        let a = record("a", host: north), b = record("a", host: south), title = record("title", host: north)
        let matches = search.matches(for: "deploy", in: [a, b, title, record("empty", host: north)], excluding: [title.key])
        #expect(matches.map(\.id) == [b.key, a.key])
        #expect(matches.first?.hit.role == .user)
        #expect(await first.calls == [ThreadSearchQuery(text: "deploy", limit: 20, hits: 1)])
        #expect(search.matches(for: "new query", in: [a, b], excluding: []).isEmpty)
    }

    @Test func typingCancelsDebounceAndEmptyQueriesDoNotAsk() async throws {
        let search = SidebarMessageSearch(), backend = Searcher()
        let hosts = [SidebarMessageSearch.Host(id: north, backend: backend)]
        await search.search("", hosts: hosts)
        await search.search("de", hosts: hosts)
        let old = Task { await search.search("dep", hosts: hosts) }
        try await Task.sleep(for: .milliseconds(40))
        #expect(await backend.calls.isEmpty)
        old.cancel()
        await search.search("deploy", hosts: hosts)
        await old.value
        #expect(await backend.calls.map(\.text) == ["deploy"])
    }

    @Test func replacedUnsupportedAndFailedSearchesStayEmpty() async {
        let search = SidebarMessageSearch()
        let replaced = Searcher([result("a", at: 10)], replaced: true)
        let unsupported = Searcher([result("a", at: 10)], supported: false)
        let failed = Searcher(fails: true)
        await search.search("deploy", hosts: [.init(id: north, backend: replaced), .init(id: south, backend: unsupported), .init(id: .init(rawValue: "failed"), backend: failed)])
        #expect(search.matches(for: "deploy", in: [record("a", host: north)], excluding: []).isEmpty)
        #expect(await unsupported.calls.isEmpty)
        #expect(await failed.calls.count == 1)
    }

    @Test func anOlderAnswerCannotReplaceANewerSearch() async throws {
        let search = SidebarMessageSearch(), backend = Searcher([result("a", at: 10)], slowQuery: "old")
        let hosts = [SidebarMessageSearch.Host(id: north, backend: backend)]
        let old = Task { await search.search("old", hosts: hosts) }
        for _ in 0..<100 {
            if await !backend.calls.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await backend.calls.map(\.text) == ["old"])
        await search.search("new", hosts: hosts)
        await old.value
        #expect(search.matches(for: "old", in: [record("a", host: north)], excluding: []).isEmpty)
        #expect(search.matches(for: "new", in: [record("a", host: north)], excluding: []).first?.hit.snippet == "new")
    }

    @Test func cancellingARequestDropsItsAnswer() async throws {
        let search = SidebarMessageSearch(), backend = Searcher([result("a", at: 10)], slowQuery: "deploy")
        let task = Task { await search.search("deploy", hosts: [.init(id: north, backend: backend)]) }
        for _ in 0..<100 {
            if await !backend.calls.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await backend.calls.count == 1)
        task.cancel()
        await task.value
        #expect(search.matches(for: "deploy", in: [record("a", host: north)], excluding: []).isEmpty)
    }

    @Test func hidingDuringDebounceDoesNotAskAndReopeningResumes() async throws {
        let search = SidebarMessageSearch(), backend = Searcher()
        let hosts = [SidebarMessageSearch.Host(id: north, backend: backend)]
        let visible = Task { await search.search("deploy", hosts: hosts) }
        try await Task.sleep(for: .milliseconds(40))
        visible.cancel()
        await search.search("deploy", hosts: hosts, isVisible: false)
        await visible.value
        #expect(await backend.calls.isEmpty)
        await search.search("deploy", hosts: hosts)
        #expect(await backend.calls.map(\.text) == ["deploy"])
    }

    @Test func hidingCancelsAnAnswerAndHostChangesStayHidden() async throws {
        let search = SidebarMessageSearch(), backend = Searcher([result("a", at: 10)], slowQuery: "deploy")
        let hosts = [SidebarMessageSearch.Host(id: north, backend: backend)]
        let visible = Task { await search.search("deploy", hosts: hosts) }
        for _ in 0..<100 {
            if await !backend.calls.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await backend.calls.count == 1)
        visible.cancel()
        await search.search("deploy", hosts: hosts, isVisible: false)
        await visible.value
        #expect(await backend.cancellations == 1)
        #expect(await backend.calls.count == 1)
        #expect(search.matches(for: "deploy", in: [record("a", host: north)], excluding: []).isEmpty)
        let joined = Searcher()
        await search.search("another query", hosts: hosts + [.init(id: south, backend: joined)], isVisible: false)
        #expect(await backend.calls.count == 1)
        #expect(await joined.calls.isEmpty)
    }

}
