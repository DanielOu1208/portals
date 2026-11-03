import Foundation
import Testing
@testable import AgentCore

/// Test connection in a host's sheet (`HostSettingsSheet`): what the button and the line
/// under it show as a try begins, ends and is stopped.
@Suite struct ConnectionTrialTests {
    @Test func aTryRunsThenSaysHowItWent() {
        var trial = ConnectionTrial()
        #expect(trial.phase == .none)
        let id = trial.begin(cancelled: false)
        #expect(trial.phase == .running)
        trial.end(id, with: .success(3), cancelled: false)
        #expect(trial.phase == .passed(agents: 3))
        let again = trial.begin(cancelled: false)
        trial.end(again, with: .failure("No answer"), cancelled: false)
        #expect(trial.phase == .failed("No answer"))
    }

    /// Stopped before its task's first turn (a field changed just after the tap): it never
    /// begins, and the spinner never comes. It began anyway and its stopped end left it
    /// running for good, the button disabled, until another edit (Codex's review of the
    /// battery fixes).
    @Test func aTryStoppedBeforeItBeginsShowsNothing() {
        var trial = ConnectionTrial()
        trial.reset()
        let id = trial.begin(cancelled: true)
        #expect(id == nil)
        #expect(trial.phase == .none)
        trial.end(id, with: .failure("cancelled"), cancelled: true)
        #expect(trial.phase == .none)
    }

    /// Stopped while it runs (the sheet's own reset came first, or not): it ends showing
    /// nothing, never still running.
    @Test func aTryStoppedWhileItRunsEndsShowingNothing() {
        var trial = ConnectionTrial()
        let id = trial.begin(cancelled: false)
        trial.end(id, with: .failure("cancelled"), cancelled: true)
        #expect(trial.phase == .none)
    }

    /// A try overtaken by a newer one says nothing of how it went: the newer one does.
    @Test func anOvertakenTryChangesNothing() {
        var trial = ConnectionTrial()
        let first = trial.begin(cancelled: false)
        let second = trial.begin(cancelled: false)
        trial.end(first, with: .success(1), cancelled: false)
        #expect(trial.phase == .running)
        trial.end(first, with: .success(1), cancelled: true)
        #expect(trial.phase == .running)
        trial.end(second, with: .success(2), cancelled: false)
        #expect(trial.phase == .passed(agents: 2))
    }

    /// What was typed changed: whatever a try said is about something else.
    @Test func aResetForgetsTheTry() {
        var trial = ConnectionTrial()
        let id = trial.begin(cancelled: false)
        trial.reset()
        #expect(trial.phase == .none)
        trial.end(id, with: .success(4), cancelled: false)
        #expect(trial.phase == .none)
    }
}
