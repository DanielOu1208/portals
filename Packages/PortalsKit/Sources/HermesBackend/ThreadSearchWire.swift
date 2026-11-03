import AgentCore
import Foundation

// Search inside threads on the wire (feature `thread_search`, docs/gateway-protocol.md
// section 11): `thread.search`, what it is asked with and what it answers.

extension BridgeWire.Feature {
    /// `thread.search`: words in the user's messages and the agent's replies of every
    /// thread the bridge lists, grouped by thread, newest first, with a cursor for more.
    public static let threadSearch = "thread_search"
}

extension BridgeWire.Method {
    public static let threadSearch = "thread.search"
}

extension BridgeWire {
    /// Never `linked`: the app asks each of its hosts by itself.
    public struct ThreadSearchParams: Encodable, Sendable {
        public var query: String
        public var limit: Int?
        public var hits: Int?
        public var cursor: String?
        public var agent: String?
        public var folder: String?

        public init(query: String, limit: Int? = nil, hits: Int? = nil, cursor: String? = nil, agent: String? = nil, folder: String? = nil) {
            self.query = query
            self.limit = limit
            self.hits = hits
            self.cursor = cursor
            self.agent = agent
            self.folder = folder
        }

        public init(_ query: ThreadSearchQuery, cursor: String?) {
            self.init(query: query.text, limit: query.limit, hits: query.hits, cursor: cursor, agent: query.agent, folder: query.folder)
        }
    }

    /// One hit as the bridge gives it; nil for one that does not fit, which costs only itself.
    public static func threadSearchHit(_ value: JSONValue) -> ThreadSearchHit? {
        guard let role = value["role"]?.stringValue.flatMap(ThreadSearchHit.Role.init(rawValue:)),
              let text = value["text"]?.stringValue,
              let timestamp = value["timestamp"]?.doubleValue else { return nil }
        let ranges: [Range<Int>] = (value["ranges"]?.arrayValue ?? []).compactMap { range in
            guard let start = range["start"]?.intValue, let end = range["end"]?.intValue, start >= 0, start < end else { return nil }
            return start ..< end
        }
        return ThreadSearchHit(
            role: role, snippet: text, utf16Ranges: ranges, timestamp: Date(timeIntervalSince1970: timestamp),
            agentMessageID: value["id"]?.stringValue, beforeCompaction: value["before_compaction"]?.boolValue ?? false
        )
    }

    /// One thread with hits; nil for one that does not fit.
    public static func threadSearchResult(_ value: JSONValue) -> ThreadSearchResult? {
        guard let id = value["id"]?.stringValue, !id.isEmpty,
              let agent = value["agent"]?.stringValue,
              let folder = value["folder"]?.stringValue,
              let updated = value["updated"]?.doubleValue,
              let count = value["count"]?.intValue else { return nil }
        let title = value["title"]?.stringValue
        return ThreadSearchResult(
            threadID: ThreadRef.ID(rawValue: id), agent: agent, agentName: value["agent_name"]?.stringValue ?? agent,
            title: title?.isEmpty == false ? title : nil, folder: folder, updated: Date(timeIntervalSince1970: updated),
            archived: value["archived"]?.boolValue ?? false, count: count,
            hits: (value["hits"]?.arrayValue ?? []).compactMap(threadSearchHit), partial: value["partial"]?.boolValue ?? false,
            compactedAt: value["compacted_at"]?.doubleValue.map(Date.init(timeIntervalSince1970:))
        )
    }

    /// What `thread.search` answers.
    public static func threadSearchPage(_ value: JSONValue) throws -> ThreadSearchPage {
        guard let threads = value["threads"]?.arrayValue else {
            throw HermesConnectionError.refused("The host's answer is not a search's.")
        }
        let gaps: [ThreadSearchGap] = (value["unsearched"]?.arrayValue ?? []).compactMap { gap in
            guard let agent = gap["agent"]?.stringValue, let count = gap["count"]?.intValue else { return nil }
            return ThreadSearchGap(agent: agent, count: count, reason: gap["reason"]?.stringValue ?? "")
        }
        let cursor = value["cursor"]?.stringValue
        return ThreadSearchPage(
            threads: threads.compactMap(threadSearchResult), cursor: cursor?.isEmpty == false ? cursor : nil,
            scanned: value["scanned"]?.intValue ?? 0, unsearched: gaps, replaced: value["replaced"]?.boolValue ?? false
        )
    }
}

// MARK: - The backend

extension HermesBackend: ThreadSearching {
    public var searchesThreads: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.threadSearch) }
    }

    /// A page takes the bridge at most a second and a half of scanning; the rest is the network's.
    public func searchThreads(_ query: ThreadSearchQuery, cursor: String?) async throws -> ThreadSearchPage {
        guard offers(BridgeWire.Feature.threadSearch) else { throw ThreadSearchError.unavailable }
        guard !query.isEmpty else { throw ThreadSearchError.refused("Type something to look for.") }
        do {
            let params = BridgeWire.ThreadSearchParams(query, cursor: cursor)
            let answer = try await peer().request(BridgeWire.Method.threadSearch, params: JSONValue(encoding: params), timeout: .seconds(30))
            return try BridgeWire.threadSearchPage(answer)
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            throw ThreadSearchError.refused(error.message)
        }
    }
}
