import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Messages Hermes writes in the user's place, and what the app shows for them. The
/// texts are the ones Hermes 0.21.5 produces (its templates, and rows from real threads).
@Suite struct HermesHostEventTests {
    private static let loopWakeup = """
        [/loop wakeup #3, every 5m]
        Recurring task: Give Dana a brief live status of the build

        This is an automatic wakeup from the /loop the user set. Perform the task now against the CURRENT state \
        (re-check files, processes, or services fresh — do not assume anything from earlier iterations still holds). \
        Report concisely what you found or did this iteration.
        """
    private static let delegation = """
        [ASYNC DELEGATION BATCH COMPLETE — deleg_d1a6fb08]
        A background fan-out you started has finished. Results follow.
        """
    private static let process = "[IMPORTANT: Background process proc_051143b1ee7a exited (exit code 0).\nCommand: pytest -q\nOutput: …]"

    private func row(_ text: String, kind: String? = nil, metadata: JSONValue? = nil) -> HermesHostEvents.Row {
        var message: [String: JSONValue] = ["role": "user", "text": .string(text)]
        if let kind { message["display_kind"] = .string(kind) }
        if let metadata { message["display_metadata"] = metadata }
        return HermesHostEvents.row(.object(message))
    }

    // MARK: What a stored message is

    @Test func whatTheUserSaidIsTheirMessage() {
        #expect(row("Fix the build") == .message("Fix the build", steered: false))
        #expect(row("/arxiv transformers", kind: "skill_invocation") == .message("/arxiv transformers", steered: false))
        #expect(row("look at the logs first", kind: "steer") == .message("look at the logs first", steered: true))
        // Brackets alone do not make a message the host's.
        #expect(row("[draft] rename the module") == .message("[draft] rename the module", steered: false))
    }

    @Test func aFinishedBackgroundProcessIsOneLine() {
        #expect(row(Self.process, kind: "process_complete", metadata: ["display_text": "Background Process Finished: pytest -q"])
            == .event(HostEvent(.backgroundProcess, "Background Process Finished: pytest -q")))
        #expect(row(Self.process, kind: "process_complete") == .event(HostEvent(.backgroundProcess, "Background process finished")))
    }

    @Test func finishedBackgroundAgentsAreOneLine() {
        #expect(row(Self.delegation, kind: "async_delegation_complete", metadata: ["display_text": "Subagent Task Completed: Audit the simulation"])
            == .event(HostEvent(.backgroundAgents, "Subagent Task Completed: Audit the simulation")))
        // An older Hermes hands the metadata over as JSON text.
        #expect(row(Self.delegation, kind: "async_delegation_complete", metadata: #"{"display_text": "Subagent Tasks Completed: research (3 tasks)"}"#)
            == .event(HostEvent(.backgroundAgents, "Subagent Tasks Completed: research (3 tasks)")))
        #expect(row(Self.delegation, kind: "async_delegation_complete") == .event(HostEvent(.backgroundAgents, "Background agents finished")))
    }

    @Test func aLongTitleIsCutToALineOrTwo() throws {
        let title = "Subagent Task Completed: " + String(repeating: "a very long task title ", count: 20)
        guard case let .event(event) = row(Self.delegation, kind: "async_delegation_complete", metadata: ["display_text": .string(title)]) else {
            Issue.record("expected an event")
            return
        }
        #expect(event.text.count == 140)
        #expect(event.text.hasSuffix("…"))
    }

    @Test func aRecurringTaskComingDueIsOneLineThoughHermesGivesItNoKind() {
        #expect(row(Self.loopWakeup) == .event(HostEvent(.recurringTask, "Recurring task #3 · every 5m: Give Dana a brief live status of the build")))
        #expect(row("[/loop wakeup #1]\nRecurring task: check the deploy\n\nThis is an automatic wakeup…")
            == .event(HostEvent(.recurringTask, "Recurring task #1: check the deploy")))
    }

    @Test func aTurnPickedUpAgainSaysSo() {
        #expect(row("[System note: Your previous turn was interrupted mid-run — the agent…", kind: "auto_continue")
            == .event(HostEvent(.resumed, "Picked up the interrupted turn")))
    }

    @Test func wakesAndNotesToTheModelAreHidden() {
        #expect(row("anything", kind: "hidden") == .hidden)
        #expect(row("[Background process proc_7d0376697616 heartbeat #1 — still running after 5m]\nOutput so far: …") == .hidden)
        #expect(row("[System: The active model for this chat has changed to gpt-6-luna]") == .hidden)
        #expect(row("[System note: Your previous turn was interrupted mid-run]") == .hidden)
    }

    /// Known without the patterns when it does not open with a bracket: the user's words
    /// as they were, spaces and all; with spaces before the bracket, still Hermes's own.
    @Test func whatOpensWithNoBracketIsTheUsersAsItWas() {
        #expect(row("  fix the build\n") == .message("  fix the build\n", steered: false))
        #expect(row("") == .message("", steered: false))
        #expect(row("a [System: note] later") == .message("a [System: note] later", steered: false))
        #expect(row(" \n [System: The active model for this chat has changed]") == .hidden)
        #expect(row("\u{2003}[/loop wakeup #2]\nRecurring task: tidy") == .event(HostEvent(.recurringTask, "Recurring task #2: tidy")))
    }

    @Test func aRequestSaidAgainAfterCompressionIsTheUsersWithoutTheNote() {
        let restated = "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not "
            + "finished yet. Continue it; do not start over.]\n\nResearch cheap hardware for inference"
        #expect(row(restated) == .message("Research cheap hardware for inference", steered: false))
    }

    @Test func whatAMessagingGatewayTellsItsAgentIsKnownByHowItOpens() {
        #expect(row("[Chalk] [ASYNC DELEGATION BATCH COMPLETE — deleg_6fe3e7dd] A background fan-out…", kind: "internal_notification")
            == .event(HostEvent(.backgroundAgents, "Background agents finished")))
        #expect(row("[Chalk] [IMPORTANT: Background process proc_ff7902797e41 exited (exit code 0)", kind: "internal_notification")
            == .event(HostEvent(.backgroundProcess, "Background process finished")))
        #expect(row("Raft wake hint received. New Raft messages may be pending.", kind: "internal_notification")
            == .event(HostEvent(.other, "Automatic message")))
    }

    @Test func aKindThisAppDoesNotKnowIsStillNotTheUsersWords() {
        #expect(row("[SOMETHING NEW] instructions for the model", kind: "goal_checkpoint") == .event(HostEvent(.other, "Automatic step (goal checkpoint)")))
    }

    // MARK: In a thread's history

    @Test func aThreadWithTurnsTheHostStartedReadsAsItHappened() {
        let transcript = HermesHistoryMapper.transcript(from: [
            ["role": "user", "text": "Run the tests in the background", "timestamp": 1],
            ["role": "assistant", "text": "Started them.", "timestamp": 2],
            ["role": "user", "text": .string(Self.process), "timestamp": 3, "display_kind": "process_complete",
             "display_metadata": ["display_text": "Background Process Finished: pytest -q"]],
            ["role": "assistant", "text": "All 14 tests pass.", "timestamp": 4],
            ["role": "user", "text": "wake", "timestamp": 5, "display_kind": "hidden"],
            ["role": "assistant", "text": "Still compiling.", "timestamp": 6],
            ["role": "user", "text": "wake", "timestamp": 7, "display_kind": "hidden"],
            ["role": "user", "text": .string(Self.loopWakeup), "timestamp": 8],
            ["role": "assistant", "text": "Build is green.", "timestamp": 9],
        ])
        #expect(transcript.turns.map { $0.items.map(\.content) } == [
            [.user(UserMessage(text: "Run the tests in the background", sentAt: Date(timeIntervalSince1970: 1), delivery: .started)), .text("Started them.")],
            [.event(HostEvent(.backgroundProcess, "Background Process Finished: pytest -q")), .text("All 14 tests pass.")],
            // A wake shows only as what the agent said to it; one it said nothing to, not at all.
            [.text("Still compiling.")],
            [.event(HostEvent(.recurringTask, "Recurring task #3 · every 5m: Give Dana a brief live status of the build")), .text("Build is green.")],
        ])
    }

    @Test func hermessClosingLineForAFailedTurnIsTheTurnsFailureNotAReply() {
        let transcript = HermesHistoryMapper.transcript(from: [
            ["role": "user", "text": "Deploy it", "timestamp": 1],
            ["role": "assistant", "text": "Your request was not processed. Send it again if you still want me to carry it out.",
             "timestamp": 2, "display_kind": "failed_turn"],
        ])
        #expect(transcript.turns.count == 1)
        #expect(transcript.turns[0].items.count == 1)
        #expect(transcript.turns[0].outcome == .failed(TurnFailure(
            message: "Your request was not processed. Send it again if you still want me to carry it out."
        )))
    }

    @Test func aRunTheHostStartedIsTheStoredTurnItOpenedNotASecondOne() throws {
        let resumed: JSONValue = [
            "session_id": "run-1", "running": true,
            "messages": [
                ["role": "user", "text": "Run the tests in the background", "timestamp": 1],
                ["role": "assistant", "text": "Started them.", "timestamp": 2],
                ["role": "user", "text": .string(Self.loopWakeup), "timestamp": 3],
            ],
            "inflight": ["user": .string(Self.loopWakeup), "assistant": "Checking"],
        ]
        let snapshot = HermesHistoryMapper.snapshot(from: try resumed.decode(HermesWire.SessionResumeResult.self))
        #expect(snapshot.transcript.turns.count == 2)
        let running = try #require(snapshot.transcript.turns.last)
        #expect(running.isRunning)
        #expect(running.items.map(\.content) == [
            .event(HostEvent(.recurringTask, "Recurring task #3 · every 5m: Give Dana a brief live status of the build")),
            .text("Checking"),
        ])
    }

    @Test func aRunStartedByAWakeNotStoredYetOpensWithNothing() throws {
        let resumed: JSONValue = [
            "session_id": "run-1", "running": true,
            "messages": [["role": "user", "text": "hello", "timestamp": 1], ["role": "assistant", "text": "hi", "timestamp": 2]],
            "inflight": ["user": "wake", "display_kind": "hidden", "assistant": "Looking at the new output"],
        ]
        let snapshot = HermesHistoryMapper.snapshot(from: try resumed.decode(HermesWire.SessionResumeResult.self))
        #expect(snapshot.transcript.turns.count == 2)
        #expect(snapshot.transcript.turns[1].items.map(\.content) == [.text("Looking at the new output")])
        #expect(snapshot.transcript.turns[1].isRunning)
    }

    // MARK: Said while it happens

    @Test func theHostSayingWhyItStartsATurnIsAnAnnouncement() {
        func events(kind: String, _ text: String) -> [ThreadEvent] {
            HermesEventMapper.threadEvents(for: GatewayEvent(type: "status.update", sessionID: "s", payload: ["kind": .string(kind), "text": .string(text)]))
        }
        #expect(events(kind: "loop", "↻ /loop wakeup #3 firing…").first == .announced(HostEvent(.recurringTask, "Recurring task #3")))
        #expect(events(kind: "process", "Background Process Finished: pytest -q").first
            == .announced(HostEvent(.backgroundProcess, "Background Process Finished: pytest -q")))
        #expect(events(kind: "process", "Subagent Task Completed: Audit the simulation").first
            == .announced(HostEvent(.backgroundAgents, "Subagent Task Completed: Audit the simulation")))
        // An ordinary status line announces nothing.
        #expect(events(kind: "lifecycle", "Waiting on provider — retrying in 2s") == [.status("Waiting on provider — retrying in 2s")])
    }
}
