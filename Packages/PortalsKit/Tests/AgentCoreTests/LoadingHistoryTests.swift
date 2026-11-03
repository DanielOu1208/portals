import Foundation
import Testing
@testable import AgentCore

/// A thread on the host with nothing of it on the device shows that its history is on its
/// way (a spinner) rather than the start of a new thread, and stops saying so however the
/// history turns out to come: whole, caught up on a stream, or not at all.
@Suite struct LoadingHistoryTests {
    private let turn = Turn(endedAt: .now, outcome: .completed, items: [TurnItem(.user(UserMessage(text: "hi"))), TurnItem(.text("Hello"))])

    @Test func onItsWayUntilTheHostsCopyIsTakenIn() {
        var state = ThreadState()
        state.awaitHistory()
        #expect(state.isLoadingHistory)
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [turn])))
        #expect(!state.isLoadingHistory)
    }

    /// The host's copy of a thread that really is empty: the start of a new thread, not
    /// a spinner.
    @Test func anEmptyThreadTakenInIsNotLoading() {
        var state = ThreadState()
        state.awaitHistory()
        state.apply(.snapshot(ThreadSnapshot(transcript: Transcript())))
        #expect(!state.isLoadingHistory)
        #expect(state.transcript.isEmpty)
    }

    /// An empty thread followed again after a reconnect: the host replays nothing and says
    /// it is caught up, and that is the end of loading (it once spun for ever).
    @Test func anEmptyThreadCaughtUpIsNotLoading() {
        var state = ThreadState()
        state.awaitHistory()
        state.apply(.caughtUp(ThreadInfo()))
        #expect(!state.isLoadingHistory)
    }

    @Test func notWhenItCannotCome() {
        var state = ThreadState()
        state.awaitHistory()
        state.historyNotComing()
        #expect(!state.isLoadingHistory)
    }

    /// Something of it here already (the saved copy): shown, not waited for.
    @Test func notForAThreadWithSomethingToShow() {
        var state = ThreadState(transcript: Transcript(turns: [turn]))
        state.awaitHistory()
        #expect(!state.isLoadingHistory)
    }
}
