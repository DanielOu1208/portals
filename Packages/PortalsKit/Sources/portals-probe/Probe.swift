import AgentCore
import Foundation
import HermesBackend

/// A command-line check of the Hermes protocol client against a real `hermes serve`.
///
///     portals-probe profiles
///     portals-probe folders [--profile NAME]     (a Portals bridge's folders for new threads)
///     portals-probe desk [--profile NAME]        (a Portals bridge's sessions started in a terminal)
///     portals-probe adopt ID --mode fork         (take one up as a thread, then open it)
///     portals-probe threads [--list ID --since N] (a Portals bridge's list of threads for every device)
///     portals-probe looks                        (how a Portals bridge's agents look on every device)
///     portals-probe chat [--profile NAME] [--cwd DIR] [--model M --provider P] "Reply with the single word: pong"
///     portals-probe call model.options '{}'      (any method, raw JSON params; prints the result)
///
/// Options: `--url http://127.0.0.1:9119`, `--token TOKEN`, `--capture FILE.jsonl`
/// (records every frame in both directions, for test fixtures), and `--user NAME` to
/// sign in with a password, which is read from the `PORTALS_PASSWORD` environment
/// variable so it stays out of the command line.
@main
struct Probe {
    static func main() async {
        do {
            try await run(Arguments(CommandLine.arguments.dropFirst()))
        } catch let error as UsageError {
            FileHandle.standardError.write(Data("\(error.message)\n\n\(usage)\n".utf8))
            exit(2)
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            exit(1)
        }
    }

    static let usage = """
        usage: portals-probe [--url URL] [--token TOKEN] [--capture FILE] <command>

        commands:
          profiles                          list the host's Hermes profiles
          folders [--profile NAME]          list the folders a Portals bridge offers for new threads
          desk [--profile NAME]             list the sessions a Portals bridge's agent has from a terminal
          adopt <session-id> [--profile NAME] [--mode continue|fork|read]
                                            take one of those up as a thread (default: continue), then
                                            open it as the app does and print its history
          threads [--list ID --since N]     list the threads a Portals bridge keeps for every device, with
                                            their marks, as the app reads them; with a list id and revision,
                                            only what changed since
          looks                             list how a Portals bridge's agents look on every device, as
                                            the app reads it
          slash [--profile NAME] /COMMAND   run one slash command in a new session and print the answer
          chat [--profile NAME] [--cwd DIR] [--model M] [--provider P]
               [--approve once|session|always|deny[,…]] [--answer TEXT] [--interrupt-after SECONDS]
               [--turns N] [--slash /COMMAND]...
               [--follow-up TEXT [--follow-up-after SECONDS]] [--image FILE]... <prompt>
                                            start a session, send one prompt, stream the reply.
                                            Approval requests are answered with --approve (default
                                            deny; a list is used in order, its last answer repeating);
                                            clarifying questions with --answer (default: skipped).
                                            --slash runs a command in the new session first
          call <method> [json-params]       send any request and print the raw result
          reattach <stored-id> [--profile NAME] [--last-seen N] [--approve X] [--answer TEXT]
                                            what the app does after a dropped connection: resume the
                                            session, fetch missed events, answer open requests, follow
                                            the run to its end. --approve hold leaves a request open

        options:
          --url URL        base URL of hermes serve (default http://127.0.0.1:9119)
          --token TOKEN    session token; read from the server's root page when omitted
          --user NAME      sign in as NAME, with the password in $PORTALS_PASSWORD
          --capture FILE   append every frame to FILE as JSON lines
        """

    static func run(_ arguments: Arguments) async throws {
        let recorder = try arguments.capturePath.map(FrameRecorder.init(path:))
        let authenticator: any HermesAuthenticator
        if let user = arguments.user {
            // `AERIPORTAL_PASSWORD`, its name before the app was Portals, still works.
            let environment = ProcessInfo.processInfo.environment
            let password = environment["PORTALS_PASSWORD"] ?? environment["AERIPORTAL_PASSWORD"] ?? ""
            authenticator = PasswordAuthenticator(baseURL: arguments.baseURL) {
                PasswordAuthenticator.Credentials(username: user, password: password)
            }
        } else {
            authenticator = LoopbackTokenAuthenticator(baseURL: arguments.baseURL, fixedToken: arguments.token)
        }
        let connection = try await HermesConnection.open(authenticator: authenticator) { request in
            let transport = URLSessionWebSocketTransport(request: request)
            guard let recorder else { return transport }
            return RecordingTransport(base: transport, recorder: recorder)
        }
        let peer = connection.peer
        emit("connected: replay_epoch=\(connection.ready.replayEpoch ?? "-") heartbeat=\(connection.ready.supportsHeartbeat)")
        emit("server requests: \(connection.serverRequestMethods?.joined(separator: ", ") ?? "(a bridge's, not waited for)")")

        switch arguments.command {
        case .profiles:
            try await listProfiles(peer)
        case let .folders(profile):
            try await listFolders(peer, ready: connection.ready, profile: profile)
        case let .desk(profile):
            try await listDeskSessions(peer, ready: connection.ready, profile: profile)
        case let .adopt(sessionID, mode, options):
            try await adopt(peer, sessionID: sessionID, mode: mode, options: options)
        case let .threads(since):
            try await listThreads(peer, ready: connection.ready, since: since)
        case .looks:
            try await listLooks(peer, ready: connection.ready)
        case let .chat(options, prompt):
            try await chat(peer, options: options, prompt: prompt)
        case let .call(method, params):
            emit(try await peer.request(method, params: params, timeout: .seconds(120)).serialized())
        case let .slash(line, options):
            try await slash(peer, line: line, options: options)
        case let .reattach(storedID, lastSeen, options):
            try await reattach(peer, storedID: storedID, lastSeen: lastSeen, options: options)
        }
        await peer.close()
    }

    static func listProfiles(_ peer: JSONRPCPeer) async throws {
        let result: HermesWire.ProfilesListResult = try await peer.call(
            HermesWire.Method.profilesList, HermesWire.ProfilesListParams()
        )
        for profile in result.profiles ?? [] {
            let marker = profile.isDefault == true ? "*" : " "
            let label = profile.displayName.map { " (\($0))" } ?? ""
            emit("\(marker) \(profile.name)\(label)  \(profile.provider ?? "-")/\(profile.model ?? "-")")
        }
    }

    /// The folders a bridge offers for new threads, as the app's folder sheet lists them.
    static func listFolders(_ peer: JSONRPCPeer, ready: HermesWire.GatewayReady, profile: String?) async throws {
        let features = ready.bridge?.features ?? []
        emit("bridge features: \(features.isEmpty ? "none" : features.sorted().joined(separator: ", "))")
        guard features.contains(BridgeWire.Feature.folders) else {
            emit("this host offers no folders")
            return
        }
        let result: BridgeWire.FoldersListResult = try await peer.call(
            BridgeWire.Method.foldersList, BridgeWire.FoldersListParams(profile: profile)
        )
        let list = result.folderList
        emit("General  \(list.general.path)")
        for folder in list.recent {
            let used = folder.lastUsed.map { "  " + $0.formatted(.relative(presentation: .named)) } ?? ""
            emit("\(folder.name)\(used)  \(folder.path)")
        }
    }

    /// An agent's sessions from the desk, as the app's sheet lists them: state, id, folder, title.
    static func listDeskSessions(_ peer: JSONRPCPeer, ready: HermesWire.GatewayReady, profile: String?) async throws {
        let features = ready.bridge?.features ?? []
        guard features.contains(BridgeWire.Feature.deskSessions) else {
            emit("this host offers no sessions from the desk")
            return
        }
        let result: BridgeWire.DeskListResult = try await peer.call(
            BridgeWire.Method.deskList, BridgeWire.DeskListParams(profile: profile)
        )
        let agent = Agent.ID(host: HostID(rawValue: "probe"), name: profile ?? "")
        for session in result.deskSessions(for: agent) {
            let updated = session.updated.map { "  " + $0.formatted(.relative(presentation: .named)) } ?? ""
            emit("\(session.state.rawValue)  \(session.id)  \(session.folder)\(updated)  \(session.title)")
        }
    }

    /// The bridge's list of threads, as the app reads it: the list's id and revision, then
    /// one line per thread (id, agent, revision, time, title, preview, who started it and
    /// its marks), then the ids taken off the list.
    static func listThreads(_ peer: JSONRPCPeer, ready: HermesWire.GatewayReady, since: ThreadListRevision?) async throws {
        let features = ready.bridge?.features ?? []
        guard features.contains(BridgeWire.Feature.threadSync) else {
            emit("this host keeps no list of threads for every device")
            return
        }
        let result: BridgeWire.ThreadsChangesResult = try await peer.call(
            BridgeWire.Method.threadsChanges, BridgeWire.ThreadsChangesParams(since: since)
        )
        let changes = try result.changes()
        emit("list \(changes.list.id) revision \(changes.list.revision)\(changes.isFull ? " (every thread)" : " (changed since \(since?.revision ?? 0))")")
        for thread in changes.threads {
            let marks = [
                thread.pinned ? "pinned" : nil, thread.archived ? "archived" : nil, thread.unseen ? "unseen" : nil,
                thread.recent ? "recent" : nil,
                thread.readOnly ? "read-only" : nil,
            ].compactMap(\.self)
            let updated = thread.updated.formatted(.relative(presentation: .named))
            var line = "\(thread.id.rawValue)  \(thread.agent)  r\(thread.revision)  \(updated)  \(thread.title ?? "(untitled)")"
            if let preview = thread.preview { line += "  · \(preview)" }
            if let starter = thread.startedBy { line += "  [started by \(starter.name)\(starter.thread.map { " (thread \($0.rawValue))" } ?? "")]" }
            if !marks.isEmpty { line += "  {\(marks.joined(separator: ", "))}" }
            emit(line)
        }
        for id in changes.unreadable {
            emit("\(id.rawValue)  (could not be read)")
        }
        if !changes.removed.isEmpty {
            emit("removed: \(changes.removed.map(\.rawValue).joined(separator: ", "))")
        }
    }

    /// The looks a bridge keeps for its agents, as the app reads them: the id and revision
    /// of the list, then one line per agent (its three numbers, the logo's setting when
    /// one was made, and who decided the look).
    static func listLooks(_ peer: JSONRPCPeer, ready: HermesWire.GatewayReady) async throws {
        guard ready.bridge?.features.contains(BridgeWire.Feature.agentLooks) == true else {
            emit("this host does not keep how its agents look for every device")
            return
        }
        let result: BridgeWire.LooksListResult = try await peer.call(BridgeWire.Method.looksList, BridgeWire.LooksListParams())
        let looks = try result.hostLooks()
        emit("looks \(looks.list.id) revision \(looks.list.revision)")
        for (agent, kept) in looks.looks.sorted(by: { $0.key < $1.key }) {
            let logo = kept.look.showsLogo.map { $0 ? "  logo on" : "  logo off" } ?? ""
            emit("\(agent)  shape \(kept.look.shape)  face \(kept.look.face)  tint \(kept.look.tint)\(logo)  \(kept.origin.rawValue)")
        }
    }

    /// Takes a session from the desk up as a thread, then opens it as the app does.
    static func adopt(_ peer: JSONRPCPeer, sessionID: String, mode: AdoptMode, options: Arguments.ChatOptions) async throws {
        let adopted: HermesWire.SessionCreateResult = try await peer.call(
            BridgeWire.Method.sessionAdopt,
            BridgeWire.SessionAdoptParams(profile: options.profile, sessionID: sessionID, mode: mode.rawValue),
            timeout: .seconds(120)
        )
        emit("thread: \(adopted.storedSessionID ?? adopted.sessionID)  \(adopted.info?.cwd ?? "-")  \(adopted.info?.title ?? "-")")
        try await reattach(peer, storedID: adopted.storedSessionID ?? adopted.sessionID, lastSeen: 0, options: options)
    }

    static func chat(_ peer: JSONRPCPeer, options: Arguments.ChatOptions, prompt: String) async throws {
        let profile = options.profile
        let session: HermesWire.SessionCreateResult = try await peer.call(
            HermesWire.Method.sessionCreate,
            HermesWire.SessionCreateParams(
                profile: profile, title: "portals-probe", cwd: options.cwd,
                model: options.model, provider: options.provider
            ),
            timeout: .seconds(120)
        )
        emit("session: runtime=\(session.sessionID) stored=\(session.storedSessionID ?? "-") model=\(session.info?.model ?? "-") hermes=\(session.info?.version ?? "-")")
        for line in options.slashCommands {
            emit("\(line) -> " + (try await runSlash(line, sessionID: session.sessionID, profile: profile, on: peer).serialized()))
        }

        let interrupting = options.interruptAfter.map { seconds in
            Task {
                try? await Task.sleep(for: .seconds(seconds))
                guard !Task.isCancelled else { return }
                let result = try? await peer.request(
                    HermesWire.Method.sessionInterrupt, params: ["session_id": .string(session.sessionID)]
                )
                emit("\n[interrupt -> \(result?["status"]?.stringValue ?? "failed")]")
            }
        }
        defer { interrupting?.cancel() }

        // A follow-up that Hermes queues runs as a second turn. One that steers or
        // redirects the run stays in the first, so there is only one turn to wait for.
        let followingUp = options.followUp.map { text in
            Task { () -> String? in
                try? await Task.sleep(for: .seconds(options.followUpAfter))
                guard !Task.isCancelled else { return nil }
                let result: HermesWire.PromptSubmitResult? = try? await peer.call(
                    HermesWire.Method.promptSubmit,
                    HermesWire.PromptSubmitParams(sessionID: session.sessionID, text: text, profile: profile)
                )
                emit("\n[follow-up submitted: \(result?.status ?? "failed")]")
                return result?.status
            }
        }
        defer { followingUp?.cancel() }
        var completedTurns = 0

        for path in options.images {
            let file = URL(fileURLWithPath: path)
            guard let original = try? Data(contentsOf: file), let jpeg = ImageDownscaler.jpeg(from: original) else {
                throw UsageError(message: "--image: \(path) is not an image that can be read")
            }
            let attached: HermesWire.ImageAttachResult = try await peer.call(
                HermesWire.Method.imageAttachBytes,
                HermesWire.ImageAttachBytesParams(
                    sessionID: session.sessionID, contentBase64: jpeg.base64EncodedString(),
                    filename: file.deletingPathExtension().lastPathComponent + ".jpg", profile: profile
                ),
                timeout: .seconds(60)
            )
            emit("image: \(attached.name ?? "-") attached=\(attached.attached ?? false) (\(jpeg.count) bytes)\n")
        }

        let submitted: HermesWire.PromptSubmitResult = try await peer.call(
            HermesWire.Method.promptSubmit,
            HermesWire.PromptSubmitParams(sessionID: session.sessionID, text: prompt, profile: profile)
        )
        emit("submitted: \(submitted.status ?? "-")\n")

        for await message in peer.inbound {
            let event: GatewayEvent
            switch message {
            case let .request(request):
                await answer(request, on: peer, options: options)
                continue
            case let .event(received):
                event = received
            }
            guard event.sessionID == nil || event.sessionID == session.sessionID else { continue }
            switch event.type {
            case HermesWire.EventType.messageDelta:
                emit(event.payload["text"]?.stringValue ?? "", terminator: "")
            case HermesWire.EventType.messageComplete:
                emit("\n\n[complete: \(event.payload["status"]?.stringValue ?? "-")]")
                completedTurns += 1
                let queued = await followingUp?.value == "queued"
                if completedTurns >= max(options.turns, queued ? 2 : 1) { return }
                // Staying for turns the host starts itself: what is still at work for
                // this session is worth seeing while it waits.
                let roster: JSONValue? = try? await peer.call(
                    "subagent.list", ["session_id": JSONValue.string(session.sessionID)] as [String: JSONValue]
                )
                emit("\n[subagent.list: \((try? roster?.serialized()) ?? "-")]\n")
            case HermesWire.EventType.error:
                emit("\n[error: \(event.payload["message"]?.stringValue ?? "-")]")
            case HermesWire.EventType.messageStart:
                emit("[message.start]")
            case let type where type.hasPrefix("subagent."):
                let payload = event.payload
                let detail = [payload["tool_name"]?.stringValue, payload["status"]?.stringValue].compactMap(\.self).joined(separator: " ")
                emit("\n[\(type) \(payload["subagent_id"]?.stringValue ?? "?") \(detail)]")
            case "tool.start":
                emit("\n[tool.start \(event.payload["name"]?.stringValue ?? "?")]")
            case "tool.complete":
                emit("[tool.complete \(event.payload["name"]?.stringValue ?? "?"): \(event.payload["summary"]?.stringValue ?? "")]")
            case "reasoning.delta":
                FileHandle.standardError.write(Data((event.payload["text"]?.stringValue ?? "").utf8))
            default:
                FileHandle.standardError.write(Data("[\(event.type)]\n".utf8))
            }
        }
        throw await peer.closeError ?? JSONRPCPeerError.closed
    }
}

/// Writes to standard output without buffering, so streamed text and status lines keep
/// their order when the output is piped.
func emit(_ text: String, terminator: String = "\n") {
    FileHandle.standardOutput.write(Data((text + terminator).utf8))
}

extension Probe {
    static func reattach(_ peer: JSONRPCPeer, storedID: String, lastSeen: Int, options: Arguments.ChatOptions) async throws {
        var resumeParams: [String: JSONValue] = ["session_id": .string(storedID), "inline_images": false]
        if let profile = options.profile { resumeParams["profile"] = .string(profile) }
        let resumed = try await peer.request(HermesWire.Method.sessionResume, params: .object(resumeParams), timeout: .seconds(120))
        let runtimeID = resumed["session_id"]?.stringValue ?? ""
        emit("resumed: runtime=\(runtimeID) running=\(resumed["running"]?.boolValue == true) status=\(resumed["status"]?.stringValue ?? "-") messages=\(resumed["messages"]?.arrayValue?.count ?? 0)")
        emit("inflight: \((try? resumed["inflight"]?.serialized()) ?? "null")")
        emit("open_requests: \((try? resumed["open_requests"]?.serialized()) ?? "none")")

        var sinceParams: [String: JSONValue] = ["session_id": .string(runtimeID), "last_seen": .number(Double(lastSeen))]
        if let profile = options.profile { sinceParams["profile"] = .string(profile) }
        let since = try await peer.request("session.events.since", params: .object(sinceParams))
        let missed = since["events"]?.arrayValue ?? []
        emit("events.since(\(lastSeen)): \(missed.count) events, latest_seq=\(since["latest_seq"]?.intValue ?? -1) truncated=\(since["truncated"]?.boolValue == true) types=\(missed.compactMap { $0["type"]?.stringValue }.prefix(12).joined(separator: ","))")

        // Requests that were open while nobody was attached come back in the result,
        // not as new frames, and are answered by the same id.
        for open in resumed["open_requests"]?.arrayValue ?? [] {
            guard let id = open["id"]?.stringValue, let method = open["method"]?.stringValue else { continue }
            await answer(ServerRequest(id: id, method: method, params: open["params"] ?? .null), on: peer, options: options)
        }
        guard resumed["running"]?.boolValue == true else { return }

        for await message in peer.inbound {
            switch message {
            case let .request(request):
                await answer(request, on: peer, options: options)
            case let .event(event) where event.sessionID == runtimeID:
                switch event.type {
                case HermesWire.EventType.messageDelta:
                    emit(event.payload["text"]?.stringValue ?? "", terminator: "")
                case HermesWire.EventType.messageComplete:
                    emit("\n\n[complete: \(event.payload["status"]?.stringValue ?? "-")]")
                    return
                default:
                    FileHandle.standardError.write(Data("[\(event.type)]\n".utf8))
                }
            case .event:
                continue
            }
        }
    }

    /// How many approvals have been answered, for `--approve a,b,…`.
    nonisolated(unsafe) static var approvalsAnswered = 0

    /// Answers what the gateway asks from the command line's options.
    static func answer(_ request: ServerRequest, on peer: JSONRPCPeer, options: Arguments.ChatOptions) async {
        switch request.method {
        case "approval":
            let choices = options.approval.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            let choice = choices.isEmpty ? "deny" : choices[min(approvalsAnswered, choices.count - 1)]
            approvalsAnswered += 1
            emit("\n[approval \(request.id): \(request.params["command"]?.stringValue ?? "?") -> \(choice)]")
            // "hold" leaves it open, as a phone that went to sleep would.
            if choice != "hold" {
                try? await peer.respond(to: request.id, result: ["choice": .string(choice)])
            }
        case "clarify":
            var answers: [String: JSONValue] = [:]
            for question in request.params["questions"]?.arrayValue ?? [] {
                guard let qid = question["qid"]?.stringValue else { continue }
                answers[qid] = options.answer.map(JSONValue.string) ?? .null
            }
            emit("\n[clarify \(request.id): \(answers.count) question(s) -> \(options.answer ?? "skipped")]")
            try? await peer.respond(to: request.id, result: options.answer == nil ? [:] : ["answers": .object(answers)])
        default:
            emit("\n[server request \(request.method) \(request.id): declined]")
            try? await peer.reject(request.id, code: JSONRPCError.methodNotFoundCode, message: "not supported by portals-probe")
        }
    }
}

// MARK: Arguments

struct UsageError: Error {
    var message: String
}

struct Arguments {
    enum Command {
        case profiles
        case folders(profile: String?)
        case desk(profile: String?)
        case adopt(sessionID: String, mode: AdoptMode, ChatOptions)
        case threads(since: ThreadListRevision?)
        case looks
        case chat(ChatOptions, prompt: String)
        case call(method: String, params: JSONValue)
        case slash(line: String, ChatOptions)
        case reattach(storedID: String, lastSeen: Int, ChatOptions)
    }

    struct ChatOptions {
        var profile: String?
        var cwd: String?
        var model: String?
        var provider: String?
        var approval = "deny"
        var answer: String?
        var interruptAfter: Double?
        /// Image files to send with the prompt, scaled down as the app does.
        var images: [String] = []
        /// A second message, sent while the first is still running.
        var followUp: String?
        var followUpAfter = 2.0
        /// How many turns to stay for. More than one waits for turns the host starts
        /// by itself after the first (background agents reporting back).
        var turns = 1
        /// Commands run in the new session before the prompt (`/mode ask`).
        var slashCommands: [String] = []
    }

    var baseURL = URL(string: "http://127.0.0.1:9119")!
    var token: String?
    var user: String?
    var capturePath: String?
    var command: Command

    init(_ raw: some Sequence<String>) throws {
        var rest = Array(raw)
        var chat = ChatOptions()
        var lastSeen = 0
        var adoptMode = AdoptMode.continue.rawValue
        var listID: String?
        var since: Int?
        var positional: [String] = []

        func value(for option: String) throws -> String {
            guard !rest.isEmpty else { throw UsageError(message: "\(option) needs a value") }
            return rest.removeFirst()
        }

        while !rest.isEmpty {
            let argument = rest.removeFirst()
            switch argument {
            case "--url":
                guard let url = URL(string: try value(for: argument)), url.scheme != nil else {
                    throw UsageError(message: "--url needs a full URL such as http://127.0.0.1:9119")
                }
                baseURL = url
            case "--token":
                token = try value(for: argument)
            case "--user":
                user = try value(for: argument)
            case "--capture":
                capturePath = try value(for: argument)
            case "--profile":
                chat.profile = try value(for: argument)
            case "--mode":
                adoptMode = try value(for: argument)
            case "--list":
                listID = try value(for: argument)
            case "--since":
                guard let revision = Int(try value(for: argument)), revision >= 0 else {
                    throw UsageError(message: "--since needs a revision, 0 or more")
                }
                since = revision
            case "--cwd":
                chat.cwd = try value(for: argument)
            case "--model":
                chat.model = try value(for: argument)
            case "--provider":
                chat.provider = try value(for: argument)
            case "--approve":
                chat.approval = try value(for: argument)
            case "--answer":
                chat.answer = try value(for: argument)
            case "--interrupt-after":
                guard let seconds = Double(try value(for: argument)) else {
                    throw UsageError(message: "--interrupt-after needs a number of seconds")
                }
                chat.interruptAfter = seconds
            case "--last-seen":
                guard let seq = Int(try value(for: argument)) else {
                    throw UsageError(message: "--last-seen needs a sequence number")
                }
                lastSeen = seq
            case "--image":
                chat.images.append(try value(for: argument))
            case "--turns":
                guard let count = Int(try value(for: argument)), count >= 1 else {
                    throw UsageError(message: "--turns needs a number, 1 or more")
                }
                chat.turns = count
            case "--slash":
                chat.slashCommands.append(try value(for: argument))
            case "--follow-up":
                chat.followUp = try value(for: argument)
            case "--follow-up-after":
                guard let seconds = Double(try value(for: argument)) else {
                    throw UsageError(message: "--follow-up-after needs a number of seconds")
                }
                chat.followUpAfter = seconds
            case "-h", "--help":
                throw UsageError(message: "portals-probe: check a Hermes backend from the command line")
            default:
                positional.append(argument)
            }
        }

        switch positional.first {
        case "profiles":
            command = .profiles
        case "folders":
            command = .folders(profile: chat.profile)
        case "desk":
            command = .desk(profile: chat.profile)
        case "adopt":
            guard positional.count >= 2 else { throw UsageError(message: "adopt needs a session id from desk") }
            guard let mode = AdoptMode(rawValue: adoptMode) else { throw UsageError(message: "--mode is continue, fork or read") }
            command = .adopt(sessionID: positional[1], mode: mode, chat)
        case "threads":
            guard (listID == nil) == (since == nil) else { throw UsageError(message: "threads takes --list and --since together") }
            command = .threads(since: listID.flatMap { id in since.map { ThreadListRevision(id: id, revision: $0) } })
        case "looks":
            command = .looks
        case "chat":
            let prompt = positional.dropFirst().joined(separator: " ")
            guard !prompt.isEmpty else { throw UsageError(message: "chat needs a prompt") }
            command = .chat(chat, prompt: prompt)
        case "reattach":
            guard positional.count >= 2 else { throw UsageError(message: "reattach needs a stored session id") }
            command = .reattach(storedID: positional[1], lastSeen: lastSeen, chat)
        case "call":
            guard positional.count >= 2 else { throw UsageError(message: "call needs a method name") }
            let raw = positional.count > 2 ? positional[2] : "{}"
            guard let params = try? JSONValue.parse(raw) else { throw UsageError(message: "params are not valid JSON") }
            command = .call(method: positional[1], params: params)
        case "slash":
            let line = positional.dropFirst().joined(separator: " ")
            guard !line.isEmpty else { throw UsageError(message: "slash needs a command, such as: slash /help") }
            command = .slash(line: line, chat)
        case let other?:
            throw UsageError(message: "unknown command: \(other)")
        case nil:
            throw UsageError(message: "missing command")
        }
    }
}

// MARK: Slash commands

extension Probe {
    /// Runs one slash command the way Hermes's own clients do: `slash.exec` against a
    /// live session, falling back to `command.dispatch` when the slash worker says the
    /// command is not its own (errors 4011 and 4018). Prints the raw answer.
    static func slash(_ peer: JSONRPCPeer, line: String, options: Arguments.ChatOptions) async throws {
        let created: HermesWire.SessionCreateResult = try await peer.call(
            HermesWire.Method.sessionCreate,
            HermesWire.SessionCreateParams(profile: options.profile, source: "tui", cwd: options.cwd, model: options.model, provider: options.provider),
            timeout: .seconds(120)
        )
        emit("answer -> " + (try await runSlash(line, sessionID: created.sessionID, profile: options.profile, on: peer).serialized()))
    }

    /// `slash.exec`, then `command.dispatch` when the host says the command is not its own.
    static func runSlash(_ line: String, sessionID: String, profile: String?, on peer: JSONRPCPeer) async throws -> JSONValue {
        let text = line.hasPrefix("/") ? String(line.dropFirst()) : line
        let parts = text.split(maxSplits: 1, whereSeparator: \.isWhitespace)
        let name = parts.first.map { $0.lowercased() } ?? ""
        let argument = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines) : ""
        var session: [String: JSONValue] = ["session_id": .string(sessionID)]
        if let profile { session["profile"] = .string(profile) }

        do {
            var params = session
            params["command"] = .string(text)
            return try await peer.request("slash.exec", params: .object(params), timeout: .seconds(60))
        } catch let error as JSONRPCError where error.code == 4011 || error.code == 4018 {
            emit("slash.exec refused (\(error.code)): \(error.message)")
            var params = session
            params["name"] = .string(name)
            params["arg"] = .string(argument)
            return try await peer.request("command.dispatch", params: .object(params), timeout: .seconds(60))
        }
    }
}

// MARK: Frame capture

/// Appends frames to a JSON-lines file: `{"dir":"in"|"out","frame":{…}}`.
final class FrameRecorder: Sendable {
    private let handle: FileHandle
    private let lock = NSLock()

    init(path: String) throws {
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else {
            throw UsageError(message: "cannot write to \(path)")
        }
        handle.seekToEndOfFile()
        self.handle = handle
    }

    func record(_ direction: String, _ text: String) {
        // Frames are JSON already; keep them verbatim so fixtures match the wire exactly.
        let line = "{\"dir\":\"\(direction)\",\"frame\":\(text)}\n"
        lock.withLock { handle.write(Data(line.utf8)) }
    }
}

struct RecordingTransport: WebSocketTransport {
    let base: any WebSocketTransport
    let recorder: FrameRecorder

    func send(_ text: String) async throws {
        recorder.record("out", text)
        try await base.send(text)
    }

    func receive() async throws -> String {
        let text = try await base.receive()
        recorder.record("in", text.trimmingCharacters(in: .whitespacesAndNewlines))
        return text
    }

    func close() {
        base.close()
    }

    func checkCarries(_ text: String) throws {
        try base.checkCarries(text)
    }
}
