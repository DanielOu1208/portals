import Foundation

/// A backend with no host behind it: it plays scripted replies. For previews, UI work
/// and tests, where a real agent would be slow, costly and different every time. It keeps
/// no history, but in the demo (`FakeBackend+Demo`), whose host keeps its threads' as a
/// real host does.
public actor FakeBackend: AgentBackend {
    public enum Script: String, CaseIterable, Sendable {
        /// A short streamed reply.
        case greeting
        /// A long reply using every kind of Markdown block.
        case markdown
        /// A reply with formulas inline and on their own lines, in a list, a table and a
        /// quote, among prices and code that are not formulas.
        case math
        /// A turn that retries and then fails.
        case failure
        /// A long wait with status lines before any text.
        case thinking
        /// Reasoning, then a command, a file read and an edit with a diff, then a reply.
        case tools
        /// A coding agent's long run of tool calls with nothing said between them: reads,
        /// three searches run together, edits, tests that fail and then pass, then a reply.
        case longRun
        /// A command that needs approval; what follows depends on the answer.
        case approval
        /// Claude Code in plan mode, as a bridge has it: a mode on the thread, a plan to
        /// start or keep working on, then the work in the mode the thread had before.
        case plan
        /// Two clarifying questions, then a reply that uses the answers.
        case clarify
        /// A reply, then turns the host starts by itself: a background process
        /// finishing, a recurring task coming due.
        case wakeup
        /// Two agents set to work, which carry on after the turn and then report back.
        case delegation
        /// A workflow in two phases with its agents, kept as a bridge keeps one (it can be
        /// opened for its detail), which carries on after the turn and then finishes.
        case workflow
        /// The greeting, with models as a Portals bridge offers Claude Code's: by the
        /// names it gives them, the default an alias named after the model it runs.
        case namedModels
        /// A reply that comes whole, as Claude Code sends one after thinking: a thought, then
        /// the long reply in one piece, and the turn's end right after it.
        case burst
        /// Slash commands as a coding agent on a bridge has them: `/status` answers,
        /// `/compact` runs as a turn that compacts the conversation, `/rename` runs and
        /// says nothing, `/export` fails in its turn, and a name the host does not know
        /// is refused.
        case commands
        /// A reply with a widget in it (`MarkdownWidget`): a savings calculator, or with
        /// "chart" in the message a chart from a CDN, "escape" a page that tries what
        /// widgets may not do, "many" all of them in one reply, "unclosed" a reply that
        /// ends inside one, "stuck" a page whose script never ends, "freeze" one that
        /// does that three seconds after it drew, "throws" one whose script throws,
        /// "huge" one with five thousand rows.
        case widgets
        /// The demo the welcome offers (`FakeBackend+Demo`): Claude Code and Codex in a
        /// made-up project, a tour in its first thread, and a short answer to anything else.
        case demo
    }

    public nonisolated let host: HostID
    public nonisolated let connectionStates: AsyncStream<ConnectionState>

    private struct Binding {
        /// Where whoever follows the thread hears of it: made anew each time it is opened.
        var stream: AsyncStream<ThreadEvent>
        var continuation: AsyncStream<ThreadEvent>.Continuation
        /// The thread's agent, for a script that answers as it.
        var agent: Agent.ID?
        var run: Task<Void, Never>?
        /// A turn has begun and not ended, as the events sent say: what an opened thread is
        /// told, rather than whether its script is still unwinding after its turn's end.
        var isTurnOpen = false
        /// Messages sent during a run, played in order once it ends.
        var queued: [String] = []
    }

    let script: Script
    /// The pause between streamed pieces. Zero plays a script instantly.
    private let pace: Duration
    private let stateContinuation: AsyncStream<ConnectionState>.Continuation
    private var isConnected = false
    private var bindings: [ThreadRef.ID: Binding] = [:]
    /// Scripts paused on a request, by request id, with the thread each plays in: a Stop
    /// ends only its own thread's (the demo has several threads that can wait at once).
    private var waiting: [String: (thread: ThreadRef.ID, continuation: CheckedContinuation<RequestAnswer, Never>)] = [:]
    /// Threads a script has given a title.
    private var titled: Set<ThreadRef.ID> = []
    /// What the demo's host keeps of each of its threads: what was said before the demo
    /// opened, then everything played since, which a thread opened again is given, as a
    /// host gives its copy. Every other script keeps nothing.
    private var histories: [ThreadRef.ID: ThreadState] = [:]

    public init(script: Script = .greeting, host: HostID = HostID(rawValue: "fake"), pace: Duration = .milliseconds(25)) {
        self.script = script
        self.host = host
        self.pace = pace
        (connectionStates, stateContinuation) = AsyncStream.makeStream(of: ConnectionState.self)
        if script == .demo { histories = Self.demoHistories(on: host) }
    }

    public func connect() async throws {
        guard !isConnected else { return }
        stateContinuation.yield(.connecting)
        isConnected = true
        stateContinuation.yield(.connected)
    }

    public func disconnect() async {
        isConnected = false
        bindings.values.forEach { $0.run?.cancel() }
        cancelWaiting()
        stateContinuation.yield(.disconnected(reason: nil))
    }

    public func suspend() async {}
    public func resume() async {}

    /// The four agents of the real setup this app was built for; the demo's two.
    public func listAgents() async throws -> [Agent] {
        guard isConnected else { throw AgentBackendError.notConnected }
        if script == .demo { return Self.demoAgents(on: host) }
        return [
            Agent(id: Agent.ID(host: host, name: "default"), displayName: "Karina", summary: "Runs the house", model: "gpt-6.1-sol", isDefault: true),
            Agent(id: Agent.ID(host: host, name: "aeri"), displayName: "Aeri", summary: "Benchmarks and research", model: "gpt-6.1-sol"),
            Agent(id: Agent.ID(host: host, name: "hanni"), displayName: "Hanni", model: "gpt-6.1-sol"),
            Agent(id: Agent.ID(host: host, name: "wonyoung"), displayName: "Wonyoung", model: "gpt-6.1-sol"),
        ]
    }

    public func createThread(with agent: Agent.ID, options: ThreadOptions) async throws -> ThreadRef {
        guard isConnected else { throw AgentBackendError.notConnected }
        // Unique across launches, as a host's ids are: the app saves threads by id.
        let id = ThreadRef.ID(rawValue: "fake-\(UUID().uuidString.prefix(8).lowercased())")
        let (stream, continuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        bindings[id] = Binding(stream: stream, continuation: continuation, agent: agent)
        if script == .demo { histories[id] = ThreadState() }
        return ThreadRef(id: id, agent: agent, title: options.title, workingDirectory: options.workingDirectory)
    }

    /// The fake keeps no history: an opened thread is empty and ready to continue. The
    /// demo's is as its host kept it.
    public func openThread(_ thread: ThreadRef) async throws -> ThreadSnapshot {
        guard isConnected else { throw AgentBackendError.notConnected }
        bind(thread.id, agent: thread.agent)
        // Followed from now on on a stream of its own: the one before ended with whoever
        // followed it (a thread let go of, then opened again), and takes nothing more.
        bindings[thread.id]?.continuation.finish()
        let (stream, continuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        bindings[thread.id]?.stream = stream
        bindings[thread.id]?.continuation = continuation
        let isRunning = bindings[thread.id]?.isTurnOpen ?? false
        guard let kept = histories[thread.id] else { return ThreadSnapshot(isRunning: isRunning, title: thread.title) }
        return ThreadSnapshot(transcript: kept.transcript, isRunning: isRunning, title: kept.title ?? thread.title, openRequests: kept.openRequests)
    }

    /// Makes the thread's binding, where it has none yet.
    private func bind(_ thread: ThreadRef.ID, agent: Agent.ID?) {
        if bindings[thread] == nil {
            let (stream, continuation) = AsyncStream.makeStream(of: ThreadEvent.self)
            bindings[thread] = Binding(stream: stream, continuation: continuation, agent: agent)
        } else if bindings[thread]?.agent == nil {
            bindings[thread]?.agent = agent
        }
    }

    public func events(for thread: ThreadRef.ID) -> AsyncStream<ThreadEvent> {
        bindings[thread]?.stream ?? AsyncStream { $0.finish() }
    }

    public func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, to thread: ThreadRef.ID
    ) async throws -> SendReceipt {
        guard isConnected else { throw AgentBackendError.notConnected }
        guard let binding = bindings[thread] else { throw AgentBackendError.unknownThread }
        if binding.run != nil {
            // Like Hermes's default: a message sent mid-run waits for the run to end.
            bindings[thread]?.queued.append(text)
            return SendReceipt(.queued)
        }
        play(text, in: thread)
        return SendReceipt(.started)
    }

    @discardableResult
    public func interrupt(_ thread: ThreadRef.ID) async throws -> Bool {
        guard let binding = bindings[thread] else { throw AgentBackendError.unknownThread }
        guard let run = binding.run else { return false }
        run.cancel()
        // Only this thread's: a Stop elsewhere answered the tour's open card as cancelled
        // (bug hunt round 4, KIT1).
        cancelWaiting(in: thread)
        record(.turnFinished(.interrupted, finalText: nil), in: thread)
        bindings[thread]?.isTurnOpen = false
        binding.continuation.yield(.turnFinished(.interrupted, finalText: nil))
        // The queue survives the interrupt: the next message starts its own run.
        finished(thread)
        return true
    }

    public func respond(to request: PendingRequest.ID, in thread: ThreadRef.ID, with answer: RequestAnswer) async throws {
        guard bindings[thread] != nil else { throw AgentBackendError.unknownThread }
        guard let continuation = waiting.removeValue(forKey: request)?.continuation else { throw AgentBackendError.unknownRequest }
        histories[thread]?.requestAnswered(request, with: answer)
        continuation.resume(returning: answer)
    }

    // MARK: Playing a script

    private func play(_ prompt: String, in thread: ThreadRef.ID) {
        if histories[thread] != nil {
            let sent = histories[thread]?.messageSent(prompt)
            if let sent { histories[thread]?.messageDelivered(sent, outcome: .started) }
        }
        let script = script
        start(in: thread) { player in try await Self.perform(script, prompt: prompt, with: player) }
    }

    /// Plays `turn` in `thread` with no message sent to it, as a host starts a turn by
    /// itself (the demo's review, which the tour's agent asks for); not while one runs
    /// there. A thread no one follows yet keeps what is played for whoever opens it.
    func playAside(in thread: ThreadRef.ID, agent: Agent.ID, _ turn: @escaping @Sendable (Player) async throws -> Void) {
        bind(thread, agent: agent)
        guard bindings[thread]?.run == nil else { return }
        start(in: thread, turn)
    }

    private func start(in thread: ThreadRef.ID, _ turn: @escaping @Sendable (Player) async throws -> Void) {
        guard let binding = bindings[thread] else { return }
        let player = Player(backend: self, pace: pace, thread: thread, agent: binding.agent)
        bindings[thread]?.run = Task {
            // A cancelled script (an interrupt) just stops; the interrupt ends the turn.
            try? await turn(player)
            if !Task.isCancelled { self.finished(thread) }
        }
    }

    /// Keeps what a thread was sent in its history, where its host keeps one.
    private func record(_ event: ThreadEvent, in thread: ThreadRef.ID) {
        histories[thread]?.apply(event)
    }

    /// Sends a script's event to whoever follows the thread now, and keeps it in its
    /// history, in one step: an interrupt, which ends the turn itself, comes before it or
    /// after it, never between, and once it has come the script's events go nowhere.
    fileprivate func deliver(_ event: ThreadEvent, in thread: ThreadRef.ID) throws {
        try Task.checkCancellation()
        record(event, in: thread)
        if event.beginsRun {
            bindings[thread]?.isTurnOpen = true
        } else if case .turnFinished = event {
            bindings[thread]?.isTurnOpen = false
        }
        bindings[thread]?.continuation.yield(event)
    }

    /// Whether `thread` is to take a title now: the first time a script asks.
    func takesTitle(_ thread: ThreadRef.ID) -> Bool {
        titled.insert(thread).inserted
    }

    private func finished(_ thread: ThreadRef.ID) {
        bindings[thread]?.run = nil
        guard bindings[thread]?.queued.isEmpty == false, let next = bindings[thread]?.queued.removeFirst() else { return }
        play(next, in: thread)
    }

    fileprivate func answer(to request: String, in thread: ThreadRef.ID) async -> RequestAnswer {
        await withCheckedContinuation { waiting[request] = (thread, $0) }
    }

    /// Answers the scripts paused on a request as cancelled: those in `thread`, or every
    /// one for nil (a disconnect).
    private func cancelWaiting(in thread: ThreadRef.ID? = nil) {
        for (request, wait) in waiting where thread == nil || wait.thread == thread {
            waiting[request] = nil
            wait.continuation.resume(returning: .cancelled)
        }
    }

    /// What a script does to the thread.
    struct Player: Sendable {
        let backend: FakeBackend
        fileprivate let pace: Duration
        /// The thread it plays in, and its agent.
        let thread: ThreadRef.ID
        let agent: Agent.ID?

        /// Waits `pauses` paces, then sends `event`. Throws once the run is cancelled.
        func emit(_ event: ThreadEvent, after pauses: Int = 0) async throws {
            if pauses > 0, pace > .zero {
                try await Task.sleep(for: pace * pauses)
            }
            try await backend.deliver(event, in: thread)
        }

        /// Streams `text` as deltas of a few characters each.
        func stream(_ text: String) async throws {
            var rest = Substring(text)
            var size = 3
            while !rest.isEmpty {
                let piece = rest.prefix(size)
                try await emit(.textDelta(String(piece)), after: 1)
                rest = rest.dropFirst(piece.count)
                size = size % 7 + 2 // uneven pieces, like a real stream
            }
        }

        /// Streams `text` as reasoning, a word at a time.
        func think(_ text: String) async throws {
            for word in text.split(separator: " ") {
                try await emit(.reasoningDelta(word + " "), after: 1)
            }
        }

        /// Asks the user and waits for the answer.
        func ask(_ request: PendingRequest) async throws -> RequestAnswer {
            try await emit(.requestOpened(request))
            let answer = await backend.answer(to: request.id, in: thread)
            try Task.checkCancellation()
            return answer
        }

        /// Streams the closing text and ends the turn.
        func finish(_ text: String, context: ContextUsage = ContextUsage(used: 248_000, limit: 400_000)) async throws {
            try await stream(text)
            try await emit(.contextChanged(context))
            try await emit(.turnFinished(.completed, finalText: nil), after: 1)
        }
    }

    // MARK: Scripts

    static func perform(_ script: Script, prompt: String, with player: Player) async throws {
        switch script {
        case .demo:
            try await performDemo(prompt: prompt, with: player)

        case .greeting, .namedModels:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("A quick hello"), after: 12)
            try await player.finish("Hello! I'm here and ready. You said: \u{201C}\(prompt)\u{201D}. What should we work on?")

        case .markdown:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Markdown showcase"), after: 12)
            try await player.finish(markdownShowcase)

        case .burst:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("A reply at once"), after: 4)
            try await player.think("I will explain it in a few paragraphs.")
            try await player.emit(.textDelta(markdownShowcase), after: 30)
            try await player.emit(.turnFinished(.completed, finalText: nil), after: 1)

        case .math:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Quadratic roots"), after: 12)
            try await player.finish(mathShowcase)

        case .widgets:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Visuals"), after: 12)
            // As an agent is told to: the words before the visual first, then the guide,
            // then a while planning the visual (Claude takes minutes), then the visual.
            let reply = widgetReply(prompt)
            let fence = reply.range(of: "```portals-visual")?.lowerBound ?? reply.endIndex
            try await player.stream(String(reply[..<fence]))
            let guide = #""/Users/you/Library/Application Support/portals-bridge/bin/portals" guide visuals"#
            try await player.emit(.toolStarted(ToolRun(id: "w1", name: "terminal", label: guide, input: guide)), after: 4)
            try await player.emit(.toolFinished(ToolResult(id: "w1", name: "terminal", succeeded: true, duration: 0.2, output: "portals guide visuals: how to show a visual in a reply.")), after: 8)
            try await player.emit(.status(nil), after: prompt.lowercased().contains("quick") ? 8 : 120)
            try await player.finish(String(reply[fence...]))

        case .delegation:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Hardware research"), after: 8)
            try await player.emit(.toolStarted(ToolRun(id: "d1", name: "delegate_task", label: "2 tasks")), after: 6)
            try await player.emit(.subagent(Subagent(id: "sa-0", goal: "Research used datacenter GPUs under $500 that can run a 30B model")), after: 4)
            try await player.emit(.subagent(Subagent(id: "sa-1", goal: "Audit the plausible cheap non-GPU candidates")), after: 2)
            try await player.emit(.toolFinished(ToolResult(id: "d1", name: "delegate_task", succeeded: true, duration: 0.3)), after: 6)
            try await player.finish("Two agents are on it. I'll report when they are back.")
            try await player.emit(.subagent(Subagent(id: "sa-0", goal: "", tool: "web_search", toolDetail: "used Tesla P40 price 2026")), after: 40)
            try await player.emit(.subagent(Subagent(id: "sa-1", goal: "", tool: "terminal", toolDetail: "python bench.py --cpu")), after: 40)
            try await player.emit(.subagent(Subagent(id: "sa-1", goal: "", state: .finished)), after: 320)
            try await player.emit(.subagent(Subagent(id: "sa-0", goal: "", state: .finished)), after: 160)
            try await player.emit(.announced(HostEvent(.backgroundAgents, "Subagent Tasks Completed: Hardware research (2 tasks)")), after: 8)
            try await player.emit(.turnStarted, after: 4)
            try await player.finish("Both are back. The P40 is the best value under $500; none of the non-GPU options is worth it.")

        case .workflow:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Review the changes"), after: 8)
            let started = Date.now
            // A host that keeps a workflow says all of it each time.
            func workflow(_ state: Subagent.State, _ agents: [WorkflowAgent], result: String? = nil) -> Subagent {
                Subagent(
                    id: "wf-1", goal: "Review the changed files, then verify each finding", state: state, kind: .workflow,
                    name: "review-changes", startedAt: started, endedAt: state == .working ? nil : .now, result: result,
                    // Not stoppable: the scripted backend has no way to stop one, and a Stop
                    // that did nothing would read as a bug of the app's.
                    canStop: false, model: "claude-opus-5-5", tokens: agents.compactMap(\.tokens).reduce(0, +),
                    phases: [WorkflowPhase(index: 0, title: "Review"), WorkflowPhase(index: 1, title: "Verify")], agents: agents
                )
            }
            let reviewers = ["bugs", "performance", "tests"]
            func reviewing(_ state: Subagent.State) -> [WorkflowAgent] {
                reviewers.map { name in
                    WorkflowAgent(
                        id: "review-\(name)", label: "review:\(name)", phase: "Review", model: "claude-opus-5-5", state: state,
                        tokens: state == .finished ? 18_400 : nil, duration: state == .finished ? 42 : nil,
                        result: state == .finished ? "Two findings in \(name), one likely real." : nil
                    )
                }
            }
            let verifying = [
                WorkflowAgent(id: "verify-1", label: "verify:Sidebar.swift", phase: "Verify", model: "claude-sonnet-5-5", state: .working)
            ]
            try await player.emit(.subagent(workflow(.working, reviewing(.working))), after: 4)
            try await player.finish("Started a review workflow. I'll report when it is done.")
            try await player.emit(.subagent(workflow(.working, reviewing(.finished) + verifying)), after: 120)
            let verified = verifying.map { agent in
                var agent = agent
                agent.state = .finished
                agent.tokens = 9_100
                agent.duration = 31
                agent.result = "Confirmed: the row keeps its old group's id."
                return agent
            }
            try await player.emit(.subagent(workflow(.finished, reviewing(.finished) + verified, result: "One finding confirmed.")), after: 200)

        case .wakeup:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Tests in the background"), after: 8)
            try await player.finish("Started the tests in the background. I'll look again when they finish.")
            try await player.emit(.announced(HostEvent(.backgroundProcess, "Background Process Finished: pytest -q")), after: 60)
            try await player.emit(.turnStarted, after: 4)
            try await player.emit(.toolStarted(ToolRun(id: "w1", name: "read_file", label: "pytest.log")), after: 6)
            try await player.emit(.toolFinished(ToolResult(id: "w1", name: "read_file", succeeded: true, duration: 0.02, output: "14 passed in 1.88s")), after: 12)
            try await player.finish("The tests finished: all 14 pass.")
            try await player.emit(.announced(HostEvent(.recurringTask, "Recurring task #1 · every 5m: Check the deploy")), after: 60)
            try await player.emit(.turnStarted, after: 4)
            try await player.finish("The deploy is still rolling out; two of three instances are up.")

        case .thinking:
            try await player.emit(.turnStarted)
            try await player.emit(.status("Reading the repository"), after: 20)
            try await player.emit(.status("Running the tests"), after: 60)
            try await player.emit(.status(nil), after: 60)
            try await player.emit(.titleChanged("A slow answer"))
            try await player.finish("That took a while, but everything passes.")

        case .failure:
            try await player.emit(.turnStarted)
            try await player.emit(.notice(Notice(.warning, "Title generation failed: the model is not available.")), after: 10)
            try await player.emit(.status("Waiting on the provider, retrying in 2s (attempt 1/3)"), after: 20)
            try await player.emit(.status("Waiting on the provider, retrying in 5s (attempt 2/3)"), after: 40)
            try await player.emit(.turnFinished(
                .failed(TurnFailure(
                    message: "The provider didn't answer after 3 attempts. Wait a minute and try again.",
                    detail: "HTTP 404: No matching target server found",
                    retryable: true
                )),
                finalText: nil
            ), after: 40)

        case .tools:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Fix the push plugin"), after: 8)
            try await player.think("The token is read after the routes are registered, so the first request sees nothing. I should confirm with the tests, read the file, then move the call.")
            // Said on the way, the way a Codex model's commentary comes: not streamed.
            try await player.emit(.interimText("I'll run the tests first to see what fails.", alreadyStreamed: false), after: 6)
            try await player.emit(.toolStarted(ToolRun(id: "t1", name: "terminal", label: "pytest -q", input: "pytest -q")), after: 10)
            try await player.emit(.toolFinished(ToolResult(
                id: "t1", name: "terminal", succeeded: false, duration: 2.1,
                output: "F.............                                                   [100%]\n1 failed, 13 passed in 1.92s"
            )), after: 40)
            try await player.emit(.toolStarted(ToolRun(id: "t2", name: "read_file", label: "plugin.py")), after: 6)
            try await player.emit(.toolFinished(ToolResult(
                id: "t2", name: "read_file", succeeded: true, duration: 0.01,
                output: "1|def register(ctx):\n2|    ctx.register_hook(\"on_session_end\", notify)\n3|    token = load_token()"
            )), after: 10)
            try await player.stream("The call is in the wrong place. Moving it.\n\n")
            try await player.emit(.interimText("The call is in the wrong place. Moving it.", alreadyStreamed: true))
            try await player.emit(.toolStarted(ToolRun(id: "t3", name: "patch", label: "plugin.py")), after: 6)
            try await player.emit(.toolFinished(ToolResult(id: "t3", name: "patch", succeeded: true, duration: 0.12, diff: sampleDiff)), after: 20)
            try await player.emit(.toolStarted(ToolRun(id: "t4", name: "terminal", label: "pytest -q", input: "pytest -q")), after: 6)
            try await player.emit(.toolFinished(ToolResult(
                id: "t4", name: "terminal", succeeded: true, duration: 1.9,
                output: "..............                                                   [100%]\n14 passed in 1.88s"
            )), after: 40)
            try await player.finish("Fixed. The plugin now loads the token **before** it registers the routes, and all 14 tests pass.")

        case .longRun:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Retry failed pushes"), after: 8)
            func step(_ run: ToolRun, _ result: ToolResult, after pause: Int) async throws {
                try await player.emit(.toolStarted(run), after: 6)
                try await player.emit(.toolFinished(result), after: pause)
            }
            // Thoughts between the steps, with nothing said: the room under the status line
            // (with Show thinking on) stays open and empty while the tools run.
            try await player.think("Pushes that fail are dropped today. I want to see where the notifier sends them and what Apple answers, so I will read the notifier first and then the code that talks to Apple, before deciding where a retry belongs.")
            try await step(ToolRun(id: "r1", name: "read_file", label: "notifier.ts"), ToolResult(id: "r1", name: "read_file", succeeded: true, duration: 0.02, output: "export class Notifier {"), after: 20)
            try await step(ToolRun(id: "r2", name: "read_file", label: "apns.ts"), ToolResult(id: "r2", name: "read_file", succeeded: true, duration: 0.02, output: "export async function send("), after: 20)
            try await player.think("The sender gives up at the first error. A 410 means the token is gone and should not be retried; anything else could be tried again with a backoff. Let me look for an existing retry or backoff helper before writing one.")
            // Three searches at once: the status line counts the others while they run.
            for (id, pattern) in [("s1", "retry"), ("s2", "backoff"), ("s3", "410")] {
                try await player.emit(.toolStarted(ToolRun(id: id, name: "search_files", label: pattern)), after: 4)
            }
            for id in ["s2", "s1", "s3"] {
                try await player.emit(.toolFinished(ToolResult(id: id, name: "search_files", succeeded: true, duration: 0.3, output: "2 matches")), after: 20)
            }
            try await step(ToolRun(id: "e1", name: "patch", label: "notifier.ts"), ToolResult(id: "e1", name: "patch", succeeded: true, duration: 0.1, diff: sampleDiff), after: 20)
            try await step(
                ToolRun(id: "c1", name: "terminal", label: "npm test", input: "npm test"),
                ToolResult(id: "c1", name: "terminal", succeeded: false, duration: 4.2, output: "1 failing: a gone device is retried"),
                after: 40
            )
            try await step(ToolRun(id: "e2", name: "patch", label: "notifier.ts"), ToolResult(id: "e2", name: "patch", succeeded: true, duration: 0.1, diff: sampleDiff), after: 20)
            try await step(
                ToolRun(id: "c2", name: "terminal", label: "npm test", input: "npm test"),
                ToolResult(id: "c2", name: "terminal", succeeded: true, duration: 4.0, output: "312 passing"),
                after: 40
            )
            try await player.finish("Failed pushes are retried with backoff now, and a device Apple says is gone is never retried. All 312 tests pass.")

        case .plan:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Retry failed pushes"), after: 8)
            try await player.emit(.modeChanged(ModeState(mode: .plan, defaultsTo: .full)))
            try await player.think("Read the notifier and the APNs sender first, then write the plan.")
            try await player.emit(.toolStarted(ToolRun(id: "p1", name: "read_file", label: "notifier.ts")), after: 6)
            try await player.emit(.toolFinished(ToolResult(id: "p1", name: "read_file", succeeded: true, duration: 0.02)), after: 10)
            let answer = try await player.ask(PendingRequest(
                id: "srq-fake-plan",
                kind: .approval(ApprovalRequest(
                    command: """
                    # Retry failed pushes

                    1. **Back off** in `apns.ts`: retry a failed send after 1, 2 and 4 seconds.
                    2. **Forget gone devices**: a 410 from Apple removes the device instead of retrying.
                    3. **Test both paths** in `notifier.test.ts` against the stand-in APNs server.

                    Nothing else changes; the push store keeps its format.
                    """,
                    reason: "Claude has a plan",
                    choices: [.once, .deny],
                    plan: PlanApproval(startsIn: .settings)
                ))
            ))
            if case .approval(.once) = answer {
                try await player.emit(.modeChanged(ModeState(mode: .settings, defaultsTo: .full)))
                try await player.emit(.toolStarted(ToolRun(id: "p2", name: "patch", label: "apns.ts")), after: 6)
                try await player.emit(.toolFinished(ToolResult(id: "p2", name: "patch", succeeded: true, duration: 0.1, diff: sampleDiff)), after: 20)
                try await player.finish("Done: failed pushes back off and retry, and a device Apple says is gone is dropped.")
            } else {
                try await player.finish("Understood, I'll keep planning. What would you like to change?")
            }

        case .approval:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Clean the build folder"), after: 8)
            try await player.stream("I'll clear the old build output first.\n\n")
            let command = "rm -rf build"
            try await player.emit(.toolStarted(ToolRun(id: "t1", name: "terminal", label: command, input: command)), after: 6)
            let answer = try await player.ask(PendingRequest(
                id: "srq-fake-1",
                kind: .approval(ApprovalRequest(command: command, reason: "recursive delete"))
            ))
            if case let .approval(choice) = answer, choice != .deny {
                try await player.emit(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true, duration: 0.2, output: "")), after: 10)
                try await player.finish("Done. The build folder is gone, so the next build starts clean.")
            } else {
                try await player.emit(.toolFinished(ToolResult(
                    id: "t1", name: "terminal", succeeded: false, duration: 0.1,
                    output: "You denied this command. It did not run."
                )), after: 4)
                try await player.finish("Understood. I left the build folder alone.")
            }

        case .commands:
            // An agent's own command comes as the message that names it.
            try await player.emit(.turnStarted)
            switch SlashInput(prompt)?.name {
            case "compact":
                try await player.emit(.status("Compacting the conversation…"), after: 8)
                try await player.emit(.status(nil), after: 240)
                try await player.emit(.compacted(Compaction(.manual, tokensBefore: 120_345)))
                try await player.emit(.contextChanged(ContextUsage(used: 9_800, limit: 400_000)))
                try await player.emit(.turnFinished(.completed, finalText: nil), after: 1)
            case "export":
                try await player.emit(.turnFinished(.failed(TurnFailure(message: "No messages to export.", retryable: false)), finalText: nil), after: 20)
            case .some:
                try await player.emit(.turnFinished(.completed, finalText: nil), after: 20)
            case nil:
                try await player.finish("Try /status, /compact, /rename, /export, or a command this host does not know.")
            }

        case .clarify:
            try await player.emit(.turnStarted)
            try await player.emit(.titleChanged("Pick a language"), after: 8)
            let answer = try await player.ask(PendingRequest(
                id: "srq-fake-2",
                kind: .clarify([
                    ClarifyQuestion(
                        id: "q0", text: "Which language should I use?", choices: ["Python (Recommended)", "Swift"], header: "Language",
                        descriptions: [
                            "Python (Recommended)": "Quick to write, and already installed on the Mac",
                            "Swift": "Compiled and typed, faster for big inputs",
                        ]
                    ),
                    ClarifyQuestion(id: "q1", text: "What should the script be called?", header: "Name"),
                ])
            ))
            if case let .clarify(answers) = answer, !answers.isEmpty {
                let language = answers["q0"] ?? "your choice"
                let name = answers["q1"].map { " called `\($0)`" } ?? ""
                try await player.finish("Got it. I'll write it in \(language)\(name).")
            } else {
                try await player.finish("No problem. I'll pick sensible defaults and tell you what I chose.")
            }
        }
    }

    /// The `widgets` script's reply to `prompt`.
    public static func widgetReply(_ prompt: String) -> String {
        let words = prompt.lowercased()
        func fence(_ title: String, _ html: String) -> String { "```portals-visual title=\"\(title)\"\n\(html)\n```" }
        if words.contains("unclosed") { return "Here is a visual that never ends:\n\n```portals-visual title=\"Cut short\"\n<div>Half a wid" }
        if words.contains("many") {
            return [
                "Several visuals in one reply.", fence("Savings", savingsWidget), fence("Latency this week", chartWidget),
                "Between them, some text.", fence("Sandbox check", escapeWidget), "That is all of them.",
            ].joined(separator: "\n\n")
        }
        if words.contains("stuck") { return "This page's script never ends:\n\n\(fence("Never ends", stuckWidget))\n\nThe app gives up on it after a while." }
        if words.contains("freeze") { return "This page draws, then its script runs without end three seconds later:\n\n\(fence("Freezes later", freezeWidget))\n\nIt stands still from then on." }
        if words.contains("throws") { return "This page's script throws halfway:\n\n\(fence("Throws", throwsWidget))\n\nWhat came before the error is drawn." }
        if words.contains("huge") { return "A page with five thousand rows:\n\n\(fence("Five thousand rows", hugeWidget))\n\nIt scrolls inside its card." }
        if words.contains("diagram") { return "A graph drawn as it is written, with no script:\n\n\(fence("Five nodes", diagramWidget))\n\nEach edge is a line between two circles." }
        if words.contains("frames") { return "This page counts its own frames, timers and animation:\n\n\(fence("Frame counter", framesWidget(1)))\n\nOff screen, the counts should stand still." }
        if words.contains("gallery") {
            // Ten pages, apart from one another by more than a screen of text: for the pool's
            // limit, pausing off screen, and visuals drawn again as they come back.
            let filler = (1...6).map { "Paragraph \($0) between visuals, to put a screen of text between one and the next so that each is out of view while another is in it." }.joined(separator: "\n\n")
            return (1...10).map { "Visual \($0) of ten.\n\n\(fence("Frame counter \($0)", framesWidget($0)))\n\n\(filler)" }.joined(separator: "\n\n")
        }
        if words.contains("chart") { return "Last week's latency, drawn with Chart.js:\n\n\(fence("Latency this week", chartWidget))\n\nThe weekend is slower." }
        if words.contains("escape") { return "This page tries what a visual may not do:\n\n\(fence("Sandbox check", escapeWidget))\n\nEvery line should say blocked." }
        return "Move the sliders to see how savings grow:\n\n\(fence("Savings over ten years", savingsWidget))\n\nA higher rate matters more in the later years."
    }

    /// A page whose script never ends as it loads: it never loads, and holds its process.
    static let stuckWidget = #"""
        <p>Before the script.</p>
        <script>
          for (;;) {}
        </script>
        <p>After it, never drawn.</p>
        """#

    /// A page that draws, then three seconds on runs a script without end.
    static let freezeWidget = #"""
        <p>Seconds: <b id="s">0</b></p>
        <script>
          let s = 0;
          const tick = setInterval(() => { s += 1; document.getElementById("s").textContent = s; if (s === 3) { clearInterval(tick); for (;;) {} } }, 1000);
        </script>
        """#

    /// A page whose script throws after drawing part of it.
    static let throwsWidget = #"""
        <p id="a">Drawn before the error.</p>
        <script>
          document.getElementById("a").textContent = "Drawn by the script before it threw.";
          null.nothing();
          document.getElementById("a").textContent = "Never reached.";
        </script>
        """#

    /// A page with five thousand rows, made by its script.
    static let hugeWidget = #"""
        <ol id="rows" style="margin: 0; padding-left: 3em;"></ol>
        <script>
          document.getElementById("rows").innerHTML = Array.from({ length: 5000 }, (_, i) => `<li>Row ${i + 1}: ${"lorem ipsum ".repeat(4)}</li>`).join("");
        </script>
        """#

    static let savingsWidget = #"""
        <div class="calc">
          <label>Monthly <input id="monthly" type="range" min="50" max="2000" step="50" value="500"><output id="monthlyOut"></output></label>
          <label>Rate <input id="rate" type="range" min="0" max="12" step="0.5" value="5"><output id="rateOut"></output></label>
          <div class="bars" id="bars"></div>
          <p class="total">After ten years: <strong id="total"></strong></p>
        </div>
        <style>
          .calc label { display: grid; grid-template-columns: 5em 1fr 4.5em; align-items: center; gap: 8px; margin: 4px 0; color: var(--portals-text-2); }
          .calc input { width: 100%; accent-color: var(--portals-accent); }
          .calc output { text-align: right; color: var(--portals-text); font-variant-numeric: tabular-nums; }
          .bars { display: flex; align-items: flex-end; gap: 4px; height: 140px; margin: 12px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--portals-line); }
          .bars div { flex: 1; border-radius: 4px 4px 0 0; background: var(--portals-series-1); }
          .bars div:nth-child(even) { background: var(--portals-series-2); }
          .total { margin: 8px 0 0; }
        </style>
        <script>
          const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
          function draw() {
            const monthly = +document.getElementById("monthly").value;
            const rate = +document.getElementById("rate").value / 100;
            document.getElementById("monthlyOut").textContent = money(monthly);
            document.getElementById("rateOut").textContent = (rate * 100).toFixed(1) + "%";
            let total = 0;
            const years = [];
            for (let year = 1; year <= 10; year++) {
              for (let month = 0; month < 12; month++) total = total * (1 + rate / 12) + monthly;
              years.push(total);
            }
            document.getElementById("bars").innerHTML = years.map((t) => `<div style="height: ${(t / total) * 100}%"></div>`).join("");
            document.getElementById("total").textContent = money(total);
          }
          for (const input of document.querySelectorAll(".calc input")) input.addEventListener("input", draw);
          draw();
        </script>
        """#

    static let chartWidget = #"""
        <canvas></canvas>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
        <script>
          const css = getComputedStyle(document.documentElement);
          const color = (name) => css.getPropertyValue(name).trim();
          Chart.defaults.color = color("--portals-text-2");
          Chart.defaults.borderColor = color("--portals-line");
          Chart.defaults.font.family = color("--portals-font");
          const line = (label, data, series) => ({ label, data, borderColor: color(series), backgroundColor: color(series), tension: 0.3 });
          new Chart(document.querySelector("canvas"), {
            type: "line",
            data: {
              labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
              datasets: [line("p50 (ms)", [120, 132, 101, 134, 90, 230, 210], "--portals-series-1"), line("p95 (ms)", [220, 182, 191, 234, 290, 330, 310], "--portals-series-2")],
            },
            options: { aspectRatio: 2, interaction: { mode: "index", intersect: false } },
          });
        </script>
        """#

    /// A graph in SVG with no script: drawn while it is written.
    static let diagramWidget = #"""
        <style>
          .g line { stroke: var(--portals-line); stroke-width: 2.5; }
          .g circle { fill: var(--portals-surface); stroke: var(--portals-accent); stroke-width: 2.5; }
          .g text { font: 600 15px var(--portals-font); fill: var(--portals-text); text-anchor: middle; dominant-baseline: central; }
          .g .w { font: 500 13px var(--portals-mono); fill: var(--portals-text-2); }
        </style>
        <svg class="g" viewBox="0 0 360 220" width="100%">
          <line x1="50" y1="110" x2="150" y2="40"/>
          <line x1="50" y1="110" x2="150" y2="180"/>
          <line x1="150" y1="40" x2="150" y2="180"/>
          <line x1="150" y1="40" x2="260" y2="60"/>
          <line x1="150" y1="180" x2="260" y2="160"/>
          <line x1="260" y1="60" x2="320" y2="110"/>
          <line x1="260" y1="160" x2="320" y2="110"/>
          <text class="w" x="92" y="64">4</text>
          <text class="w" x="92" y="156">1</text>
          <text class="w" x="164" y="110">2</text>
          <text class="w" x="205" y="38">5</text>
          <text class="w" x="205" y="184">8</text>
          <text class="w" x="302" y="76">3</text>
          <text class="w" x="302" y="146">6</text>
          <circle cx="50" cy="110" r="20"/><text x="50" y="110">A</text>
          <circle cx="150" cy="40" r="20"/><text x="150" y="40">B</text>
          <circle cx="150" cy="180" r="20"/><text x="150" y="180">C</text>
          <circle cx="260" cy="60" r="20"/><text x="260" y="60">D</text>
          <circle cx="260" cy="160" r="20"/><text x="260" y="160">E</text>
          <circle cx="320" cy="110" r="20"/><text x="320" y="110">F</text>
        </svg>
        """#

    /// A page that counts its animation frames and timer ticks and spins a box with CSS,
    /// as a visual that never stops moving does: whether it goes on out of view shows in
    /// its counts when it comes back. `number` makes each one its own page.
    static func framesWidget(_ number: Int) -> String {
        #"""
        <style>
          .fc { display: flex; align-items: center; gap: 14px; }
          .fc .spin { width: 28px; height: 28px; border-radius: 6px; background: var(--portals-series-\#((number - 1) % 6 + 1)); animation: fc-spin 1.2s linear infinite; }
          @keyframes fc-spin { to { transform: rotate(360deg); } }
          .fc p { margin: 2px 0; font-variant-numeric: tabular-nums; }
        </style>
        <div class="fc"><div class="spin"></div><div>
          <p>Page \#(number). Frames: <b id="frames">0</b></p>
          <p>Timer ticks: <b id="ticks">0</b></p>
          <p>Seconds open: <b id="open">0</b></p>
        </div></div>
        <script>
          const started = Date.now();
          let frames = 0, ticks = 0;
          const frame = () => { frames += 1; if (frames % 10 === 0) document.getElementById("frames").textContent = frames; requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
          setInterval(() => { ticks += 1; document.getElementById("ticks").textContent = ticks; document.getElementById("open").textContent = Math.round((Date.now() - started) / 1000); }, 100);
        </script>
        """#
    }

    static let escapeWidget = #"""
        <ul id="tries"></ul>
        <style>#tries { margin: 0; padding-left: 1.2em; } #tries li { margin: 4px 0; }</style>
        <script>
          const tries = document.getElementById("tries");
          const say = (what, result) => { const li = document.createElement("li"); li.textContent = what + ": " + result; tries.appendChild(li); };
          const within = (ms, what, attempt) => {
            let settled = false;
            const done = (result) => { if (!settled) { settled = true; say(what, result); } };
            try { attempt(done); } catch (error) { done("blocked"); }
            setTimeout(() => done("blocked (no answer)"), ms);
          };
          within(4000, "fetch from example.com", (done) => fetch("https://example.com/").then(() => done("WENT THROUGH"), () => done("blocked")));
          within(4000, "fetch from jsDelivr", (done) => fetch("https://cdn.jsdelivr.net/npm/chart.js@4/package.json").then(() => done("WENT THROUGH"), () => done("blocked")));
          within(4000, "XMLHttpRequest", (done) => { const x = new XMLHttpRequest(); x.onload = () => done("WENT THROUGH"); x.onerror = () => done("blocked"); x.open("GET", "https://example.com/"); x.send(); });
          within(4000, "WebSocket", (done) => { const s = new WebSocket("wss://echo.websocket.org/"); s.onopen = () => done("WENT THROUGH"); s.onerror = () => done("blocked"); });
          within(4000, "image from apple.com", (done) => { const i = new Image(); i.onload = () => done("WENT THROUGH"); i.onerror = () => done("blocked"); i.src = "https://www.apple.com/favicon.ico"; });
          within(4000, "script from another host", (done) => { const s = document.createElement("script"); s.onload = () => done("WENT THROUGH"); s.onerror = () => done("blocked"); s.src = "https://code.jquery.com/jquery-3.7.1.min.js"; document.head.appendChild(s); });
          within(4000, "frame", (done) => { const f = document.createElement("iframe"); f.style.display = "none"; f.src = "https://example.com/"; f.onload = () => { try { done(f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerHTML ? "WENT THROUGH" : "blocked"); } catch (error) { done("blocked"); } }; document.body.appendChild(f); });
          within(1000, "WebRTC (STUN, TURN)", (done) => done(typeof RTCPeerConnection === "function" || typeof webkitRTCPeerConnection === "function" ? "WENT THROUGH" : "blocked"));
          within(1000, "WebRTC in a frame", (done) => { const f = document.createElement("iframe"); f.style.display = "none"; document.body.appendChild(f); done(typeof f.contentWindow.RTCPeerConnection === "function" ? "WENT THROUGH" : "blocked"); });
          within(1000, "pop-up", (done) => done(window.open("https://example.com/") ? "WENT THROUGH" : "blocked"));
          within(1000, "alert", (done) => { const before = Date.now(); alert("If you see this, alert went through."); done(Date.now() - before > 500 ? "WENT THROUGH" : "blocked"); });
          setTimeout(() => { location.href = "https://example.com/"; }, 1500);
          setTimeout(() => say("navigation", "blocked (this page is still here)"), 3000);
        </script>
        """#

    /// A reply that uses every kind of Markdown block.
    public static let markdownShowcase = """
        ## What I found

        The push plugin loads the token **after** it registers the routes, so the first \
        request sees `None`. Details are in [the plugin docs](https://example.com/plugins).

        1. Move `load_token()` above the route setup.
        2. Add a test for the cold start.
           - It should fail on the old code.
           - It should pass on the new code.

        ```python
        def register(ctx):
            token = load_token()  # was after the routes
            ctx.register_hook("on_session_end", notify)
        ```

        | File | Change |
        |------|--------|
        | `plugin.py` | +4 −1 |
        | `test_plugin.py` | +18 |

        > Nothing else in the plugin reads the token before `register` returns.

        ---

        All 14 tests pass.
        """

    /// A reply with formulas wherever they can be: inline and display, both ways of
    /// writing each, in a heading, a list, a table and a quote, a display and an inline
    /// one too wide for the screen, and one SwiftMath cannot read. Its prices and the code
    /// span with dollars in it are not formulas.
    public static let mathShowcase = #"""
        ## Roots of $ax^2 + bx + c$

        For $ax^2 + bx + c = 0$ with $a \neq 0$, the roots are

        $$
        x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
        $$

        The discriminant \(\Delta = b^2 - 4ac\) says how many there are:

        1. If $\Delta > 0$, two real roots.
        2. If $\Delta = 0$, one: \(x = -\frac{b}{2a}\).
        3. If $\Delta < 0$, a complex pair:
           \[
           x = -\frac{b}{2a} \pm \frac{\sqrt{-\Delta}}{2a}\,i
           \]

        | Equation | $\Delta$ | Roots |
        |----------|----------|-------|
        | $x^2 - 1 = 0$ | $4$ | $\pm 1$ |
        | $x^2 + 1 = 0$ | $-4$ | $\pm i$ |

        > The identity $e^{i\pi} + 1 = 0$ is $e^{i\theta} = \cos\theta + i\sin\theta$ at $\theta = \pi$.

        The vertex is where the slope $f'(x) = 2ax + b$ is zero, and a polynomial of degree $n$ is $p(x) = a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + \cdots + a_n x^n$. In $(1 + x)^n$ the coefficient of $x^k$ is $\dbinom{n}{k}$.

        Expanding a square, step by step:

        $$
        \begin{align}
        (x + 1)^2 &= (x + 1)(x + 1) \\
        &= x^2 + 2x + 1 \tag{1}
        \end{align}
        $$

        A long sum scrolls sideways:

        $$\sum_{n=1}^{\infty} \frac{1}{n^2} = 1 + \frac{1}{4} + \frac{1}{9} + \frac{1}{16} + \frac{1}{25} + \frac{1}{36} + \cdots = \frac{\pi^2}{6}$$

        Prices stay text: the course is $5 and the book $10. In a shell, `echo "$HOME costs $5"` prints the folder. A command SwiftMath does not know shows as written: $\unknowncommand{x}$.
        """#

    /// A small unified diff, as a patch tool reports it.
    public static let sampleDiff = """
        --- a/plugin.py
        +++ b/plugin.py
        @@ -1,3 +1,3 @@
         def register(ctx):
        -    ctx.register_hook("on_session_end", notify)
        -    token = load_token()
        +    token = load_token()
        +    ctx.register_hook("on_session_end", notify)
        """
}

// MARK: - Models

extension FakeBackend: ModelSelecting {
    public func modelCatalog(for agent: Agent.ID) async throws -> ModelCatalog {
        if script == .demo { return Self.demoModels(for: agent) }
        if script == .plan {
            // Claude Code on a bridge: its threads take a mode, and the user's settings come to full access.
            return ModelCatalog(
                providers: [ModelProvider(id: "anthropic", name: "Claude", models: ["default", "sonnet"])],
                agentDefault: ModelSetting(model: "default", provider: "anthropic", level: .extraHigh),
                namesByModel: ["default": "Opus 5.5", "sonnet": "Sonnet 5.5"],
                defaultMode: ModeState(mode: .settings, defaultsTo: .full)
            )
        }
        if script == .namedModels {
            // Part of what portals-bridge sends for Claude Code 2.1.293: `opus` runs
            // what `default` does, so it is named but not listed.
            let models = ["default", "fable", "sonnet", "haiku", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-4-6"]
            return ModelCatalog(
                providers: [ModelProvider(id: "anthropic", name: "Claude", models: models)],
                agentDefault: ModelSetting(model: "default", provider: "anthropic", level: .high),
                levelsByModel: Dictionary(uniqueKeysWithValues: (models + ["opus"]).map { ($0, [.low, .medium, .high, .extraHigh, .max]) })
                    .merging(["claude-opus-4-6": [.low, .medium, .high, .max]]) { $1 },
                namesByModel: [
                    "default": "Opus 5.5", "opus": "Opus 5.5", "fable": "Fable 5.1", "sonnet": "Sonnet 5.5", "haiku": "Haiku 5.5",
                    "claude-haiku-4-5-20251001": "Haiku 4.5", "claude-opus-5": "Opus 5", "claude-opus-4-6": "Opus 4.6",
                ]
            )
        }
        return ModelCatalog(
            providers: [
                ModelProvider(id: "openai-codex", name: "ChatGPT or Codex Subscription", models: ["gpt-6.1-sol", "gpt-6.1-sol-900k", "gpt-6-astra"]),
                ModelProvider(id: "openrouter", name: "OpenRouter", models: ["anthropic/claude-fable-5.1", "anthropic/claude-opus-5.5", "z-ai/glm-5.3"]),
                ModelProvider(id: "zai", name: "Z.AI / GLM", models: ["glm-5.3", "glm-5.3-flash"]),
            ],
            agentDefault: ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .high)
        )
    }

    public func setModel(_ model: String, provider: String?, in thread: ThreadRef.ID, confirmed: Bool) async throws -> ModelChange {
        // One model asks first, so the confirmation can be seen.
        if model.contains("opus"), !confirmed { return .needsConfirmation("\(model) costs more to run than this agent's own model.") }
        return .applied(note: nil)
    }

    public func setThinkingLevel(_ level: ThinkingLevel, in thread: ThreadRef.ID) async throws {}
}

extension FakeBackend: CommandRunning {
    public func commandCatalog(for agent: Agent.ID) async throws -> CommandCatalog {
        if script == .demo { return Self.demoCommands }
        return CommandCatalog(
            commands: [
                SlashCommand(name: "new", summary: "Start a new session"),
                SlashCommand(name: "undo", summary: "Back up N user turns and re-prompt", usage: "[N]"),
                SlashCommand(name: "compress", summary: "Compress conversation context"),
                SlashCommand(name: "status", summary: "Show session, model, token, and context info"),
                SlashCommand(name: "usage", summary: "Show token usage and rate limits"),
                SlashCommand(name: "plan", summary: "Write a markdown implementation plan without executing anything", usage: "<task>"),
                SlashCommand(name: "skills", summary: "Review staged skill writes", usage: "pending | approve", allowedArguments: ["pending", "approve"]),
                SlashCommand(name: "codebase-inspection", summary: "Inspect codebases: lines of code, languages, ratios.", usage: "[instructions]", kind: .skill),
                SlashCommand(name: "arxiv", summary: "Search arXiv papers by keyword, author, category, or ID.", usage: "[instructions]", kind: .skill),
            ],
            aliases: ["reset": "new", "compact": "compress"],
            unavailable: ["config": "/config only works in Hermes's terminal app.", "yolo": "/yolo is not available in Portals."]
        )
    }

    public func runCommand(_ command: SlashInput, in thread: ThreadRef.ID) async throws -> CommandOutcome {
        if script == .demo { return Self.demoCommand(command) }
        if script == .commands, command.name != "status" {
            // As a bridge answers: the agent's own commands are sent to it as messages;
            // a name it does not have is refused.
            guard ["compact", "rename", "export"].contains(command.name) else { throw FakeCommandError(name: command.name) }
            return .message(command.text, shownAs: nil, note: nil)
        }
        return switch command.name {
        case "status":
            .output("Session: 20261005_113202_3c1a55\nModel:   gpt-6.1-sol (openai-codex) | thinking: high\nTokens:  12,480 of 400,000 (3%)\nTurns:   4")
        case "usage":
            .output((1...24).map { "Line \($0) of a long answer, wider than the screen so that it scrolls sideways" }.joined(separator: "\n"))
        case "undo":
            .draft("The message that was taken back", note: "Backed up one turn.")
        case "plan":
            .message("Write a plan for: \(command.argument)", shownAs: nil, note: nil)
        case "arxiv", "codebase-inspection":
            .message("[skill instructions]\n\n\(command.argument)", shownAs: command.text, note: nil)
        default:
            .output("Unknown command /\(command.name) \u{2014} nothing was sent.")
        }
    }
}

/// A command the fake host does not have, refused as a bridge refuses one.
struct FakeCommandError: LocalizedError {
    let name: String

    var errorDescription: String? { "There is no /\(name) command on this host." }
}
