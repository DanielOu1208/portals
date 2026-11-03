import Foundation
import Testing
@testable import AgentCore

@Suite struct LeftOnScreenTests {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)

    /// The thread left on screen is opened again while it is listed and not archived.
    @Test func theThreadLeftOnScreenIsFoundAgain() throws {
        let host = HostID(rawValue: "mac")
        let agent = Agent.ID(host: host, name: "claude")
        let kept = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: "t1"), agent: agent), updatedAt: start)
        var archived = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: "t2"), agent: agent), updatedAt: start)
        archived.archived = true
        let left = try #require(LeftOnScreen(saved: LeftOnScreen(host: host, thread: kept.id).saved))
        #expect(left.record(in: [archived, kept]) == kept)
        #expect(left.record(in: [archived]) == nil)
        #expect(LeftOnScreen(host: host, thread: archived.id).record(in: [archived, kept]) == nil)
        // Another host's thread of the same id is not it.
        #expect(LeftOnScreen(host: HostID(rawValue: "other"), thread: kept.id).record(in: [kept]) == nil)
        #expect(LeftOnScreen(saved: nil) == nil)
        #expect(LeftOnScreen(saved: ["host": "mac"]) == nil)
    }

    /// Noted as the app goes away, it is there for the launch of an app ended while away,
    /// once; gone once the app came back (then opened another thread and crashed in front,
    /// say), or was quit.
    @Test func theNoteLastsOnlyWhileTheAppIsAway() throws {
        let suite = "LeftOnScreenTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let note = LeftOnScreenNote(defaults: defaults)
        let host = HostID(rawValue: "mac")
        let a = LeftOnScreen(host: host, thread: ThreadRef.ID(rawValue: "a"))

        // Ended while away: opened again, and only by that launch.
        note.wentAway(with: a)
        #expect(note.takeAtLaunch() == a)
        #expect(note.takeAtLaunch() == nil)

        // Away with A, back, then B opened and a crash in front: not A.
        note.wentAway(with: a)
        note.forget()
        #expect(note.takeAtLaunch() == nil)

        // Away with a new thread on screen: nothing, not the thread left before.
        note.wentAway(with: a)
        note.wentAway(with: nil)
        #expect(note.takeAtLaunch() == nil)
    }
}
