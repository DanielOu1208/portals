import Foundation
import Testing
@testable import AgentCore

/// A message the user did not type, sent through a host's fleet by another agent's thread
/// or a script, is known by the line the host opens it with, live and in history alike,
/// and is labelled with who sent it.
@Suite struct RelayedMessageTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func oneFromTheCommandLineIsLabelledSo() throws {
        let relayed = try #require(RelayedMessage(parsing: "[Portals: from the command line]\nRun the tests\nthen stop"))
        #expect(relayed.label == "From the command line")
        #expect(relayed.text == "Run the tests\nthen stop")
        #expect(relayed.isFromCommandLine)
    }

    @Test func oneFromAnotherThreadNamesItsAgentAndTitleWithoutTheThreadsId() throws {
        let relayed = try #require(RelayedMessage(parsing: "[Portals: from Claude Code · \"Fix the login\" (thread 6d3c1a2b-0f4e-4c1d-9b1a-2f3e4d5c6b7a)]\nCheck the build"))
        #expect(relayed.label == "From Claude Code · Fix the login")
        #expect(relayed.text == "Check the build")
        #expect(!relayed.isFromCommandLine)
        // A title with quotes of its own keeps them.
        #expect(RelayedMessage(parsing: "[Portals: from Codex · \"Say \"hi\" twice\" (thread 01a1)]\nhi")?.label == "From Codex · Say \"hi\" twice")
        // A title that says "(thread …)" itself keeps it.
        #expect(RelayedMessage(parsing: "[Portals: from Codex · \"Fix (thread safety)\" (thread 01a1)]\nhi")?.label == "From Codex · Fix (thread safety)")
        #expect(RelayedMessage(parsing: "[Portals: from Codex · \"Fix (thread safety)\" (thread 01a1) on mbp16]\nhi")?.label == "From Codex on mbp16 · Fix (thread safety)")
        // A thread with no title, or one titled as its agent, is named by its agent.
        #expect(RelayedMessage(parsing: "[Portals: from Aeri (thread aeri)]\nCheck the build")?.label == "From Aeri")
    }

    @Test func itReadsWithoutItsMarkdownMarks() throws {
        let relayed = try #require(RelayedMessage(parsing: "[Portals: from Claude Code · \"Fix\" (thread 01a1)]\n**Done.** Ran `npm test`:\n\n- 12 passed\n- see [the log](https://example.com/log)"))
        #expect(relayed.text == "**Done.** Ran `npm test`:\n\n- 12 passed\n- see [the log](https://example.com/log)")
        #expect(relayed.plainText == "Done. Ran npm test:\n\n• 12 passed\n• see the log")
    }

    @Test func oneAnotherMacPassedOnSaysWhichMac() {
        #expect(RelayedMessage(parsing: "[Portals: from Claude Code · \"Fix the login\" (thread 6d3c) on mbp16]\nhi")?.label == "From Claude Code on mbp16 · Fix the login")
        let relayed = RelayedMessage(parsing: "[Portals: from the command line on mbp16]\nhi")
        #expect(relayed?.label == "From the command line on mbp16")
        #expect(relayed?.isFromCommandLine == true)
        // Words another bridge chose are shown as they are.
        #expect(RelayedMessage(parsing: "[Portals: from Pi on mini]\nhi")?.label == "From Pi on mini")
    }

    @Test func onlyTheFirstLineMarksIt() {
        #expect(RelayedMessage(parsing: "Look at this\n[Portals: from Aeri (thread aeri)]") == nil)
        #expect(RelayedMessage(parsing: "Fix the login") == nil)
        #expect(RelayedMessage(parsing: "[Portals: from") == nil)
        #expect(RelayedMessage(parsing: "") == nil)
        // The line alone: a message with nothing under it.
        #expect(RelayedMessage(parsing: "[Portals: from the command line]")?.text == "")
    }

    @Test func aTurnFromElsewhereAndAMessageSteeredInAreKnownAsRelayed() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "[Portals: from Codex · \"Review\" (thread 01a1)]\nLook at the diff"), at: t0)
        state.apply(.messageSteered("[Portals: from the command line]\nand the tests"), at: t0)
        state.apply(.messageSteered("my own words"), at: t0)
        let messages = state.transcript.turns.flatMap(\.items).compactMap { item -> UserMessage? in
            if case let .user(message) = item.content { message } else { nil }
        }
        #expect(messages.map(\.relayed?.label) == ["From Codex · Review", "From the command line", nil])
        #expect(messages.map(\.relayed?.text) == ["Look at the diff", "and the tests", nil])
        #expect(messages.map(\.delivery) == [.started, .steered, .steered])
        // The text stays as stored, which is what the host's copy is matched by.
        #expect(messages[0].text == "[Portals: from Codex · \"Review\" (thread 01a1)]\nLook at the diff")
    }

    @Test func aQueuedOneSaysWhoItIsFromWithoutItsFiles() {
        let queued = QueuedMessage(id: "4", text: "[Portals: from the command line]\nRun it\n\n\(SentText.filesHeading)\n- /w/.portals/files/t/a.txt", fromFleet: true)
        #expect(queued.relayed?.label == "From the command line")
        #expect(queued.relayed?.text == "Run it")
        #expect(QueuedMessage(id: "5", text: "Run it").relayed == nil)
    }

    // MARK: Who sent it, as facts (`senders`)

    @Test func theLineIsReadIntoFactsAsTheBridgeWritesIt() throws {
        let far = try #require(RelayedMessage(parsing: "[Portals: from Codex · \"Review\" (thread 7d2a41c09be36f58/019a) on mini]\nhi"))
        #expect(far.from == MessageSender(agentName: "Codex", thread: "019a", title: "Review", machine: "7d2a41c09be36f58", machineName: "mini"))
        #expect(far.label == "From Codex on mini · Review")
        #expect(far.label { $0 == "7d2a41c09be36f58" ? "Mac mini" : nil } == "From Codex on Mac mini · Review")
        // An older bridge named the Mac only by its name: shown as it is.
        let old = try #require(RelayedMessage(parsing: "[Portals: from Claude Code · \"Fix\" (thread 6d3c) on mbp16]\nhi"))
        #expect(old.from == MessageSender(agentName: "Claude Code", thread: "6d3c", title: "Fix", machineName: "mbp16"))
        #expect(old.label { _ in "never asked" } == "From Claude Code on mbp16 · Fix")
        // Another Mac's command line, by its id too.
        let terminal = try #require(RelayedMessage(parsing: "[Portals: from the command line (machine 7d2a41c09be36f58) on Dana's Mac mini]\nhi"))
        #expect(terminal.from == MessageSender(machine: "7d2a41c09be36f58", machineName: "Dana's Mac mini"))
        #expect(terminal.label { _ in "mini" } == "From the command line on mini")
        #expect(terminal.isFromCommandLine)
        // Words another bridge chose are not facts.
        #expect(RelayedMessage(parsing: "[Portals: from Pi on mini]\nhi")?.from == nil)
    }

    @Test func theHostsFactsAreTakenOverTheLine() throws {
        let given = MessageSender(agent: "droid", agentName: "Droid", thread: "d1", title: "Tests")
        let relayed = try #require(RelayedMessage(parsing: "[Portals: from the command line]\nhi", from: given))
        #expect(relayed.label == "From Droid · Tests")
        #expect(!relayed.isFromCommandLine)
        #expect(RelayedMessage(parsing: "[Portals: from Droid (thread d1)]\nhi", from: MessageSender())?.isFromCommandLine == true)
        // Not the fleet's line: not relayed, whatever the facts.
        #expect(RelayedMessage(parsing: "hi", from: given) == nil)
    }

    @Test func aLongTitleComesAfterTheMacSoThatItIsWhatIsCut() {
        let sender = MessageSender(agentName: "Codex", thread: "1", title: "A very long title that goes on", machine: "m", machineName: "mini")
        #expect(sender.words() == "Codex on mini · A very long title that goes on")
        #expect(MessageSender(agentName: "Pi", thread: "p", title: "Pi").words() == "Pi")
        #expect(MessageSender(machineName: "mini").words() == "the command line on mini")
    }

    /// A line longer than any a bridge writes is not read into facts, and its words are
    /// shown cut: reading a crafted one would hold up the row as it is drawn.
    @Test func aCraftedLongLineIsNotReadButShownCut() throws {
        let crafted = "Codex" + String(repeating: " · \"", count: 4_000)
        let started = Date()
        #expect(RelayedMessage.facts(in: crafted) == nil)
        let relayed = try #require(RelayedMessage(parsing: "[Portals: from \(crafted)]\nhi"))
        #expect(relayed.label.count < 100)
        #expect(Date().timeIntervalSince(started) < 0.05)
        // The longest a bridge writes is still read.
        let long = String(repeating: "x", count: 300)
        let written = "Claude Code · \"\(long)\" (thread m1/01a16381-4751-7960-828f-e5effa87bca3) on \(long)"
        #expect(RelayedMessage.facts(in: written)?.machineName == long)
    }

    /// A turn this copy kept (saved before the app read who sent it, or watched while the
    /// host did not say) takes the host's word on who sent its message when they agree.
    @Test func aKeptTurnTakesTheHostsWordOnWhoSentIt() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        let text = "[Portals: from Codex (thread 7d2a/019a) on mini]\nDone"
        func turn(_ from: MessageSender?) -> Turn {
            Turn(startedAt: t0, endedAt: t0.addingTimeInterval(5), outcome: .completed,
                 items: [TurnItem(.user(UserMessage(text: text, sentAt: t0, from: from))), TurnItem(.text("Seen."))])
        }
        let given = MessageSender(agent: "codex", agentName: "Codex", thread: "019a", machine: "7d2a", machineName: "mini")
        let mine = Transcript(turns: [turn(nil)])
        let merged = mine.merged(withHost: Transcript(turns: [turn(given)]))
        #expect(merged.turns.first?.id == mine.turns.first?.id)
        guard case let .user(message)? = merged.turns.first?.items.first?.content else { Issue.record("no message"); return }
        #expect(message.from == given)
        // A host that does not say leaves what this copy has.
        guard case let .user(kept)? = Transcript(turns: [turn(given)]).merged(withHost: Transcript(turns: [turn(nil)])).turns.first?.items.first?.content else { Issue.record("no message"); return }
        #expect(kept.from == given)
    }
}
