import Foundation
import Testing
@testable import AgentCore

/// A store in a fresh temporary folder, removed when the test ends.
private final class Scratch {
    let store: ThreadStore

    init() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-desk-\(UUID().uuidString)")
        store = ThreadStore(directory: directory)
    }

    deinit {
        try? FileManager.default.removeItem(at: store.directory)
    }

    func write(_ text: String, to file: String) throws {
        let url = store.directory.appendingPathComponent(file)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    func read(_ file: String) throws -> String {
        try String(contentsOf: store.directory.appendingPathComponent(file), encoding: .utf8)
    }
}

private let mac = HostID(rawValue: "mac")
private let claude = Agent.ID(host: mac, name: "claude")
private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

@Suite struct DeskSessionTests {
    private let general = "/Users/dana/coding_projects"

    @Test func aSessionIsCalledByItsTitleAndNamesItsFolder() {
        let session = DeskSession(id: "s1", agent: claude, title: "  Fix the login  ", folder: "/Users/dana/coding_projects/aerirc", state: .closed)
        #expect(session.title == "Fix the login")
        #expect(session.folderName(general: general) == "aerirc")
        #expect(DeskSession(id: "s2", agent: claude, title: " ", folder: general, state: .idle).title == "Untitled session")
        #expect(DeskSession(id: "s3", agent: claude, folder: general, state: .idle).folderName(general: general) == "No project")
    }

    /// A session a terminal has open is never simply continued: the user picks fork or read.
    @Test func onlyASessionNoTerminalHasIsContinuedAtATap() {
        let states: [DeskSession.State] = [.open, .closed, .running, .waiting, .idle]
        let modes = states.map { DeskSession(id: "s", agent: claude, folder: general, state: $0).defaultMode }
        #expect(modes == [nil, .continue, .continue, .continue, .continue])
        #expect(DeskSession(id: "s", agent: claude, folder: general, state: .open).isOpenInTerminal)
        #expect(AdoptMode.allCases.map(\.rawValue) == ["continue", "fork", "read"])
    }

    /// A chat of Cursor's terminal is only forked: a tap asks first, and offers the fork alone.
    @Test func aSessionTheHostOnlyForksIsNeverContinuedAtATap() {
        let chat = DeskSession(id: "c1", agent: claude, folder: general, state: .closed, adoptModes: [.fork])
        #expect(chat.defaultMode == nil)
        #expect(chat.isForkOnly)
        #expect(chat.allows(.fork) && !chat.allows(.continue) && !chat.allows(.read))
        let session = DeskSession(id: "s1", agent: claude, folder: general, state: .closed)
        #expect(session.defaultMode == .continue)
        #expect(!session.isForkOnly)
        #expect(AdoptMode.allCases.allSatisfy(session.allows))
        #expect(!DeskSession(id: "s2", agent: claude, folder: general, state: .open, adoptModes: [.fork, .read]).isForkOnly)
    }

    @Test func aThreadOnlyReadIsTheSessionToFork() {
        let ref = ThreadRef(
            id: ThreadRef.ID(rawValue: "s1"), agent: claude, title: "Edit hello", workingDirectory: "/Users/dana/notes", readOnly: true
        )
        let session = DeskSession(viewOnly: ref)
        #expect(session.id == "s1")
        #expect(session.agent == claude)
        #expect(session.title == "Edit hello")
        #expect(session.folder == "/Users/dana/notes")
        #expect(session.state == .open)
    }

    @Test func aThreadIsOnlyReadWhenItSaysSo() {
        #expect(!ThreadRef(id: ThreadRef.ID(rawValue: "t"), agent: claude).isReadOnly)
        #expect(ThreadRef(id: ThreadRef.ID(rawValue: "t"), agent: claude, readOnly: true).isReadOnly)
        // false is stored as nothing, as in every thread from before.
        #expect(ThreadRef(id: ThreadRef.ID(rawValue: "t"), agent: claude, readOnly: false).readOnly == nil)
    }

    @Test func aThreadOnlyReadStaysSoInTheStoreAndOthersSaveAsBefore() throws {
        let scratch = Scratch()
        let viewOnly = ThreadRef(id: ThreadRef.ID(rawValue: "r"), agent: claude, title: "Read me", createdAt: t0, workingDirectory: general, readOnly: true)
        let continued = ThreadRef(id: ThreadRef.ID(rawValue: "c"), agent: claude, title: "Go on", createdAt: t0, workingDirectory: general)
        scratch.store.saveThreads([ThreadRecord(ref: viewOnly, updatedAt: t0), ThreadRecord(ref: continued, updatedAt: t0)])
        let loaded = scratch.store.loadThreads()
        #expect(loaded.first { $0.id.rawValue == "r" }?.ref.isReadOnly == true)
        #expect(loaded.first { $0.id.rawValue == "c" }?.ref.isReadOnly == false)
        // Only the thread that is read says so.
        let text = try scratch.read("threads.json")
        #expect(text.components(separatedBy: "readOnly").count == 2)
    }

    @Test func agentsSavedBeforeForkCapabilityRemainUnsupported() throws {
        let old = Data(#"{"id":{"host":"mac","name":"droid"},"displayName":"Droid","isDefault":false,"kind":"droid"}"#.utf8)
        let agent = try JSONDecoder().decode(Agent.self, from: old)
        #expect(agent.adoptModes == nil)
        let supported = Agent(id: agent.id, adoptModes: [.continue, .fork, .read])
        #expect(try JSONDecoder().decode(Agent.self, from: JSONEncoder().encode(supported)).adoptModes == [.continue, .fork, .read])
    }

    /// A bridge from before `adopt_modes` (0.3.0) still forks a thread only read, as the
    /// note under it always offered; any other thread is forked only where the agent says.
    @Test func aThreadOnlyReadIsForkedAlsoOnABridgeThatDoesNotSayHowItAdopts() {
        let viewOnly = ThreadRef(id: ThreadRef.ID(rawValue: "r"), agent: claude, readOnly: true)
        let writable = ThreadRef(id: ThreadRef.ID(rawValue: "w"), agent: claude)
        let ongoing = ThreadRef(id: ThreadRef.ID(rawValue: "o"), agent: claude, ongoing: true)
        let old = Agent(id: claude)
        #expect(old.forks(viewOnly))
        #expect(!old.forks(writable))
        let forking = Agent(id: claude, adoptModes: [.continue, .fork, .read])
        #expect(forking.forks(viewOnly))
        #expect(forking.forks(writable))
        #expect(!forking.forks(ongoing))
        let notForking = Agent(id: claude, adoptModes: [.continue, .read])
        #expect(!notForking.forks(viewOnly))
        #expect(!notForking.forks(writable))
    }

    /// Saved by the app before threads could be only read (M14): every thread still loads.
    @Test func threadsSavedBeforeLoadInFull() throws {
        let scratch = Scratch()
        try scratch.write(Self.legacyThreads, to: "threads.json")
        let threads = scratch.store.loadThreads()
        #expect(threads.map(\.id.rawValue) == ["d79e5f20-1c34-42d6-af39-5d38504e8bab", "a3368c03-66f6-4675-94be-f1392512a4db"])
        #expect(threads.allSatisfy { !$0.ref.isReadOnly && $0.ref.readOnly == nil })
        #expect(threads[0].ref.workingDirectory == "/Users/dana/coding_projects/aerirc")
    }

    static let legacyThreads = #"[{"context":{"limit":1000000,"used":26670},"preview":"In hello.txt change the line hi to hello.","ref":{"agent":{"host":"mac","name":"claude"},"createdAt":"2026-10-07T02:14:51Z","id":"d79e5f20-1c34-42d6-af39-5d38504e8bab","title":"hello.txt line edit","workingDirectory":"\/Users\/dana\/coding_projects\/aerirc"},"updatedAt":"2026-10-07T02:15:11Z"},{"preview":"Please think.","ref":{"agent":{"host":"local","name":"fake"},"createdAt":"2026-10-06T23:22:04Z","id":"a3368c03-66f6-4675-94be-f1392512a4db"},"updatedAt":"2026-10-06T23:22:04Z"}]"#
}
