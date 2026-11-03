import AgentCore
import Foundation

// What the backend does only with a Portals bridge: the extensions it lists in
// `gateway.ready` (`BridgeWire`). With Hermes, which lists none, none of this is sent.

extension HermesBackend {
    /// The extensions the host offers, as of the last connection: a Portals bridge's
    /// `bridge.features`. Empty for Hermes, and before the first connection.
    public var hostFeatures: Set<String> {
        gatewayReady?.bridge?.features ?? []
    }

    func offers(_ feature: String) -> Bool {
        hostFeatures.contains(feature)
    }
}

// MARK: - Folders

extension HermesBackend: FolderProviding {
    public var offersFolders: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.folders) }
    }

    public func folders(for agent: Agent.ID) async throws -> FolderList {
        guard offers(BridgeWire.Feature.folders) else { throw FolderError.unavailable }
        let result: BridgeWire.FoldersListResult = try await peer().call(
            BridgeWire.Method.foldersList, BridgeWire.FoldersListParams(profile: agent.name), timeout: .seconds(30)
        )
        return result.folderList
    }

    public var addsFolders: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.foldersAdd) }
    }

    public var machine: HostMachine? {
        gatewayReady?.bridge?.machine
    }

    public func addFolder(at path: String) async throws -> Folder {
        guard offers(BridgeWire.Feature.foldersAdd) else { throw FolderError.unavailable }
        do {
            var row: BridgeWire.FolderRow = try await peer().call(BridgeWire.Method.foldersAdd, BridgeWire.FoldersAddParams(path: path))
            if !offers(BridgeWire.Feature.worktrees) { row.repo = nil }
            return row.folder
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            // The bridge's sentence on why not: the folder is missing, hidden, temporary.
            throw FolderError.refused(error.message)
        }
    }

    public func removeFolder(at path: String) async throws {
        guard offers(BridgeWire.Feature.foldersAdd) else { throw FolderError.unavailable }
        let _: BridgeWire.Done = try await peer().call(BridgeWire.Method.foldersRemove, BridgeWire.FoldersAddParams(path: path))
    }

    /// Only with `folders_add` too: a folder found is added before a thread starts there.
    public var searchesFolders: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.folderSearch) && offers(BridgeWire.Feature.foldersAdd) }
    }

    /// A keystroke's query: a short wait, as the list is redrawn by the next one anyway.
    public func searchFolders(_ query: String, limit: Int) async throws -> FolderSearchResults {
        guard offers(BridgeWire.Feature.folderSearch), offers(BridgeWire.Feature.foldersAdd) else { throw FolderError.unavailable }
        do {
            let params = BridgeWire.FoldersSearchParams(query: query, limit: limit)
            let answer = try await peer().request(BridgeWire.Method.foldersSearch, params: JSONValue(encoding: params), timeout: .seconds(20))
            return try BridgeWire.folderSearchResults(from: answer)
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            throw FolderError.refused(error.message)
        }
    }
}

// MARK: - Files on the host

extension HermesBackend: FileReading {
    public var readsFiles: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.fileRead) }
    }

    /// The bridge reads it for any of its threads, followed here or not. An image of 15 MB
    /// comes as 20 of base64: it has the time a slow network needs for that.
    public func readFile(_ path: String, in thread: ThreadRef.ID, purpose: FilePurpose, unless: String?) async throws -> HostFile {
        guard offers(BridgeWire.Feature.fileRead) else { throw FileReadError.unavailable }
        let params = BridgeWire.FileReadParams(sessionID: thread.rawValue, path: path, purpose: purpose.rawValue, unless: unless)
        do {
            let answer = try await peer().request(BridgeWire.Method.fileRead, params: JSONValue(encoding: params), timeout: .seconds(120))
            return try BridgeWire.hostFile(from: answer)
        } catch let error as JSONRPCError where error.code == BridgeWire.unknownThreadCode {
            throw FileReadError.refused(reason: "no_thread", message: "This thread is not on the host any more.")
        }
    }
}

// MARK: - Mentioning files

extension HermesBackend: FileMentionSending {}

extension HermesBackend: FileSearching {
    public var searchesFiles: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.fileSearch) }
    }

    public var takesFileMentions: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.fileMentions) }
    }

    /// The bridge searches any of its threads' folders, followed here or not. A keystroke's
    /// query: a short wait, as the menu is redrawn by the next one anyway.
    public func searchFiles(_ query: String, in scope: FileSearchScope, limit: Int, agent: String?) async throws -> FileSearchResults {
        guard offers(BridgeWire.Feature.fileSearch) else { throw FileSearchError.unavailable }
        let params = BridgeWire.FilesSearchParams(scope: scope, query: query, limit: limit, profile: agent)
        do {
            let answer = try await peer().request(BridgeWire.Method.filesSearch, params: JSONValue(encoding: params), timeout: .seconds(20))
            return try BridgeWire.fileSearchResults(from: answer)
        } catch let error as JSONRPCError where error.code == BridgeWire.unknownThreadCode {
            throw FileSearchError.refused("This thread is not on the host any more.")
        } catch let error as JSONRPCError where error.code == -32602 {
            throw FileSearchError.refused(error.message)
        }
    }
}

// MARK: - Renaming

extension HermesBackend: ThreadRenaming {
    public var renamesThreads: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.rename) }
    }

    /// The bridge takes any of its threads by its stored id, followed here or not.
    public func rename(_ thread: ThreadRef, to title: String) async throws {
        guard offers(BridgeWire.Feature.rename) else { return }
        let _: BridgeWire.Done = try await peer().call(
            BridgeWire.Method.sessionRename,
            BridgeWire.SessionRenameParams(sessionID: thread.id.rawValue, title: title, profile: thread.agent.name)
        )
    }
}

// MARK: - Activity

extension HermesBackend: ThreadActivityReporting {
    public var reportsActivity: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.activity) }
    }

    /// The list's id and revision come only from a bridge that keeps the list.
    public func threadActivity() async throws -> ThreadActivityReport {
        guard offers(BridgeWire.Feature.activity) else { return ThreadActivityReport() }
        let result: BridgeWire.SessionsActivityResult = try await peer().call(
            BridgeWire.Method.sessionsActivity, BridgeWire.SessionsActivityParams(), timeout: .seconds(20)
        )
        return ThreadActivityReport(
            threads: result.activity,
            inherited: result.inherited,
            withoutTurn: result.withoutTurn,
            list: offers(BridgeWire.Feature.threadSync) ? result.list : nil,
            looks: offers(BridgeWire.Feature.agentLooks) ? result.lookList : nil,
            order: offers(BridgeWire.Feature.sidebarOrder) ? result.orderList : nil,
            update: offers(BridgeWire.Feature.updateNotice) ? result.laterVersion : nil
        )
    }
}

// MARK: - Polling at once

/// `hostMoves` is the backend's own stream, fed only from a bridge that lists `poll_now`
/// (`HermesBackend.handle`), which is the only host this app asks to send it.
extension HermesBackend: HostMoveReporting {
    public var reportsMoves: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.pollNow) }
    }
}

// MARK: - Looks every device shares

extension HermesBackend: LookSyncing {
    public var syncsLooks: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.agentLooks) }
    }

    public func hostLooks() async throws -> HostLooks {
        guard offers(BridgeWire.Feature.agentLooks) else { throw LookSyncError.unavailable }
        let result: BridgeWire.LooksListResult = try await peer().call(
            BridgeWire.Method.looksList, BridgeWire.LooksListParams(), timeout: .seconds(20)
        )
        return try result.hostLooks()
    }

    public func setLook(_ look: HostLook, for agent: Agent.ID, unless: LookCondition?) async throws -> HostLook {
        guard offers(BridgeWire.Feature.agentLooks) else { throw LookSyncError.unavailable }
        let result: BridgeWire.LookSetResult = try await peer().call(
            BridgeWire.Method.lookSet, BridgeWire.LookSetParams(profile: agent.name, look: look, unless: unless), timeout: .seconds(20)
        )
        return try result.hostLook()
    }
}

// MARK: - The sidebar's order every device shares

extension HermesBackend: SidebarOrderSyncing {
    public var syncsSidebarOrder: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.sidebarOrder) }
    }

    public func sidebarOrder() async throws -> HostSidebarOrder {
        guard offers(BridgeWire.Feature.sidebarOrder) else { throw SidebarOrderError.unavailable }
        let result: BridgeWire.OrderResult = try await peer().call(
            BridgeWire.Method.orderList, BridgeWire.OrderListParams(), timeout: .seconds(20)
        )
        return try result.hostOrder(withMachines: offers(BridgeWire.Feature.machineOrder))
    }

    public func setSidebarOrder(agents: [String]?, folders: [String]?) async throws -> HostSidebarOrder {
        guard offers(BridgeWire.Feature.sidebarOrder) else { throw SidebarOrderError.unavailable }
        let result: BridgeWire.OrderResult = try await peer().call(
            BridgeWire.Method.orderSet, BridgeWire.OrderSetParams(agents: agents, folders: folders), timeout: .seconds(20)
        )
        return try result.hostOrder(withMachines: offers(BridgeWire.Feature.machineOrder))
    }

    public var syncsMachineOrder: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.sidebarOrder) && offers(BridgeWire.Feature.machineOrder) }
    }

    public var machineID: String? {
        gatewayReady?.bridge?.machine?.id
    }

    public func setMachineOrder(_ order: MachineOrder) async throws -> HostSidebarOrder {
        guard offers(BridgeWire.Feature.sidebarOrder), offers(BridgeWire.Feature.machineOrder) else { throw SidebarOrderError.unavailable }
        let result: BridgeWire.OrderResult = try await peer().call(
            BridgeWire.Method.orderSet, BridgeWire.OrderSetParams(agents: nil, folders: nil, machines: order), timeout: .seconds(20)
        )
        return try result.hostOrder(withMachines: true)
    }
}

// MARK: - The list every device shows

extension HermesBackend: ThreadSyncing, AgentThreadNesting, RecentThreadKeeping {
    public var syncsThreads: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.threadSync) }
    }

    public var keepsRecentThreads: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.threadSync) && offers(BridgeWire.Feature.recentThreads) }
    }

    public func threadListChanges(since: ThreadListRevision?) async throws -> ThreadListChanges {
        guard offers(BridgeWire.Feature.threadSync) else { throw ThreadSyncError.unavailable }
        // The answer is read as the frame was parsed (`init(reading:)`), not through
        // `call`, which would make text of the parsed answer and decode that again.
        let result = try await peer().request(
            BridgeWire.Method.threadsChanges, params: JSONValue(encoding: BridgeWire.ThreadsChangesParams(since: since)),
            timeout: .seconds(30)
        )
        return try BridgeWire.ThreadsChangesResult(reading: result)
            .changes(
                readsBranch: offers(BridgeWire.Feature.threadBranch), readsRepo: offers(BridgeWire.Feature.worktrees),
                readsSenders: offers(BridgeWire.Feature.senders), readsOngoing: offers(BridgeWire.Feature.botChat)
            )
    }

    /// Answered with `{"thread":{…}}`, the thread as the list gives it after the marks.
    public func markThread(_ thread: ThreadRef.ID, _ marks: ThreadMarks) async throws -> ListedThread? {
        guard offers(BridgeWire.Feature.threadSync) else { throw ThreadSyncError.unavailable }
        var answer: JSONValue?
        try await refusing {
            answer = try await peer().call(BridgeWire.Method.threadMark, BridgeWire.ThreadMarkParams(thread: thread.rawValue, marks: marks))
        }
        return answer?["thread"].flatMap {
            BridgeWire.listedThread(
                from: $0, readsBranch: offers(BridgeWire.Feature.threadBranch), readsRepo: offers(BridgeWire.Feature.worktrees),
                readsSenders: offers(BridgeWire.Feature.senders), readsOngoing: offers(BridgeWire.Feature.botChat)
            )
        }
    }

    public var nestsAgentThreads: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.threadSync) && offers(BridgeWire.Feature.agentThreads) }
    }

    /// Sent as `session.rename`, which the bridge takes for any of its threads.
    public func renameThread(_ thread: ThreadRef, to title: String) async throws {
        guard offers(BridgeWire.Feature.threadSync), offers(BridgeWire.Feature.rename) else { throw ThreadSyncError.unavailable }
        try await refusing {
            let _: BridgeWire.Done = try await peer().call(
                BridgeWire.Method.sessionRename,
                BridgeWire.SessionRenameParams(sessionID: thread.id.rawValue, title: title, profile: thread.agent.name)
            )
        }
    }

    public func removeThread(_ thread: ThreadRef.ID) async throws {
        guard offers(BridgeWire.Feature.threadSync) else { throw ThreadSyncError.unavailable }
        try await refusing {
            // Answered once the thread is off the list; the agent's side closes after.
            let _: BridgeWire.Done = try await peer().call(
                BridgeWire.Method.threadDelete, BridgeWire.ThreadDeleteParams(thread: thread.rawValue), timeout: .seconds(60)
            )
        }
    }

    /// The bridge's answers that say no, as the app tells them apart: a thread it does
    /// not know, and anything else with its sentence on why not (-32602 for a thread at
    /// work, -32603 when it could not ask the agent). Either way the bridge answered: a
    /// change it said no to is not sent again, so one that keeps failing cannot hold up
    /// the others.
    private func refusing(_ call: () async throws -> Void) async throws {
        do {
            try await call()
        } catch let error as JSONRPCError where error.code == BridgeWire.unknownThreadCode {
            throw ThreadSyncError.unknownThread
        } catch let error as JSONRPCError {
            throw ThreadSyncError.refused(error.message)
        }
    }
}

// MARK: - Sessions from the desk

extension HermesBackend: DeskSessionProviding {
    public var offersDeskSessions: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.deskSessions) }
    }

    public func deskSessions(for agent: Agent.ID) async throws -> [DeskSession] {
        guard offers(BridgeWire.Feature.deskSessions) else { throw DeskSessionError.unavailable }
        let result: BridgeWire.DeskListResult = try await peer().call(
            BridgeWire.Method.deskList, BridgeWire.DeskListParams(profile: agent.name), timeout: .seconds(30)
        )
        return result.deskSessions(for: agent)
    }

    public func adopt(_ session: DeskSession, as mode: AdoptMode) async throws -> ThreadRef {
        guard offers(BridgeWire.Feature.deskSessions) else { throw DeskSessionError.unavailable }
        let adopted: HermesWire.SessionCreateResult
        do {
            adopted = try await peer().call(
                BridgeWire.Method.sessionAdopt,
                BridgeWire.SessionAdoptParams(profile: session.agent.name, sessionID: session.id, mode: mode.rawValue),
                // Joining a Codex thread starts its MCP servers; forking copies its history.
                timeout: .seconds(120)
            )
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode && mode == .continue {
            // The bridge's sentence on why it will not continue it (-32602).
            throw DeskSessionError.continueRefused(error.message)
        }
        return follow(
            adopted, with: session.agent, title: nil,
            workingDirectory: session.folder.isEmpty ? nil : session.folder, readOnly: mode == .read
        )
    }
}

// MARK: - The net

extension HermesBackend: NetReporting {
    public var offersNet: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.net) }
    }

    public func netList() async throws -> NetList {
        guard offers(BridgeWire.Feature.net) else { throw NetError.unavailable }
        let answer = try await peer().request(BridgeWire.Method.netList, params: JSONValue(encoding: BridgeWire.NetListParams()), timeout: .seconds(20))
        return try BridgeWire.netList(answer)
    }

    public func netInvite() async throws -> NetInvite {
        guard offers(BridgeWire.Feature.net) else { throw NetError.unavailable }
        let answer = try await peer().request(BridgeWire.Method.netInvite, params: JSONValue(encoding: BridgeWire.NetListParams()), timeout: .seconds(20))
        return try BridgeWire.netInvite(answer)
    }

    public func netRemove(_ member: String, inNet net: String?) async throws -> NetList {
        guard offers(BridgeWire.Feature.net) else { throw NetError.unavailable }
        do {
            let answer = try await peer().request(BridgeWire.Method.netRemove, params: JSONValue(encoding: BridgeWire.NetRemoveParams(member: member, net: net)), timeout: .seconds(20))
            return try BridgeWire.netList(answer)
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            throw NetError.refused(error.message)
        }
    }

    public var renamesNetMacs: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.net) && offers(BridgeWire.Feature.netRename) }
    }

    public var renamesNetDevices: Bool? {
        gatewayReady.map { _ in
            offers(BridgeWire.Feature.net) && offers(BridgeWire.Feature.netRename) && offers(BridgeWire.Feature.netRenameDevices)
        }
    }

    public func netRename(_ member: String, to name: String, after: Int?, inNet net: String?) async throws -> NetList {
        guard offers(BridgeWire.Feature.net), offers(BridgeWire.Feature.netRename) else { throw NetError.unavailable }
        do {
            let params = BridgeWire.NetRenameParams(member: member, name: name, after: after, net: net)
            let answer = try await peer().request(BridgeWire.Method.netRename, params: JSONValue(encoding: params), timeout: .seconds(20))
            return try BridgeWire.netList(answer)
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            throw NetError.refused(error.message)
        }
    }

    /// The other Mac may take a while to answer the bridge: it is given the time a call to
    /// it has there, and more.
    public func netJoin(with link: String) async throws -> NetList {
        guard offers(BridgeWire.Feature.net) else { throw NetError.unavailable }
        do {
            let answer = try await peer().request(BridgeWire.Method.netJoinWith, params: JSONValue(encoding: BridgeWire.NetJoinWithParams(link: link)), timeout: .seconds(30))
            return try BridgeWire.netList(answer)
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            throw NetError.refused(error.message)
        }
    }
}
