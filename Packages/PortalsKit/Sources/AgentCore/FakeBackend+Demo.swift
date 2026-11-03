import Foundation

// MARK: - The demo

/// The demo the welcome offers to anyone with no host to add, Apple's beta reviewers first
/// (2026-10-29): a host with Claude Code and Codex in a made-up shop's project. Its
/// first thread plays a tour (a reply streaming, commands run, one that waits for your
/// say, a question, a code block and a visual), and ends by asking Codex for a review in
/// the thread it started for that, which works at the foot of the chat. Anything else
/// sent gets a short answer that says it is the demo. Every title starts with "Demo", and
/// nothing in it is anyone's real work.
extension FakeBackend {
    /// The thread the tour plays in, which the demo opens with.
    public static let demoTourID = ThreadRef.ID(rawValue: "demo-tour")
    public static let demoTourTitle = "Demo: a tour of Portals"
    /// What the app sends in the tour's thread to begin the tour.
    public static let demoTourPrompt = "Show me around."
    /// The thread Claude Code started for Codex's reviews, under the tour's.
    public static let demoReviewID = ThreadRef.ID(rawValue: "demo-review")
    /// A thread of Codex's own, in the sidebar.
    public static let demoNotesID = ThreadRef.ID(rawValue: "demo-notes")
    /// The demo host's home folder, and the made-up project its agents work in.
    public static let demoHome = "/Users/demo"
    public static let demoProject = "/Users/demo/demo-shop"

    /// The demo's agents: Claude Code, the default, and Codex, as a Portals bridge lists them.
    public static func demoAgents(on host: HostID) -> [Agent] {
        [
            Agent(id: Agent.ID(host: host, name: "claude"), displayName: "Claude Code", summary: "A scripted stand-in, for the demo", isDefault: true, kind: "claude"),
            Agent(id: Agent.ID(host: host, name: "codex"), displayName: "Codex", summary: "A scripted stand-in, for the demo", kind: "codex"),
        ]
    }

    /// The demo's threads as its host has them when the demo opens, each with what was
    /// said in it: the tour's, with the turn before the tour; Codex's reviews, started from
    /// it, with the review of that turn; Codex's release notes.
    public static func demoThreads(on host: HostID, at now: Date = .now) -> [(record: ThreadRecord, transcript: Transcript)] {
        let claude = Agent.ID(host: host, name: "claude")
        let codex = Agent.ID(host: host, name: "codex")
        let earlier = now.addingTimeInterval(-50 * 60)

        let tourTurn = demoTranscript(at: earlier, message: "Make the Pay button wait until the checkout form is filled in.", [
            .toolStarted(ToolRun(id: "demo-p1", name: "patch", label: "src/checkout.js")),
            .toolFinished(ToolResult(id: "demo-p1", name: "patch", succeeded: true, duration: 0.1, diff: checkoutDiff)),
            .toolStarted(ToolRun(id: "demo-p2", name: "terminal", label: "npm test", input: "npm test")),
            .toolFinished(ToolResult(id: "demo-p2", name: "terminal", succeeded: true, duration: 2.2, output: "12 passing")),
            .textDelta("Done: the Pay button stays disabled until every field of the form is filled in, and a test covers an empty form. Codex looked over the change in a thread I started for its reviews, and found nothing to change."),
        ])
        var tour = ThreadRecord(
            ref: ThreadRef(id: demoTourID, agent: claude, title: demoTourTitle, createdAt: earlier, workingDirectory: demoProject),
            updatedAt: earlier.addingTimeInterval(60), preview: "Done: the Pay button stays disabled until every field of the form is filled in."
        )
        tour.context = ContextUsage(used: 21_000, limit: 200_000)

        let reviewed = earlier.addingTimeInterval(30)
        let reviewTurn = demoTranscript(at: reviewed, [
            .turnOpened(by: "Please review my change to src/checkout.js: the Pay button waits for a filled-in form.", from: demoClaudeSender),
            .toolStarted(ToolRun(id: "demo-v1", name: "read_file", label: "src/checkout.js")),
            .toolFinished(ToolResult(id: "demo-v1", name: "read_file", succeeded: true, duration: 0.02, output: "export function canPay(form) {\n  return form.fields.every((field) => field.value.trim() !== \"\");\n}")),
            .textDelta("Looks good: the button checks every field, and the new test covers an empty form. Nothing to change."),
        ])
        var review = ThreadRecord(
            ref: ThreadRef(id: demoReviewID, agent: codex, title: "Demo: reviews for Claude Code", createdAt: reviewed, workingDirectory: demoProject),
            updatedAt: reviewed.addingTimeInterval(30), preview: "Looks good: the button checks every field, and the new test covers an empty form."
        )
        review.startedBy = ThreadStarter(name: "Claude Code", thread: demoTourID)

        let written = now.addingTimeInterval(-3 * 3_600)
        let notesTurn = demoTranscript(at: written, message: "Write the release notes for version 1.2 of the shop.", [
            .toolStarted(ToolRun(id: "demo-n1", name: "terminal", label: "git log --oneline v1.1..HEAD", input: "git log --oneline v1.1..HEAD")),
            .toolFinished(ToolResult(id: "demo-n1", name: "terminal", succeeded: true, duration: 0.1, output: "a41c2e9 Keep saved carts after a restart\n7d03f1b Search keeps its text on reload\n2b9e6a0 Faster product pages")),
            .textDelta("""
                ## Demo Shop 1.2

                - **Saved carts** come back after a restart.
                - **Faster product pages**: pictures load as they come into view.
                - Fixed: the search box lost what was typed when the page reloaded.
                """),
        ])
        let notes = ThreadRecord(
            ref: ThreadRef(id: demoNotesID, agent: codex, title: "Demo: release notes for 1.2", createdAt: written, workingDirectory: demoProject),
            updatedAt: written.addingTimeInterval(45), preview: "Demo Shop 1.2"
        )

        return [(tour, tourTurn), (review, reviewTurn), (notes, notesTurn)]
    }

    /// What the demo's host keeps of its threads as the demo opens (`demoThreads`).
    static func demoHistories(on host: HostID) -> [ThreadRef.ID: ThreadState] {
        Dictionary(uniqueKeysWithValues: demoThreads(on: host).map { thread in
            (thread.record.id, ThreadState(transcript: thread.transcript, title: thread.record.ref.title))
        })
    }

    /// The models the demo's agents offer, as a bridge names them.
    static func demoModels(for agent: Agent.ID) -> ModelCatalog {
        if agent.name == "codex" {
            return ModelCatalog(
                providers: [ModelProvider(id: "openai", name: "Codex", models: ["gpt-6.1-sol", "gpt-6.1-sol-mini"])],
                agentDefault: ModelSetting(model: "gpt-6.1-sol", provider: "openai", level: .high)
            )
        }
        return ModelCatalog(
            providers: [ModelProvider(id: "anthropic", name: "Claude", models: ["default", "sonnet"])],
            agentDefault: ModelSetting(model: "default", provider: "anthropic", level: .high),
            namesByModel: ["default": "Opus 5.5", "sonnet": "Sonnet 5.5"]
        )
    }

    static let demoCommands = CommandCatalog(commands: [
        SlashCommand(name: "status", summary: "Show the thread's model and context"),
    ])

    static func demoCommand(_ command: SlashInput) -> CommandOutcome {
        guard command.name == "status" else { return .output("This is the demo: /\(command.name) does nothing here.") }
        return .output("Demo thread: nothing runs on a computer.\nContext: 11% used")
    }

    // MARK: The scripts

    static func performDemo(prompt: String, with player: Player) async throws {
        if player.thread == demoTourID, prompt == demoTourPrompt {
            try await playTour(with: player)
        } else {
            try await playAnswer(to: prompt, with: player)
        }
    }

    /// The tour, in the tour's thread: a session as it goes, with the person's say asked
    /// for twice, ending with a review asked of Codex in its thread.
    private static func playTour(with player: Player) async throws {
        let codex = Agent.ID(host: player.backend.host, name: "codex")
        try await player.emit(.turnStarted)
        try await player.think("Someone new to Portals. Show them a session as it goes: run the tests, ask before deleting anything, ask how they want the fix, make it, then hand it to Codex for a review.")
        try await player.stream("Welcome to the Portals demo! I'm a stand-in for Claude Code, following a script: no computer is connected, nothing here is anyone's real work, and nothing you do leaves this app.\n\nWith Portals you talk to the coding agents on your own Mac or Linux computer, from your iPhone, iPad or Mac. Here is a session as it looks. First, the project's tests:\n\n")
        try await player.emit(.toolStarted(ToolRun(id: "demo-t1", name: "terminal", label: "npm test", input: "npm test")), after: 6)
        try await player.emit(.toolFinished(ToolResult(
            id: "demo-t1", name: "terminal", succeeded: false, duration: 2.4,
            output: "12 passing\n1 failing\n\n  cart total\n    expected 10.3, got 10.299999999999999"
        )), after: 40)
        try await player.emit(.toolStarted(ToolRun(id: "demo-t2", name: "read_file", label: "src/cart.js")), after: 6)
        try await player.emit(.toolFinished(ToolResult(id: "demo-t2", name: "read_file", succeeded: true, duration: 0.02, output: cartBefore)), after: 10)
        try await player.stream("The cart's total is never rounded to cents. Before I change it I'd clear out the old build. Deleting files needs your say, so Portals asks you, here or wherever you are:\n\n")

        try await player.emit(.toolStarted(ToolRun(id: "demo-t3", name: "terminal", label: "rm -rf build", input: "rm -rf build")), after: 6)
        let allowed = try await player.ask(PendingRequest(
            id: demoRequestID(),
            kind: .approval(ApprovalRequest(command: "rm -rf build", reason: "Deletes the build folder", choices: [.once, .session, .deny]))
        ))
        if case let .approval(choice) = allowed, choice != .deny {
            try await player.emit(.toolFinished(ToolResult(id: "demo-t3", name: "terminal", succeeded: true, duration: 0.2, output: "")), after: 10)
            try await player.stream("Done, the old build is gone. ")
        } else {
            try await player.emit(.toolFinished(ToolResult(
                id: "demo-t3", name: "terminal", succeeded: false, duration: 0.1, output: "You denied this command. It did not run."
            )), after: 4)
            try await player.stream("All right, I left the build folder alone. ")
        }
        try await player.stream("One question before I change the code:\n\n")

        let fixes = ["Round to cents (Recommended)", "Count in whole cents"]
        let answered = try await player.ask(PendingRequest(
            id: demoRequestID(),
            kind: .clarify([ClarifyQuestion(
                id: "fix", text: "How should the total be fixed?", choices: fixes, header: "Fix",
                descriptions: [fixes[0]: "One line in cart.js", fixes[1]: "Every price kept as a whole number of cents: a bigger change"]
            )])
        ))
        let inCents = if case let .clarify(answers) = answered { answers["fix"] == fixes[1] } else { false }
        try await player.emit(.toolStarted(ToolRun(id: "demo-t4", name: "patch", label: "src/cart.js")), after: 6)
        try await player.emit(.toolFinished(ToolResult(id: "demo-t4", name: "patch", succeeded: true, duration: 0.1, diff: inCents ? cartDiffInCents : cartDiff)), after: 20)
        try await player.emit(.toolStarted(ToolRun(id: "demo-t5", name: "terminal", label: "npm test", input: "npm test")), after: 6)
        try await player.emit(.toolFinished(ToolResult(id: "demo-t5", name: "terminal", succeeded: true, duration: 2.3, output: "13 passing")), after: 40)
        try await player.stream("Fixed, and all 13 tests pass. \(inCents ? "Prices are whole cents now, so a total is always exact" : "The total is rounded once, after the sum"):\n\n")
        try await player.stream(inCents ? cartAfterInCents : cartAfter)
        try await player.stream("\n\nThe tests before and after:\n\n")
        // Whole, as a reply that comes at once: a visual is drawn once its fence is closed.
        try await player.emit(.textDelta(testsVisual), after: 4)

        try await player.stream("\n\nI've asked Codex to review the fix, in the thread I started for its reviews:\n\n")
        let send = #"portals send demo-review "Please review my fix in src/cart.js""#
        try await player.emit(.toolStarted(ToolRun(id: "demo-t6", name: "terminal", label: send, input: send)), after: 6)
        try await player.emit(.toolFinished(ToolResult(id: "demo-t6", name: "terminal", succeeded: true, duration: 0.3, output: "Sent to Codex.")), after: 10)
        await player.backend.playAside(in: demoReviewID, agent: codex) { review in try await playReview(with: review) }
        try await player.finish(
            "It's working on it at the foot of this chat: tap it to look in.\n\nTo try Portals yourself, start a new thread with the pencil at the top of the sidebar and send a message. End the demo, in Settings and at the foot of the sidebar, takes you back to the start.",
            context: ContextUsage(used: 34_000, limit: 200_000)
        )
    }

    /// Codex's review of the tour's fix, in its thread, which the tour's message opens.
    private static func playReview(with player: Player) async throws {
        try await player.emit(.turnOpened(by: "Please review my fix in src/cart.js: the cart's total is rounded to cents now, and all 13 tests pass.", from: demoClaudeSender))
        try await player.think("Read the change, run the tests, then look for anything else that formats a price on its own.")
        // Slow, as a review is: about half a minute at work on the line at the tour's foot.
        try await player.emit(.toolStarted(ToolRun(id: "demo-r1", name: "read_file", label: "src/cart.js")), after: 80)
        try await player.emit(.toolFinished(ToolResult(id: "demo-r1", name: "read_file", succeeded: true, duration: 0.02, output: cartAfterCode)), after: 80)
        try await player.emit(.toolStarted(ToolRun(id: "demo-r2", name: "terminal", label: "npm test", input: "npm test")), after: 60)
        try await player.emit(.toolFinished(ToolResult(id: "demo-r2", name: "terminal", succeeded: true, duration: 2.3, output: "13 passing")), after: 400)
        try await player.emit(.toolStarted(ToolRun(id: "demo-r3", name: "search_files", label: "toFixed")), after: 60)
        try await player.emit(.toolFinished(ToolResult(id: "demo-r3", name: "search_files", succeeded: true, duration: 0.3, output: "src/receipt.js:14:  return price.toFixed(2);")), after: 240)
        try await player.finish(
            "The fix is right: the total is rounded once, after the sum, so it cannot drift, and all 13 tests pass. One suggestion: the receipt rounds prices on its own (`receipt.js`, line 14). A shared `money()` helper would keep the two from ever disagreeing.",
            context: ContextUsage(used: 18_000, limit: 200_000)
        )
    }

    /// Anything else sent in the demo: an answer as its agent, which says it is the demo.
    private static func playAnswer(to prompt: String, with player: Player) async throws {
        let name = player.agent?.name == "codex" ? "Codex" : "Claude Code"
        let said = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        try await player.emit(.turnStarted)
        if await player.backend.takesTitle(player.thread) {
            try await player.emit(.titleChanged(demoTitle(for: said)), after: 8)
        }
        try await player.think("This is the demo, with no computer to work on. Say so, and what would happen with one.")
        let read = "demo-a-\(UUID().uuidString.prefix(8).lowercased())"
        try await player.emit(.toolStarted(ToolRun(id: read, name: "read_file", label: "README.md")), after: 6)
        try await player.emit(.toolFinished(ToolResult(id: read, name: "read_file", succeeded: true, duration: 0.02, output: "# Demo Shop\nA made-up shop, for the Portals demo.")), after: 12)
        let quoted = said.isEmpty ? "" : "You said: \u{201C}\(said)\u{201D}\n\n"
        try await player.finish(
            "\(quoted)This is the demo, so I can only follow a script: there is no computer here to work on. With Portals set up, \(name) on your Mac or Linux computer would read your project, run what it needs, ask you before anything risky, and answer you here, as in the tour.\n\nSetting up takes a few minutes: Tailscale on both devices, then `\(PairingLink.setupCommand)` in a terminal on the computer.",
            context: ContextUsage(used: 9_000, limit: 200_000)
        )
    }

    // MARK: Pieces

    /// A demo thread's title for its first message: its first words after "Demo:".
    static func demoTitle(for message: String) -> String {
        let words = message.split(whereSeparator: \.isWhitespace).prefix(6).joined(separator: " ")
        guard let first = words.first else { return "Demo: a new thread" }
        let title = first.uppercased() + words.dropFirst()
        return "Demo: " + (title.count > 48 ? String(title.prefix(47)) + "…" : title)
    }

    /// Who the messages Claude Code sends Codex come from.
    private static let demoClaudeSender = MessageSender(agent: "claude", agentName: "Claude Code", thread: demoTourID.rawValue, title: demoTourTitle)

    /// An id for a request of the demo's, its own each time: several threads can wait at once.
    private static func demoRequestID() -> String {
        "srq-demo-\(UUID().uuidString.prefix(8).lowercased())"
    }

    /// A transcript as the turns played: `message`, the user's, opening the first, then
    /// `events`, and the turn's end.
    private static func demoTranscript(at start: Date, message: String? = nil, _ events: [ThreadEvent]) -> Transcript {
        var state = ThreadState()
        var moment = start
        if let message {
            let sent = state.messageSent(message, at: moment)
            state.messageDelivered(sent, outcome: .started, at: moment)
            state.apply(.turnStarted, at: moment)
        }
        for event in events + [.turnFinished(.completed, finalText: nil)] {
            moment = moment.addingTimeInterval(4)
            state.apply(event, at: moment)
        }
        return state.transcript
    }

    private static let cartBefore = """
        1|export function total(items) {
        2|  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        3|}
        """

    private static let cartAfterCode = """
        export function total(items) {
          const sum = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
          return Math.round(sum * 100) / 100;
        }
        """

    private static let cartAfter = "```js\n\(cartAfterCode)\n```"

    private static let cartAfterInCents = """
        ```js
        // Prices are whole cents: 1030 is $10.30.
        export function total(items) {
          return items.reduce((sum, item) => sum + item.priceInCents * item.quantity, 0);
        }
        ```
        """

    private static let cartDiff = """
        --- a/src/cart.js
        +++ b/src/cart.js
        @@ -1,3 +1,4 @@
         export function total(items) {
        -  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        +  const sum = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        +  return Math.round(sum * 100) / 100;
         }
        """

    private static let cartDiffInCents = """
        --- a/src/cart.js
        +++ b/src/cart.js
        @@ -1,3 +1,4 @@
        +// Prices are whole cents: 1030 is $10.30.
         export function total(items) {
        -  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        +  return items.reduce((sum, item) => sum + item.priceInCents * item.quantity, 0);
         }
        """

    private static let checkoutDiff = """
        --- a/src/checkout.js
        +++ b/src/checkout.js
        @@ -8,5 +8,9 @@
        +export function canPay(form) {
        +  return form.fields.every((field) => field.value.trim() !== "");
        +}
        +
         export function renderPay(form, button) {
        -  button.disabled = false;
        +  button.disabled = !canPay(form);
         }
        """

    /// The tests before and after the fix, as bars.
    static let testsVisual = #"""
        ```portals-visual title="Tests before and after the fix"
        <div class="runs">
          <div class="run"><span>Before</span><div class="bar"><i class="pass" style="--w: 92.3%"></i><i class="fail" style="--w: 7.7%"></i></div><b>12 of 13</b></div>
          <div class="run"><span>After</span><div class="bar"><i class="pass" style="--w: 100%"></i></div><b>13 of 13</b></div>
          <p class="key"><i class="pass"></i>passing<i class="fail"></i>failing</p>
        </div>
        <style>
          .runs { display: grid; gap: 10px; color: var(--portals-text-2); font: 15px var(--portals-font); }
          .run { display: grid; grid-template-columns: 4em 1fr 4.5em; align-items: center; gap: 10px; }
          .bar { display: flex; gap: 2px; height: 16px; border-radius: 8px; overflow: hidden; background: var(--portals-line); }
          .bar i { width: var(--w); animation: grow 0.9s ease-out both; }
          .pass { background: var(--portals-positive); }
          .fail { background: var(--portals-negative); }
          .run b { color: var(--portals-text); font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
          .key { margin: 2px 0 0; font-size: 13px; }
          .key i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 5px 0 12px; vertical-align: -1px; }
          .key i:first-child { margin-left: 0; }
          @keyframes grow { from { width: 0; } }
        </style>
        ```
        """#
}

// MARK: Folders

/// The demo's host offers folders, as a Portals bridge does: its home, and the made-up
/// project. Every other script's offers none, and says nothing (nil), as before.
extension FakeBackend: FolderProviding {
    public var offersFolders: Bool? { script == .demo ? true : nil }
    public var addsFolders: Bool? { script == .demo ? false : nil }
    public var machine: HostMachine? { nil }

    public func folders(for agent: Agent.ID) async throws -> FolderList {
        guard script == .demo else { throw FolderError.unavailable }
        return FolderList(
            general: Folder(path: Self.demoHome, name: Folder.generalName),
            recent: [Folder(path: Self.demoProject, lastUsed: .now)]
        )
    }

    public func addFolder(at path: String) async throws -> Folder {
        throw FolderError.unavailable
    }

    public func removeFolder(at path: String) async throws {
        throw FolderError.unavailable
    }
}
