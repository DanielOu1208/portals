import AgentCore
import Foundation

// The panel beside a chat (`ThreadPanelProviding`): a bridge's `git_status`, `usage_read`
// and `open_on_host`.

extension BridgeWire.Feature {
    /// `git.status` says what a thread's repository holds uncommitted, `git.diff` one
    /// file's change.
    public static let gitStatus = "git_status"
    /// `usage.read` says how much of the plan the thread's agent has used, as `/usage` does.
    public static let usageRead = "usage_read"
    /// `host.apps` lists the apps on the host a thread's folder opens in, `folder.open` opens it.
    public static let openOnHost = "open_on_host"
}

extension BridgeWire.Method {
    public static let gitStatus = "git.status"
    public static let gitDiff = "git.diff"
    public static let usageRead = "usage.read"
    public static let hostApps = "host.apps"
    public static let folderOpen = "folder.open"
}

extension BridgeWire {
    /// `git.status`, `git.diff`, `usage.read`: the thread asked about.
    public struct ThreadParams: Encodable, Sendable {
        public var sessionID: String

        public init(sessionID: String) {
            self.sessionID = sessionID
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
        }
    }

    public struct FolderOpenParams: Encodable, Sendable {
        public var sessionID: String
        public var app: String

        public init(sessionID: String, app: String) {
            self.sessionID = sessionID
            self.app = app
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case app
        }
    }

    public struct NoParams: Encodable, Sendable {
        public init() {}
    }

    public struct UsageReadResult: Decodable, Sendable {
        public struct Limit: Decodable, Sendable {
            public var name: String
            public var percent: Double?
            /// Unix seconds.
            public var resetsAt: Double?
            public var reached: Bool?
            /// How long the window is, in seconds.
            public var windowSeconds: Double?
            /// Milliseconds since 1970, for a window kept from an earlier answer.
            public var heardAt: Double?

            enum CodingKeys: String, CodingKey {
                case name, percent, reached
                case resetsAt = "resets_at"
                case windowSeconds = "window_seconds"
                case heardAt = "heard_at"
            }
        }

        public var available: Bool
        public var title: String?
        public var limits: [Limit]?
        /// Milliseconds since 1970.
        public var heardAt: Double?
        public var note: String?

        enum CodingKeys: String, CodingKey {
            case available, title, limits, note
            case heardAt = "heard_at"
        }

        public var usage: UsageLimits? {
            guard available else { return nil }
            return UsageLimits(
                title: title,
                windows: (limits ?? []).map {
                    .init(
                        name: $0.name, percent: $0.percent, resetsAt: $0.resetsAt.map { Date(timeIntervalSince1970: $0) },
                        reached: $0.reached ?? false, length: $0.windowSeconds,
                        heardAt: $0.heardAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                    )
                },
                heardAt: heardAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                note: note
            )
        }
    }

    public struct GitStatusResult: Decodable, Sendable {
        public struct File: Decodable, Sendable {
            public var path: String
            public var added: Int?
            public var removed: Int?
        }

        public var repo: Bool
        public var git: Bool?
        public var branch: String?
        public var commit: String?
        public var upstream: String?
        public var ahead: Int?
        public var behind: Int?
        public var files: [File]?
        public var total: Int?
        public var added: Int?
        public var removed: Int?

        public var state: GitState {
            guard repo else { return .noRepository }
            guard git == true else { return .branchOnly(branch: branch, commit: commit) }
            let files = (files ?? []).map { GitFileChange(path: $0.path, added: $0.added, removed: $0.removed) }
            return .status(GitStatus(
                branch: branch, commit: commit, upstream: upstream, ahead: ahead ?? 0, behind: behind ?? 0,
                files: files, total: total, added: added, removed: removed
            ))
        }
    }

    public struct GitDiffResult: Decodable, Sendable {
        public struct File: Decodable, Sendable {
            public var path: String
            public var status: String
            public var added: Int?
            public var removed: Int?
            public var diff: String
            public var cut: Bool?
        }

        public var root: String
        public var files: [File]
        /// How many files differ in all, more than `files` holds when the host cut its list
        /// short, from the same look.
        public var total: Int

        /// As a turn's diff is, a file git does not track yet as one added.
        public var turnDiff: TurnDiff {
            TurnDiff(files: files.map {
                let status: TurnDiff.File.Status = switch $0.status {
                case "deleted": .deleted
                case "added", "untracked": .added
                default: .modified
                }
                return .init(
                    path: $0.path, status: status, added: $0.added ?? 0, removed: $0.removed ?? 0, diff: $0.diff, cut: $0.cut ?? false,
                    uncounted: $0.added == nil || $0.removed == nil
                )
            })
        }
    }

    public struct HostAppsResult: Decodable, Sendable {
        public struct App: Decodable, Sendable {
            public var id: String
            public var name: String
            public var kind: String
            /// A PNG in base64.
            public var icon: String?
        }

        public var apps: [App]

        public var hostApps: [HostApp] {
            apps.map {
                HostApp(id: $0.id, name: $0.name, kind: HostApp.Kind(rawValue: $0.kind) ?? .editor, icon: $0.icon.flatMap { Data(base64Encoded: $0) })
            }
        }
    }
}

extension HermesBackend: ThreadPanelProviding {
    public var readsUsage: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.usageRead) }
    }

    public var readsGitStatus: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.gitStatus) }
    }

    public var opensFolders: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.openOnHost) }
    }

    /// Claude Code may be started only to be asked: it has the time that takes.
    public func usage(of thread: ThreadRef.ID) async throws -> UsageLimits? {
        guard offers(BridgeWire.Feature.usageRead) else { throw ThreadPanelError.unavailable }
        let result: BridgeWire.UsageReadResult = try await panelCall(
            BridgeWire.Method.usageRead, BridgeWire.ThreadParams(sessionID: thread.rawValue), timeout: .seconds(60)
        )
        return result.usage
    }

    public func gitStatus(of thread: ThreadRef.ID) async throws -> GitState {
        guard offers(BridgeWire.Feature.gitStatus) else { throw ThreadPanelError.unavailable }
        let result: BridgeWire.GitStatusResult = try await panelCall(
            BridgeWire.Method.gitStatus, BridgeWire.ThreadParams(sessionID: thread.rawValue), timeout: .seconds(30)
        )
        return result.state
    }

    public func gitDiff(of thread: ThreadRef.ID) async throws -> (root: String, diff: TurnDiff, total: Int) {
        guard offers(BridgeWire.Feature.gitStatus) else { throw ThreadPanelError.unavailable }
        let result: BridgeWire.GitDiffResult = try await panelCall(
            BridgeWire.Method.gitDiff, BridgeWire.ThreadParams(sessionID: thread.rawValue), timeout: .seconds(60)
        )
        return (result.root, result.turnDiff, result.total)
    }

    public func hostApps() async throws -> [HostApp] {
        guard offers(BridgeWire.Feature.openOnHost) else { throw ThreadPanelError.unavailable }
        let result: BridgeWire.HostAppsResult = try await panelCall(BridgeWire.Method.hostApps, BridgeWire.NoParams(), timeout: .seconds(20))
        return result.hostApps
    }

    public func openFolder(of thread: ThreadRef.ID, in app: HostApp.ID) async throws {
        guard offers(BridgeWire.Feature.openOnHost) else { throw ThreadPanelError.unavailable }
        let _: BridgeWire.Done = try await panelCall(
            BridgeWire.Method.folderOpen, BridgeWire.FolderOpenParams(sessionID: thread.rawValue, app: app), timeout: .seconds(20)
        )
    }

    /// The host's sentence on why not, as a `ThreadPanelError`.
    private func panelCall<Output: Decodable & Sendable>(_ method: String, _ params: some Encodable & Sendable, timeout: Duration) async throws -> Output {
        do {
            return try await peer().call(method, params, timeout: timeout)
        } catch let error as JSONRPCError where error.code == BridgeWire.unknownThreadCode {
            throw ThreadPanelError.refused("This thread is not on the host any more.")
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode || error.code == -32603 {
            throw ThreadPanelError.refused(error.message)
        }
    }
}
