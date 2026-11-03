import Foundation
import Testing
@testable import AgentCore

@MainActor
@Suite struct AttachmentIntakeTests {
    @MainActor private final class Gate {
        private var continuation: CheckedContinuation<Void, Never>?
        private(set) var entered = false

        func wait() async {
            await withCheckedContinuation {
                continuation = $0
                entered = true
            }
        }

        func waitUntilEntered() async {
            while !entered { await Task.yield() }
        }

        func release() {
            continuation?.resume()
            continuation = nil
        }
    }

    @Test func intakeIsPendingBeforeItsWorkCanStart() async {
        let intake = AttachmentIntake()
        var ran = false
        let task = intake.run { token in
            #expect(intake.accepts(token))
            ran = true
        }
        #expect(intake.isPending)
        #expect(!ran)
        await task.value
        #expect(ran)
        #expect(!intake.isPending)
    }

    @Test func sendWaitsForEveryOverlappingBatch() async {
        let intake = AttachmentIntake()
        let first = Gate(), second = Gate()
        var attachments: [String] = []
        let a = intake.run { token in
            await first.wait()
            if intake.accepts(token) { attachments.append("first") }
        }
        let b = intake.run { token in
            await second.wait()
            if intake.accepts(token) { attachments.append("second") }
        }
        await first.waitUntilEntered()
        await second.waitUntilEntered()
        #expect(intake.isPending)
        first.release()
        await a.value
        #expect(attachments == ["first"])
        // A ready attachment must not enable Send while the other batch still waits.
        #expect(intake.isPending)
        second.release()
        await b.value
        #expect(!intake.isPending)
        #expect(attachments == ["first", "second"])
    }

    @Test func navigationRejectsLateResultsWithoutEndingTheNextBatch() async {
        let intake = AttachmentIntake()
        let old = Gate(), current = Gate()
        var attachments: [String] = []
        let a = intake.run { token in
            await old.wait() // Deliberately does not cooperate with cancellation.
            if intake.accepts(token) { attachments.append("old") }
        }
        await old.waitUntilEntered()
        intake.cancelAll()
        #expect(!intake.isPending)
        let b = intake.run { token in
            await current.wait()
            if intake.accepts(token) { attachments.append("current") }
        }
        await current.waitUntilEntered()
        old.release()
        await a.value
        #expect(attachments.isEmpty)
        #expect(intake.isPending)
        current.release()
        await b.value
        #expect(attachments == ["current"])
        #expect(!intake.isPending)
    }

    @Test func failedOrCancelledWorkLeavesNoPendingIntake() async {
        let intake = AttachmentIntake()
        let failed = intake.run { _ in
            let unreadable: Data? = nil
            guard unreadable != nil else { return }
            Issue.record("An unreadable attachment was accepted")
        }
        await failed.value
        #expect(!intake.isPending)

        var ran = false
        let cancelled = intake.run { _ in ran = true }
        cancelled.cancel()
        await cancelled.value
        #expect(!ran)
        #expect(!intake.isPending)
    }

    @Test func cancelledBeforeStartingStillCleansUpItsDroppedFiles() async {
        let intake = AttachmentIntake()
        var cleanups = 0
        var ran = false
        let task = intake.run(cleanup: { cleanups += 1 }) { _ in ran = true }
        intake.cancelAll()
        await task.value
        #expect(!ran)
        #expect(cleanups == 1)
        #expect(!intake.isPending)
    }
}
