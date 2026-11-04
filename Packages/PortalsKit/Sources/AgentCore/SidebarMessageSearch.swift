import Foundation
import Observation

/// The sidebar's one page of message matches, independent of its instant title search.
@MainActor @Observable
public final class SidebarMessageSearch {
    public struct Host: Sendable {
        public var id: HostID
        public var backend: any ThreadSearching

        public init(id: HostID, backend: any ThreadSearching) {
            self.id = id
            self.backend = backend
        }
    }

    public struct Match: Identifiable {
        public var record: ThreadRecord
        public var hit: ThreadSearchHit
        public var id: ThreadKey { record.key }
    }

    private var searchedText = ""
    private var pages: [HostID: ThreadSearchPage] = [:]
    @ObservationIgnored private var generation = 0

    public init() {}

    public static func query(for text: String) -> ThreadSearchQuery? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let query = ThreadSearchQuery(text: text, limit: 20, hits: 1)
        return text.count >= 3 && !query.isEmpty ? query : nil
    }

    /// Called by a view task, so leaving search or changing its query cancels the wait and requests.
    public func search(_ text: String, hosts: [Host], onFailure: @escaping @Sendable () -> Void = {}) async {
        generation += 1
        let current = generation
        searchedText = text
        pages = [:]
        guard let query = Self.query(for: text), !hosts.isEmpty else { return }
        do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
        guard !Task.isCancelled, generation == current else { return }
        await withTaskGroup(of: (HostID, ThreadSearchPage?).self) { group in
            var asked: Set<HostID> = []
            for host in hosts where asked.insert(host.id).inserted {
                group.addTask {
                    guard !Task.isCancelled, await host.backend.searchesThreads == true else { return (host.id, nil) }
                    do {
                        try Task.checkCancellation()
                        let page = try await host.backend.searchThreads(query, cursor: nil)
                        return (host.id, page.replaced ? nil : page)
                    } catch {
                        if !Task.isCancelled { onFailure() }
                        return (host.id, nil)
                    }
                }
            }
            for await (host, page) in group {
                guard !Task.isCancelled, generation == current else { continue }
                pages[host] = page
            }
        }
    }

    public func matches(for text: String, in threads: [ThreadRecord], excluding titles: Set<ThreadKey>) -> [Match] {
        guard searchedText == text else { return [] }
        let known = Dictionary(threads.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = titles
        return pages.flatMap { host, page in
            page.threads.map { (ThreadKey(host: host, id: $0.threadID), $0) }
        }.sorted {
            if $0.1.updated != $1.1.updated { return $0.1.updated > $1.1.updated }
            if $0.0.host != $1.0.host { return $0.0.host.rawValue < $1.0.host.rawValue }
            return $0.0.id.rawValue < $1.0.id.rawValue
        }.compactMap { key, result in
            guard let record = known[key], let hit = result.hits.first, seen.insert(key).inserted else { return nil }
            return Match(record: record, hit: hit)
        }
    }
}
