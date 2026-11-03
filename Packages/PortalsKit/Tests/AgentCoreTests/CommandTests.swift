import Foundation
import Testing
@testable import AgentCore

/// Slash commands: reading one from what was typed, what to suggest, where it goes, and
/// how its answer sits in the transcript.
@Suite struct CommandTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private let catalog = CommandCatalog(
        commands: [
            SlashCommand(name: "new", summary: "Start a new session"),
            SlashCommand(name: "compress", summary: "Compress conversation context"),
            SlashCommand(name: "status", summary: "Show session info"),
            SlashCommand(name: "skills", summary: "Review staged skill writes", allowedArguments: ["pending", "approve"]),
            SlashCommand(name: "arxiv", summary: "Search arXiv papers", kind: .skill),
        ],
        aliases: ["reset": "new", "compact": "compress"],
        unavailable: ["config": "/config only works in Hermes's terminal app."]
    )

    // MARK: Reading what was typed

    @Test func aSlashAndANameIsACommand() {
        #expect(SlashInput("/status") == SlashInput(name: "status"))
        #expect(SlashInput("/Undo   2 ") == SlashInput(name: "undo", argument: "2"))
        #expect(SlashInput("/undo 2")?.text == "/undo 2")
        // What follows the name is kept as written, line breaks included.
        #expect(SlashInput("/goal ship it\n\n  by Friday")?.argument == "ship it\n\n  by Friday")
    }

    @Test func proseThatHappensToHaveASlashIsAMessage() {
        #expect(SlashInput("/usr/local is full") == nil)
        #expect(SlashInput("run /clean") == nil)
        #expect(SlashInput("/") == nil)
        #expect(SlashInput("/ not a command") == nil)
        #expect(SlashInput("hello") == nil)
    }

    // MARK: Suggestions

    @Test func aBareSlashOffersEverythingWithTheAppsOwnCommandsFirst() {
        let names = catalog.suggestions(for: "/").map(\.name)
        #expect(names == ["new", "stop", "retry", "model", "reasoning", "help", "compress", "status", "skills", "arxiv"])
        // "/new" is the host's too; it is offered once, as the app's.
        #expect(catalog.suggestions(for: "/").first?.kind == .app)
    }

    @Test func suggestionsNarrowAsTheNameIsTyped() {
        #expect(catalog.suggestions(for: "/st").map(\.name) == ["stop", "status"])
        // Another name for a command finds it; so does a part of its name.
        #expect(catalog.suggestions(for: "/compa").map(\.name) == ["compress"])
        #expect(catalog.suggestions(for: "/res").map(\.name) == ["new", "compress"])
        #expect(catalog.suggestions(for: "/ST").map(\.name) == ["stop", "status"])
        #expect(catalog.suggestions(for: "/zzz").isEmpty)
    }

    @Test func anyPartOfASkillsNameFindsIt() {
        let skills = CommandCatalog(commands: [
            SlashCommand(name: "preview-site", summary: "Preview a site", kind: .skill),
            SlashCommand(name: "code-review", summary: "Review the diff", kind: .skill),
            SlashCommand(name: "anthropic-skills:pdf", summary: "Work with PDFs", kind: .skill),
            SlashCommand(name: "Frontend-Design", summary: "Design a page", kind: .skill),
        ])
        // A word of the name that starts with it comes before a name that only holds it.
        #expect(skills.suggestions(for: "/rev").map(\.name) == ["code-review", "preview-site"])
        #expect(skills.suggestions(for: "/pdf").map(\.name) == ["anthropic-skills:pdf"])
        #expect(skills.suggestions(for: "/view").map(\.name) == ["preview-site", "code-review"])
        // Its letters in order, from three of them, where nothing holds them together.
        #expect(skills.suggestions(for: "/cdrev").map(\.name) == ["code-review"])
        #expect(skills.suggestions(for: "/cd").isEmpty)
        #expect(catalog.suggestions(for: "/res").map(\.name) == ["new", "compress"])
        // Whatever case the host wrote it in.
        #expect(skills.suggestions(for: "/front").map(\.name) == ["Frontend-Design"])
        #expect(skills.suggestions(for: "/des").map(\.name) == ["Frontend-Design"])
    }

    @Test func nothingIsSuggestedOnceTheNameIsDone() {
        #expect(catalog.suggestions(for: "/status ").isEmpty)
        #expect(catalog.suggestions(for: "/undo 2").isEmpty)
        #expect(catalog.suggestions(for: "hello /st").isEmpty)
        #expect(catalog.suggestions(for: "/usr/lo").isEmpty)
        #expect(catalog.suggestions(for: "").isEmpty)
    }

    // MARK: Where a command goes

    @Test func theAppsOwnCommandsStayInTheAppUnderAnyOfTheirNames() {
        #expect(catalog.target(of: SlashInput(name: "new")) == .app(.new))
        #expect(catalog.target(of: SlashInput(name: "reset")) == .app(.new))
        #expect(catalog.target(of: SlashInput(name: "reasoning", argument: "high")) == .app(.reasoning))
        // Before the host has listed anything, they still do.
        #expect(CommandCatalog().target(of: SlashInput(name: "stop")) == .app(.stop))
    }

    @Test func aCommandForAnotherKindOfClientIsNotRun() {
        #expect(catalog.target(of: SlashInput(name: "config")) == .unavailable("/config only works in Hermes's terminal app."))
    }

    @Test func aCommandTheHostLimitsTakesOnlyTheFirstWordsItAllows() {
        #expect(catalog.target(of: SlashInput(name: "skills", argument: "pending")) == .host)
        #expect(catalog.target(of: SlashInput(name: "skills", argument: "Approve 3")) == .host)
        let refused = CommandTarget.unavailable("From here /skills takes one of: pending, approve.")
        #expect(catalog.target(of: SlashInput(name: "skills", argument: "install something")) == refused)
        #expect(catalog.target(of: SlashInput(name: "skills")) == refused)
    }

    @Test func everythingElseIsTheHostsToRunOrRefuse() {
        #expect(catalog.target(of: SlashInput(name: "status")) == .host)
        #expect(catalog.target(of: SlashInput(name: "arxiv", argument: "transformers")) == .host)
        #expect(catalog.target(of: SlashInput(name: "staus")) == .host)
    }

    // MARK: The answer in the transcript

    @Test func anAnswerAtRestIsATurnOfItsOwn() {
        var state = ThreadState()
        state.commandAnswered("/status", output: "Agent: idle", at: t0)

        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.map(\.content) == [.command(CommandRun(command: "/status", output: "Agent: idle"))])
        #expect(state.transcript.turns[0].isLocal)
        #expect(!state.isRunning)

        // The next message starts its own turn after it.
        state.messageSent("hello", at: t0.addingTimeInterval(1))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].isRunning)
    }

    @Test func anAnswerDuringARunKeepsItsPlaceBeforeLaterWork() {
        var state = ThreadState()
        state.messageSent("work on it", at: t0)
        state.apply(.textDelta("On it"), at: t0)
        state.commandAnswered("/usage", output: "1,200 tokens", at: t0.addingTimeInterval(1))

        // The run is still the last turn: what the agent does next lands in it.
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns.last?.items.last.map { if case .command = $0.content { true } else { false } } == true)
        // The sentence it came in ends above it, not split around it; what follows goes below.
        state.apply(.textDelta("."), at: t0.addingTimeInterval(2))
        #expect(state.transcript.turns[0].items.suffix(2).map(\.content) == [.text("On it."), .command(CommandRun(command: "/usage", output: "1,200 tokens"))])
        state.apply(.textDelta("\n\nDone."), at: t0.addingTimeInterval(2))
        #expect(state.transcript.turns[0].items.last?.content == .text("\n\nDone."))

        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.suffix(3).map(\.content) == [.text("On it."), .command(CommandRun(command: "/usage", output: "1,200 tokens")), .text("\n\nDone.")])
    }

    @Test func anAnswerGivenDuringARunTheHostLostFollowsItToo() {
        var state = ThreadState()
        let id = state.messageSent("work on it", at: t0)
        state.messageDelivered(id, outcome: .started, at: t0)
        state.commandAnswered("/usage", output: "1,200 tokens", at: t0)
        state.adopt(ThreadSnapshot(transcript: Transcript(), isRunning: false))

        #expect(state.transcript.turns.last?.isLocal == true)
    }

    // MARK: What came of a command

    @Test func aCommandThatDidNotRunIsATurnOfItsOwnThatSaysWhy() {
        var state = ThreadState()
        state.commandFailed("/nope", reason: "There is no /nope command on this bridge.", at: t0)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.map(\.content) == [
            .command(CommandRun(command: "/nope", output: "", failure: "There is no /nope command on this bridge.")),
        ])
        // The app's alone, like an answer: the host's history never has it.
        #expect(state.transcript.turns[0].isLocal)

        // During a run it waits beside it, as an answer does.
        state.messageSent("work on it", at: t0)
        state.commandFailed("/nope", reason: "Not connected to the host.", at: t0)
        #expect(state.transcript.turns.last?.items.last.map { if case .command = $0.content { true } else { false } } == true)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        #expect(state.transcript.turns.last?.items.last?.content == .command(CommandRun(command: "/nope", output: "", failure: "Not connected to the host.")))
    }

    @Test func aCommandSavedBeforeFailuresWereKeptStillReadsBack() throws {
        let saved = Data(#"{"command":"/status","output":"Agent: idle"}"#.utf8)
        #expect(try JSONDecoder().decode(CommandRun.self, from: saved) == CommandRun(command: "/status", output: "Agent: idle"))
    }

    private func commandTurn(_ text: String, _ rest: [TurnItem.Content], outcome: TurnOutcome? = .completed) -> Turn {
        let opener = TurnItem(.user(UserMessage(text: text, sentAt: t0, delivery: .started)))
        return Turn(startedAt: t0, endedAt: outcome == nil ? nil : t0, outcome: outcome, items: [opener] + rest.map { TurnItem($0) })
    }

    @Test func aTurnStartedByACommandKnowsItsCommand() {
        #expect(commandTurn("/compact", []).command == SlashInput(name: "compact"))
        #expect(commandTurn("/review the login", []).command == SlashInput(name: "review", argument: "the login"))
        #expect(commandTurn("/usr/local is full", []).command == nil)
        #expect(commandTurn("hello", []).command == nil)
        // Words sent with images are a message, whatever they start with.
        var withImage = commandTurn("/compact", [])
        withImage.items[0].content = .user(UserMessage(text: "/compact", sentAt: t0, images: [AttachedImage(filename: "a.png")]))
        #expect(withImage.command == nil)
        // A turn the host started has no command.
        #expect(Turn(startedAt: t0, outcome: .completed, items: [TurnItem(.event(HostEvent(.resumed, "Picked up again")))]).command == nil)
    }

    @Test func aCommandThatRanAndShowedNothingIsDoneAndOneThatAnsweredIsNot() {
        #expect(commandTurn("/rename tidy", []).isCommandWithoutAnswer)
        // A thought or a line of the app's own is not an answer.
        let thought = Reasoning(text: "Renaming.", startedAt: t0, endedAt: t0)
        #expect(commandTurn("/rename tidy", [.reasoning(thought), .notice(Notice(.warning, "Slow provider"))]).isCommandWithoutAnswer)

        #expect(!commandTurn("/context", [.text("12k of 200k tokens used.")]).isCommandWithoutAnswer)
        #expect(!commandTurn("/compact", [.compaction(Compaction(.manual, tokensBefore: 24_063))]).isCommandWithoutAnswer)
        #expect(!commandTurn("/init", [.tool(ToolRun(id: "t", name: "write_file", state: .succeeded, startedAt: t0))]).isCommandWithoutAnswer)
        // Still running, failed or stopped: not done.
        #expect(!commandTurn("/compact", [], outcome: nil).isCommandWithoutAnswer)
        #expect(!commandTurn("/compact", [], outcome: .failed(TurnFailure(message: "No messages to compact.", retryable: false))).isCommandWithoutAnswer)
        #expect(!commandTurn("/compact", [], outcome: .interrupted).isCommandWithoutAnswer)
        // A message with no reply is no command.
        #expect(!commandTurn("hello", []).isCommandWithoutAnswer)
    }

    @Test func aCompactionIsMarkedWhereItHappenedInTheRun() {
        var state = ThreadState()
        let id = state.messageSent("/compact", at: t0)
        state.messageDelivered(id, outcome: .started, at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.status("Compacting the conversation…"), at: t0)
        state.apply(.status(nil), at: t0.addingTimeInterval(11))
        state.apply(.compacted(Compaction(.manual, tokensBefore: 24_063)), at: t0.addingTimeInterval(11))
        state.apply(.contextChanged(ContextUsage(used: 2_831, limit: 200_000)), at: t0.addingTimeInterval(11))
        state.apply(.turnFinished(.completed, finalText: ""), at: t0.addingTimeInterval(11))

        let turn = state.transcript.turns[0]
        #expect(state.transcript.turns.count == 1)
        #expect(turn.items.map(\.content).dropFirst() == [.compaction(Compaction(.manual, tokensBefore: 24_063))])
        #expect(turn.outcome == .completed)
        #expect(!turn.isCommandWithoutAnswer)
        #expect(state.context == ContextUsage(used: 2_831, limit: 200_000))

        // One the host reports outside a run goes with the last turn.
        state.apply(.compacted(Compaction(.auto)), at: t0.addingTimeInterval(20))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.last?.content == .compaction(Compaction(.auto)))
    }

    @Test func aCompactionSaysWhatHappenedAndHowFullTheContextWas() {
        #expect(Compaction(.manual).summary == "Conversation compacted")
        #expect(Compaction(.manual, tokensBefore: 24_063).summary == "Conversation compacted · 24k tokens before")
        #expect(Compaction(.auto, tokensBefore: 180_400).summary == "Conversation compacted automatically · 180k tokens before")
        #expect(Compaction.tokens(950) == "950")
        #expect(Compaction.tokens(2_831) == "2.8k")
        #expect(Compaction.tokens(5_000) == "5k")
        #expect(Compaction.tokens(9_960) == "10k")
        #expect(Compaction.tokens(120_345) == "120k")
        #expect(Compaction.tokens(999_600) == "1M")
        #expect(Compaction.tokens(1_250_000) == "1.3M")
    }

    @Test func aTranscriptWithACompactionIsSavedAndReadBack() throws {
        let transcript = Transcript(turns: [commandTurn("/compact", [.compaction(Compaction(.manual, tokensBefore: 24_063))])])
        let read = try JSONDecoder().decode(Transcript.self, from: try JSONEncoder().encode(transcript))
        #expect(read == transcript)
    }

    // MARK: Merging with the host

    private func stored(_ asked: String, _ reply: String?) -> Turn {
        var items = [TurnItem(.user(UserMessage(text: asked, sentAt: t0, delivery: .started)))]
        if let reply { items.append(TurnItem(.text(reply))) }
        return Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: items)
    }

    private func answer(_ command: String) -> Turn {
        Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: [TurnItem(.command(CommandRun(command: command, output: "…")))])
    }

    private func merge(_ mine: [Turn], _ host: [Turn]) -> [Turn] {
        Transcript(turns: mine).merged(withHost: Transcript(turns: host)).turns
    }

    @Test func answersStayWhereTheyAreWhenTheHostsVersionIsTaken() {
        let first = answer("/status"), one = stored("one", "1"), between = answer("/usage"), two = stored("two", "2"), last = answer("/version")
        let mine = [first, one, between, two, last]
        #expect(merge(mine, [one, two]) == mine)
        // Also when the host has turns this copy has not seen, and none at all.
        let three = stored("three", "3")
        #expect(merge(mine, [one, two, three]) == [first, one, between, two, last, three])
        #expect(merge([first], []) == [first])
    }

    @Test func anAnswerDoesNotStandInForATurnOfTheHosts() {
        // Before the first message: the host's first turn is not the answer's.
        let first = answer("/status")
        let host = [stored("one", "1")]
        #expect(merge([first], host) == [first, host[0]])
    }

    @Test func theRunningTurnStaysLastAfterAnAnswer() {
        let one = stored("one", "1"), aside = answer("/usage")
        var running = stored("two", nil)
        running.outcome = nil
        running.endedAt = nil
        #expect(merge([one, aside], [one, running]) == [one, aside, running])
    }

    @Test func aLineOfTheAppsOwnWithNoTurnAroundItIsKeptToo() {
        var state = ThreadState()
        state.apply(.notice(Notice(.info, "Model changed to glm-5.3.")), at: t0)
        let host = [stored("one", "1")]
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: host)))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[0].items.map(\.content) == [.notice(Notice(.info, "Model changed to glm-5.3."))])
    }

    // MARK: Turns the host started

    private func hostTurn(_ event: HostEvent?, _ reply: String) -> Turn {
        let opener = event.map { [TurnItem(.event($0))] } ?? []
        return Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: opener + [
            TurnItem(.tool(ToolRun(id: "t", name: "terminal", state: .succeeded, startedAt: t0, duration: 1))),
            TurnItem(.text(reply)),
        ])
    }

    @Test func aTurnTheHostAnnouncedOpensWithWhy() {
        let finished = HostEvent(.backgroundProcess, "Background Process Finished: pytest -q")
        var state = ThreadState(transcript: Transcript(turns: [stored("one", "1")]))
        state.apply(.announced(finished), at: t0)
        #expect(state.transcript.turns.count == 1)

        state.apply(.turnStarted, at: t0.addingTimeInterval(1))
        state.apply(.textDelta("All 14 tests pass."), at: t0.addingTimeInterval(2))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.map(\.content) == [.event(finished), .text("All 14 tests pass.")])
        // Said once: the turn after it does not open with it again.
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(3))
        state.apply(.turnStarted, at: t0.addingTimeInterval(4))
        #expect(state.transcript.turns[2].items.isEmpty)
    }

    @Test func anAnnouncementDoesNotOpenTheUsersOwnTurnOrOneMuchLater() {
        let due = HostEvent(.recurringTask, "Recurring task #3")
        var state = ThreadState()
        state.apply(.announced(due), at: t0)
        // The user's message starts its own turn, with their words.
        let id = state.messageSent("hello", at: t0.addingTimeInterval(1))
        #expect(state.transcript.turns[0].items.map(\.id) == [id])
        state.apply(.turnFinished(.completed, finalText: "hi"), at: t0.addingTimeInterval(2))

        // A turn the host starts long after is no longer known to be about it.
        state.apply(.turnStarted, at: t0.addingTimeInterval(120))
        #expect(state.transcript.turns[1].items.isEmpty)

        // One it starts soon after is.
        var prompt = ThreadState()
        prompt.apply(.announced(due), at: t0)
        prompt.apply(.reasoningDelta("checking"), at: t0.addingTimeInterval(5))
        #expect(prompt.transcript.turns[0].items.first?.content == .event(due))
    }

    @Test func aHostStartedTurnWatchedLiveLearnsWhyFromTheHostAndIsNotDoubled() {
        let finished = HostEvent(.backgroundAgents, "Subagent Task Completed: Audit the simulation")
        // Watched live with nothing said about why; the host's history has the reason.
        let mine = [stored("one", "1"), hostTurn(nil, "Done.")]
        let host = [stored("one", "1"), hostTurn(finished, "Done.")]
        let merged = merge(mine, host)

        #expect(merged.count == 2)
        #expect(merged[1].id == mine[1].id)
        #expect(merged[1].items.first?.content == .event(finished))
        // Its own detail is kept, and merging again changes nothing.
        #expect(merged[1].items.count == 3)
        #expect(merge(merged, host) == merged)
        // Such a turn is the host's, not a line of the app's own.
        #expect(!merged[1].isLocal)
        #expect(!Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: [TurnItem(.event(finished))]).isLocal)
    }

    @Test func theHostsWordingOfWhyReplacesTheShortOneGivenAtTheTime() {
        // Live, the host only said a recurring task was firing; its history says which.
        let mine = [hostTurn(HostEvent(.recurringTask, "Recurring task #2"), "tick")]
        let host = [hostTurn(HostEvent(.recurringTask, "Recurring task #2 · every 1m: Say tick"), "tick")]
        let merged = merge(mine, host)

        #expect(merged.count == 1)
        #expect(merged[0].items.count == 3)
        #expect(merged[0].items[0].content == .event(HostEvent(.recurringTask, "Recurring task #2 · every 1m: Say tick")))
        // The line itself is the same one, so nothing on screen is replaced.
        #expect(merged[0].items[0].id == mine[0].items[0].id)
    }

    @Test func whatSetATurnGoingStaysAboveTheFoldedWork() {
        let finished = HostEvent(.backgroundProcess, "Background Process Finished: pytest -q")
        let pieces = TurnLayout.pieces(for: hostTurn(finished, "All 14 tests pass."))
        guard pieces.count == 3, case let .item(opener) = pieces[0], case .steps = pieces[1], case let .item(answer) = pieces[2] else {
            Issue.record("expected the event, the folded work, then the answer")
            return
        }
        #expect(opener.content == .event(finished))
        #expect(answer.content == .text("All 14 tests pass."))
    }

    @Test func anAnswerIsNotFoldedIntoTheWork() {
        #expect(TurnLayout.pieces(for: answer("/status")).count == 1)
        #expect(!TurnItem(.command(CommandRun(command: "/status", output: ""))).isWork)
    }

    @Test func aTranscriptWithAnAnswerSurvivesSaving() throws {
        let transcript = Transcript(turns: [stored("one", "1"), answer("/status")])
        let saved = try JSONEncoder().encode(transcript)
        #expect(try JSONDecoder().decode(Transcript.self, from: saved) == transcript)
    }
}
