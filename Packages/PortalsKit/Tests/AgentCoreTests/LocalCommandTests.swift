import Foundation
import Testing
@testable import AgentCore

@Suite struct LocalCommandTests {
    private func running() -> ThreadState {
        var state = ThreadState()
        let id = state.messageSent("work")
        state.messageDelivered(id, outcome: .started)
        return state
    }

    @Test func laterTextAndToolsFollowTheAnswerAndFailureInTheRunningTurn() {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        state.apply(.textDelta("\n\nafter"))
        state.commandFailed("/bad", reason: "Unavailable")
        state.apply(.textDelta("\n\nlater"))
        #expect(state.isRunning)
        let items = state.transcript.turns[0].items
        #expect(items.dropFirst().map(\.content) == [
            .text("Before"), .command(CommandRun(command: "/usage", output: "12 tokens")),
            .text("\n\nafter"), .command(CommandRun(command: "/bad", output: "", failure: "Unavailable")), .text("\n\nlater")
        ])
    }

    /// The backlog's "Left: an answer that comes mid-sentence splits the sentence around
    /// the box": the rest of the paragraph it came in goes above it, what follows below.
    @Test func anAnswerThatComesMidSentenceGoesAfterItsParagraph() {
        let usage = TurnItem.Content.command(CommandRun(command: "/usage", output: "12 tokens"))
        var state = running()
        state.apply(.textDelta("The fix is in"))
        state.commandAnswered("/usage", output: "12 tokens")
        state.apply(.textDelta(" the login"))
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == [.text("The fix is in the login"), usage])
        state.apply(.textDelta(" view.\nIt checks"))
        state.apply(.textDelta(" the token.\n\nNext, the tests"))
        state.apply(.textDelta(" run."))
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("The fix is in the login view.\nIt checks the token."), usage, .text("Next, the tests run."),
        ])

        // A paragraph that a code block follows ends where the block begins.
        var code = running()
        code.apply(.textDelta("Here is the change"))
        code.commandAnswered("/usage", output: "12 tokens")
        code.apply(.textDelta(":\n```swift\nlet a = 1\n\nlet b = 2\n```"))
        #expect(code.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("Here is the change:"), usage, .text("```swift\nlet a = 1\n\nlet b = 2\n```"),
        ])

        // A paragraph's end that comes alone, then the next one, which goes below
        // (Codex's review of n14: the end was dropped, and the next was joined to it).
        var alone = running()
        alone.apply(.textDelta("The fix is"))
        alone.commandAnswered("/usage", output: "12 tokens")
        alone.apply(.textDelta(" complete.\n\n"))
        alone.apply(.textDelta("Next, tests."))
        #expect(alone.transcript.turns[0].items.dropFirst().map(\.content) == [.text("The fix is complete.\n\n"), usage, .text("Next, tests.")])

        // A fence whose marks came in two pieces either side of the answer begins below it.
        var split = running()
        split.apply(.textDelta("Here is the change"))
        split.commandAnswered("/usage", output: "12 tokens")
        split.apply(.textDelta(":\n``"))
        split.apply(.textDelta("`swift\nlet a = 1\n```"))
        #expect(split.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("Here is the change:\n"), usage, .text("```swift\nlet a = 1\n```"),
        ])

        // And one that begins right at the piece after the answer, after a line of the
        // paragraph or after its end (Codex's re-check of n14).
        for (said, kept) in [("Here is the change:\n", "Here is the change:\n"), ("Done.\n\n", "Done.\n\n")] {
            var next = running()
            next.apply(.textDelta(said))
            next.commandAnswered("/usage", output: "12 tokens")
            next.apply(.textDelta("```swift\nlet a = 1\n```"))
            #expect(next.transcript.turns[0].items.dropFirst().map(\.content) == [.text(kept), usage, .text("```swift\nlet a = 1\n```")])
        }

        // One that came after a paragraph's end stays there.
        var ended = running()
        ended.apply(.textDelta("Done.\n\n"))
        ended.commandAnswered("/usage", output: "12 tokens")
        ended.apply(.textDelta("Next."))
        #expect(ended.transcript.turns[0].items.dropFirst().map(\.content) == [.text("Done.\n\n"), usage, .text("Next.")])

        // The host's copy places it the same way.
        var restored = running()
        restored.apply(.textDelta("The fix is in"))
        restored.commandAnswered("/usage", output: "12 tokens")
        restored.adopt(ThreadSnapshot(transcript: Transcript(turns: [Turn(items: [
            restored.transcript.turns[0].items[0], TurnItem(.text("The fix is in the login view.\nIt checks the token.\n\nNext, the tests run.")),
        ])]), isRunning: true))
        #expect(restored.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("The fix is in the login view.\nIt checks the token."), usage, .text("Next, the tests run."),
        ])
    }

    @Test(arguments: [false, true]) func coalescedHostTextKeepsBothCommandBoundaries(authoritative: Bool) throws {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        state.apply(.textDelta("\n\nmiddle"))
        state.commandFailed("/bad", reason: "Unavailable")
        state.apply(.textDelta("\n\nafter"))
        let original = state.transcript.turns[0]
        let user = try #require(original.items.first)
        let host = Transcript(turns: [Turn(items: [user, TurnItem(.text("Before\n\nmiddle\n\nafter"))])])
        let snapshot = ThreadSnapshot(transcript: host, isRunning: true, authoritative: authoritative)
        state.adopt(snapshot)
        let commands = state.transcript.turns[0].items.filter { if case .command = $0.content { true } else { false } }
        #expect(commands.map(\.id) == original.items.filter { if case .command = $0.content { true } else { false } }.map(\.id))
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == original.items.dropFirst().map(\.content))
        state.adopt(snapshot)
        #expect(state.transcript.turns[0].items.filter { if case .command = $0.content { true } else { false } }.count == 2)
    }

    @Test func anAnswerAtTheEndOfPartialTextStaysBeforeNewHostText() throws {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        let user = try #require(state.transcript.turns[0].items.first)
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [Turn(items: [user, TurnItem(.text("Before\n\nand more from the host"))])]), isRunning: true))
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("Before"), .command(CommandRun(command: "/usage", output: "12 tokens")), .text("\n\nand more from the host")
        ])
        // The host's words that end the paragraph it came in go above it, as they would have live.
        var partial = running()
        partial.apply(.textDelta("Before"))
        partial.commandAnswered("/usage", output: "12 tokens")
        let opening = try #require(partial.transcript.turns[0].items.first)
        partial.adopt(ThreadSnapshot(transcript: Transcript(turns: [Turn(items: [opening, TurnItem(.text("Before and more from the host"))])]), isRunning: true))
        #expect(partial.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("Before and more from the host"), .command(CommandRun(command: "/usage", output: "12 tokens")),
        ])
    }

    @Test func aClosedStreamSplitByACommandIsNotRepeatedAsTheFinalAnswer() {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        state.apply(.textDelta("\n\nafter"))
        state.apply(.interimText("Before\n\nafter", alreadyStreamed: true))
        state.apply(.turnFinished(.completed, finalText: "Before\n\nafter"))
        #expect(state.transcript.turns[0].items.filter { if case .text = $0.content { true } else { false } }.count == 2)
    }

    @Test func anInterimClosedWhileTheCommandIsLastAllowsANewFinalAnswer() {
        var state = running()
        state.apply(.textDelta("Interim"))
        state.commandAnswered("/usage", output: "12 tokens")
        state.apply(.interimText("Interim", alreadyStreamed: true))
        state.apply(.turnFinished(.completed, finalText: "Final answer"))
        #expect(state.transcript.turns[0].items.last?.content == .text("Final answer"))
    }

    @Test func closingDuringARunAndAfterRelaunchRemovesOnlyTheLocalBox() throws {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        let answer = try #require(state.transcript.turns[0].items.last)
        let closed = state.dismissCommand(answer.id)
        #expect(closed)
        #expect(state.isRunning)
        state.commandFailed("/bad", reason: "Unavailable")
        let failed = try #require(state.transcript.turns[0].items.last)
        state.apply(.turnFinished(.completed, finalText: nil))
        let saved = try JSONEncoder().encode(state.transcript)
        var restored = ThreadState(transcript: try JSONDecoder().decode(Transcript.self, from: saved))
        let removed = restored.dismissCommand(failed.id)
        #expect(removed)
        let removedAgain = restored.dismissCommand(failed.id)
        #expect(!removedAgain)
        #expect(restored.transcript.turns.count == 1)
        #expect(restored.transcript.turns[0].items.map(\.content).contains(.text("Before")))
        #expect(!restored.transcript.turns[0].items.contains { if case .command = $0.content { true } else { false } })
    }

    @Test func closingTheOnlyLocalAnswerRemovesItsEmptyTurn() throws {
        var state = ThreadState()
        state.commandAnswered("/usage", output: "12 tokens")
        let id = try #require(state.transcript.turns.first?.items.first?.id)
        let removed = state.dismissCommand(id)
        #expect(removed)
        #expect(state.transcript.isEmpty)
    }

    @Test func closingBetweenStreamFragmentsDoesNotDuplicateTheWholePieceReceipt() throws {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        let command = try #require(state.transcript.turns[0].items.last?.id)
        state.apply(.textDelta("\n\nafter"))
        _ = state.dismissCommand(command)
        state.apply(.interimText("Before\n\nafter", alreadyStreamed: true))
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == [.text("Before"), .text("after")])
    }

    @Test func aNewInterimMayRepeatWordsSaidBeforeEarlierTools() {
        var state = running()
        state.apply(.interimText("Ready", alreadyStreamed: false))
        state.apply(.toolStarted(ToolRun(id: "a", name: "read")))
        state.apply(.interimText("Working", alreadyStreamed: false))
        state.apply(.toolStarted(ToolRun(id: "b", name: "read")))
        state.apply(.interimText("Ready", alreadyStreamed: false))
        #expect(state.transcript.turns[0].items.last?.content == .text("Ready"))
    }

    @Test func anExactSteeredMessageAnchorWinsOverEarlierIdenticalWords() throws {
        var state = ThreadState()
        let first = state.messageSent("continue")
        state.messageDelivered(first, outcome: .started)
        state.apply(.textDelta("First reply"))
        let second = state.messageSent("continue")
        state.messageDelivered(second, outcome: .steered)
        state.commandAnswered("/usage", output: "12 tokens")
        let local = state.transcript.turns[0]
        let host = Turn(items: local.items.filter { if case .command = $0.content { false } else { true } })
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [host]), isRunning: true))
        let items = state.transcript.turns[0].items
        let steered = try #require(items.firstIndex { $0.id == second })
        #expect(items[steered + 1].content == .command(CommandRun(command: "/usage", output: "12 tokens")))
    }

    @Test func aCommandDoesNotBreakTheSourceOfAVisualStillBeingWritten() throws {
        var state = running()
        state.apply(.textDelta("```portals-visual\n<div>"))
        state.commandAnswered("/usage", output: "12 tokens")
        state.apply(.textDelta("A visual</div>\n```\nLater work"))
        let items = state.transcript.turns[0].items
        #expect(items.dropFirst().map(\.content) == [
            .text("```portals-visual\n<div>A visual</div>\n```"),
            .command(CommandRun(command: "/usage", output: "12 tokens")), .text("Later work")
        ])
        let user = try #require(items.first)
        let host = Transcript(turns: [Turn(items: [user, TurnItem(.text("```portals-visual\n<div>A visual</div>\n```\nLater work"))])])
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true))
        #expect(state.transcript.turns[0].items[1].content == items[1].content)
        #expect(state.transcript.turns[0].items[2].content == items[2].content)
    }

    @Test func closingAfterCompletionDoesNotJoinWordsAcrossFormerCommandFragments() throws {
        var state = running()
        state.apply(.textDelta("Before"))
        state.commandAnswered("/usage", output: "12 tokens")
        let command = try #require(state.transcript.turns[0].items.last?.id)
        state.apply(.textDelta("\n\nafter"))
        state.apply(.interimText("Before\n\nafter", alreadyStreamed: true))
        state.apply(.turnFinished(.completed, finalText: "Before\n\nafter"))
        _ = state.dismissCommand(command)
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == [.text("Before"), .text("after")])
    }

    /// The app was closed while a visual was still being written past a command's answer:
    /// the host's history has the visual whole, and the answer goes back after it, not
    /// into its source (Codex, tonight's review).
    @Test func anAnswerRestoredInAVisualTheHostFinishedGoesAfterIt() throws {
        var state = running()
        state.apply(.textDelta("Here:\n```portals-visual\n<div>"))
        state.commandAnswered("/usage", output: "12 tokens")
        let user = try #require(state.transcript.turns[0].items.first)
        let host = Transcript(turns: [Turn(items: [
            user, TurnItem(.text("Here:\n```portals-visual\n<div>A visual</div>\n```\nLater work")),
        ])])
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true))
        #expect(state.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("Here:\n```portals-visual\n<div>A visual</div>\n```"),
            .command(CommandRun(command: "/usage", output: "12 tokens")), .text("Later work"),
        ])
        // And at the end of the text when the host's copy has not closed it yet.
        var open = running()
        open.apply(.textDelta("```portals-visual\n<div>"))
        open.commandAnswered("/usage", output: "12 tokens")
        let opening = try #require(open.transcript.turns[0].items.first)
        open.adopt(ThreadSnapshot(transcript: Transcript(turns: [Turn(items: [
            opening, TurnItem(.text("```portals-visual\n<div>Still going")),
        ])]), isRunning: true))
        #expect(open.transcript.turns[0].items.dropFirst().map(\.content) == [
            .text("```portals-visual\n<div>Still going"), .command(CommandRun(command: "/usage", output: "12 tokens")),
        ])
    }
}
