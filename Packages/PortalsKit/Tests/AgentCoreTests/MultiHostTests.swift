import Foundation
import Testing
@testable import AgentCore

/// A store in a fresh temporary folder, removed when the test ends.
private final class Scratch {
    let store: ThreadStore

    init() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-hosts-\(UUID().uuidString)")
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

    func exists(_ file: String) -> Bool {
        FileManager.default.fileExists(atPath: store.directory.appendingPathComponent(file).path)
    }
}

private let local = HostID(rawValue: "local")
private let mini = HostID(rawValue: "mini")
private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

private func record(_ id: String, host: HostID = mini, agent: String = "hanni", title: String? = nil, preview: String? = nil, updated: TimeInterval = 0) -> ThreadRecord {
    ThreadRecord(
        ref: ThreadRef(id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: host, name: agent), title: title, createdAt: t0),
        updatedAt: t0.addingTimeInterval(updated),
        preview: preview
    )
}

/// A transcript of one finished turn: a running one would load as stopped.
private func finished(_ text: String, images: [AttachedImage] = []) -> Transcript {
    var state = ThreadState()
    state.messageSent(text, images: images, at: t0)
    state.apply(.turnFinished(.completed, finalText: nil), at: t0)
    return state.transcript
}

private func agent(_ name: String, on host: HostID, isDefault: Bool = false) -> Agent {
    Agent(id: Agent.ID(host: host, name: name), isDefault: isDefault)
}

// MARK: - Files written before there were several hosts

/// The files as the app wrote them before this change, captured from a simulator (and,
/// for hosts, from the encoder as it was). Everything in them must still load: the
/// store reads a whole file or nothing, so one field the new code requires would lose
/// every thread.
@Suite struct LegacyFileTests {
    static let hostsJSON = #"[{"id":"local","name":"This Mac","url":"http:\/\/127.0.0.1:9119"},{"id":"0C5B7F4E-2D1A-4E8B-9F3C-6A7D8E9F0A1B","name":"Mini","url":"https:\/\/mini.example.ts.net:10008","username":"dana"}]"#

    static let threadsJSON = #"[{"context":{"limit":258400,"used":24364},"preview":"In hello.txt change the line hi to hello, then run cat hello.txt and tell me what it says.","ref":{"agent":{"host":"local","name":"codex"},"createdAt":"2026-10-07T02:16:05Z","id":"01a11425-838d-7882-9301-2b64d09a8ac5","title":"In hello.txt change the line hi to hello, then run cat hello.txt and tell me wh…"},"updatedAt":"2026-10-07T02:16:13Z"},{"context":{"limit":1000000,"used":26670},"preview":"In hello.txt change the line hi to hello, then run cat hello.txt and tell me what it says.","ref":{"agent":{"host":"local","name":"claude"},"createdAt":"2026-10-07T02:14:51Z","id":"d79e5f20-1c34-42d6-af39-5d38504e8bab","title":"hello.txt line edit"},"updatedAt":"2026-10-07T02:15:11Z"},{"context":{"limit":200000,"used":25047},"preview":"Run the shell command 'sleep 20; echo finished' with Bash, then reply with the word complete.","ref":{"agent":{"host":"local","name":"claude"},"createdAt":"2026-10-07T00:20:16Z","id":"83262915-80cd-409e-a4ee-4c2ffccb2768","title":"Shell command execution"},"updatedAt":"2026-10-07T00:20:16Z"},{"context":{"limit":200000,"used":25271},"preview":"Read hello.txt, then use the Edit tool to change the line hi to hello, then run cat hello.txt and tell me what it says.","ref":{"agent":{"host":"local","name":"claude"},"createdAt":"2026-10-07T00:18:07Z","id":"18dbfce6-8871-412f-8a4b-a1adb7085665","title":"hello.txt edit"},"updatedAt":"2026-10-07T00:18:14Z"},{"preview":"Please think, use a tool and then approve a command.","ref":{"agent":{"host":"local","name":"fake"},"createdAt":"2026-10-06T23:22:04Z","id":"a3368c03-66f6-4675-94be-f1392512a4db"},"updatedAt":"2026-10-06T23:22:04Z"}]"#

    static let agentsJSON = #"[{"displayName":"Claude Code","id":{"host":"local","name":"claude"},"isDefault":true,"model":"default","summary":"Claude Code on this Mac, with your own settings and sign-in."},{"displayName":"Codex","id":{"host":"local","name":"codex"},"isDefault":false,"model":"gpt-6.1-sol","summary":"Codex on this Mac, with your own settings and sign-in."}]"#

    static let looksJSON = #"[{"agent":{"host":"local","name":"claude"},"look":{"face":3,"shape":7,"tint":11}},{"agent":{"host":"local","name":"codex"},"look":{"face":2,"shape":4,"tint":6}},{"agent":{"host":"local","name":"fake"},"look":{"face":1,"shape":4,"tint":10}}]"#

    static let transcriptJSON = #"{"turns":[{"endedAt":"2026-10-07T00:20:42Z","id":"3B315079-58A5-46CC-B76B-6F5F38755663","items":[{"content":{"user":{"_0":{"delivery":"started","images":[],"sentAt":"2026-10-07T00:20:16Z","text":"Run the shell command 'sleep 20; echo finished' with Bash, then reply with the word complete."}}},"id":"26154BEB-2B31-49E1-B091-5F51768679BF"},{"content":{"reasoning":{"_0":{"endedAt":"2026-10-07T00:20:20Z","startedAt":"2026-10-07T00:20:16Z","text":"The user is asking me to run a shell command that sleeps for 20 seconds and then echoes \"finished\", then reply with the word \"complete\".\n\nI should use the Bash tool to run this command. Since it's a 20-second sleep, I should set run_in_background to true so it doesn't block unnecessarily.\n\nActually, let me reconsider. The user wants me to run it and then reply with \"complete\". If I run it in the background, I'll need to wait for it to complete first. Let me just run it as a foreground command with a timeout of at least 20 seconds.\n\nLooking at the Bash tool parameters, I can set a timeout. The default is 120000ms (2 minutes), which is more than enough for a 20-second sleep. I'll run it as a normal foreground command."}}},"id":"95486665-A71D-49EA-89E9-874F4923B4C1"},{"content":{"tool":{"_0":{"id":"toolu_01RTyaPdEemj9dwymhQtVpac","input":"sleep 20; echo finished","label":"sleep 20; echo finished","name":"terminal","output":"finished","startedAt":"2026-10-07T00:20:40Z","state":"succeeded"}}},"id":"DEC6CF0B-CE67-4CB8-B1CB-4F279EC06D98"},{"content":{"reasoning":{"_0":{"endedAt":"2026-10-07T00:20:42Z","startedAt":"2026-10-07T00:20:40Z","text":"Good, the command ran successfully and completed after 20 seconds. The output shows \"finished\" which is what we expected. Now I just need to reply with the word \"complete\" as requested."}}},"id":"5AA5DEB8-67FE-4EF3-A94C-9949FEA86D5A"},{"content":{"text":{"_0":"complete"}},"id":"4078DCF6-875A-41D1-B7B7-01043124C7B5"}],"outcome":{"completed":{}},"startedAt":"2026-10-07T00:20:16Z"}]}"#

    private func scratch(with files: [String: String]) throws -> Scratch {
        let scratch = Scratch()
        for (file, text) in files { try scratch.write(text, to: file) }
        return scratch
    }

    @Test func oldHostsLoadWithNoKind() throws {
        let scratch = try scratch(with: ["hosts.json": Self.hostsJSON])
        let hosts = scratch.store.loadHosts()
        #expect(hosts.map(\.id.rawValue) == ["local", "0C5B7F4E-2D1A-4E8B-9F3C-6A7D8E9F0A1B"])
        #expect(hosts.map(\.name) == ["This Mac", "Mini"])
        #expect(hosts[0].url.absoluteString == "http://127.0.0.1:9119")
        #expect(hosts[0].username == nil)
        #expect(hosts[1].url.absoluteString == "https://mini.example.ts.net:10008")
        #expect(hosts[1].username == "dana")
        #expect(hosts.allSatisfy { $0.kind == nil })
    }

    @Test func aHostWithNoKindIsSavedAsBefore() throws {
        let scratch = try scratch(with: ["hosts.json": Self.hostsJSON])
        scratch.store.saveHosts(scratch.store.loadHosts())
        let saved = try String(contentsOf: scratch.store.directory.appendingPathComponent("hosts.json"), encoding: .utf8)
        #expect(saved == Self.hostsJSON)
    }

    @Test func oldThreadsLoadInFull() throws {
        let scratch = try scratch(with: ["threads.json": Self.threadsJSON])
        let threads = scratch.store.loadThreads()
        #expect(threads.count == 5)
        #expect(threads.map(\.id.rawValue) == [
            "01a11425-838d-7882-9301-2b64d09a8ac5", "d79e5f20-1c34-42d6-af39-5d38504e8bab",
            "83262915-80cd-409e-a4ee-4c2ffccb2768", "18dbfce6-8871-412f-8a4b-a1adb7085665",
            "a3368c03-66f6-4675-94be-f1392512a4db",
        ])
        #expect(threads.allSatisfy { $0.key.host == local })
        #expect(threads[1].ref.title == "hello.txt line edit")
        #expect(threads[1].context == ContextUsage(used: 26670, limit: 1_000_000))
        #expect(threads[4].ref.title == nil)
        #expect(threads[4].context == nil)
        // Nothing a host that keeps the list says is in them.
        #expect(threads.allSatisfy { $0.startedBy == nil && $0.revision == nil && $0.fromHost == nil && $0.localOnly == nil })
    }

    /// A thread as the app saved it just before hosts kept the list: pins, archive and
    /// unseen marks of its own, a folder, taken up only to read.
    static let markedThreadsJSON = #"[{"archived":true,"context":{"limit":200000,"used":25047},"pinned":true,"preview":"Run the tests","ref":{"agent":{"host":"local","name":"claude"},"createdAt":"2026-10-10T02:14:51Z","id":"d79e5f20-1c34-42d6-af39-5d38504e8bab","readOnly":true,"title":"Run the tests","workingDirectory":"\/Users\/dev\/coding_projects\/app"},"unseen":true,"updatedAt":"2026-10-10T02:15:11Z"}]"#

    @Test func threadsSavedBeforeHostsKeptTheListReadAndSaveAsBefore() throws {
        let scratch = try scratch(with: ["threads.json": Self.markedThreadsJSON])
        let thread = try #require(scratch.store.loadThreads().first)
        #expect(thread.isPinned && thread.isArchived && thread.isUnseen)
        #expect(thread.ref.isReadOnly)
        #expect(thread.ref.workingDirectory == "/Users/dev/coding_projects/app")
        #expect(!thread.isFromHost && !thread.isLocalOnly)
        #expect(thread.startedBy == nil && thread.revision == nil)
        scratch.store.saveThreads(scratch.store.loadThreads())
        let saved = try String(contentsOf: scratch.store.directory.appendingPathComponent("threads.json"), encoding: .utf8)
        #expect(saved == Self.markedThreadsJSON)
    }

    @Test func oldAgentsAndLooksLoadInFull() throws {
        let scratch = try scratch(with: ["agents.json": Self.agentsJSON, "looks.json": Self.looksJSON])
        let agents = scratch.store.loadAgents()
        #expect(agents.map(\.id) == [Agent.ID(host: local, name: "claude"), Agent.ID(host: local, name: "codex")])
        #expect(agents.map(\.displayName) == ["Claude Code", "Codex"])
        #expect(agents[0].isDefault)
        #expect(agents[1].model == "gpt-6.1-sol")
        // Saved before a bridge said what kind each agent is.
        #expect(agents.allSatisfy { $0.kind == nil })
        let looks = scratch.store.loadLooks()
        #expect(looks.count == 3)
        #expect(looks[Agent.ID(host: local, name: "claude")] == AgentLook(shape: 7, face: 3, tint: 11))
        #expect(looks[Agent.ID(host: local, name: "fake")] == AgentLook(shape: 4, face: 1, tint: 10))
    }

    @Test func anOldTranscriptIsMovedIntoItsHostsFolderWhenRead() throws {
        let id = ThreadRef.ID(rawValue: "83262915-80cd-409e-a4ee-4c2ffccb2768")
        let old = "transcripts/83262915-80cd-409e-a4ee-4c2ffccb2768.json"
        let new = "transcripts/local/83262915-80cd-409e-a4ee-4c2ffccb2768.json"
        let scratch = try scratch(with: [old: Self.transcriptJSON])

        let transcript = try #require(scratch.store.loadTranscript(for: ThreadKey(host: local, id: id)))
        #expect(transcript.turns.count == 1)
        #expect(transcript.turns[0].outcome == .completed)
        #expect(transcript.turns[0].items.count == 5)
        #expect(transcript.turns[0].items.last?.content == .text("complete"))
        // Written to the new place, byte for byte, and only then removed from the old.
        #expect(!scratch.exists(old))
        #expect(try String(contentsOf: scratch.store.directory.appendingPathComponent(new), encoding: .utf8) == Self.transcriptJSON)
        // And read from there from now on.
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: local, id: id)) == transcript)
    }

    @Test func aNewerCopyInTheHostsFolderWinsOverAnOldOne() throws {
        let id = ThreadRef.ID(rawValue: "t1")
        let scratch = try scratch(with: ["transcripts/t1.json": Self.transcriptJSON])
        let newer = finished("newer")
        scratch.store.saveTranscript(newer, for: ThreadKey(host: local, id: id))
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: local, id: id)) == newer)
    }

    @Test func deletingAThreadAlsoRemovesAnOldCopyNeverRead() throws {
        let scratch = try scratch(with: ["transcripts/t1.json": Self.transcriptJSON])
        scratch.store.deleteTranscript(for: ThreadKey(host: local, id: ThreadRef.ID(rawValue: "t1")))
        #expect(!scratch.exists("transcripts/t1.json"))
    }
}

// MARK: - Hosts

@Suite struct HostKindTests {
    @Test func aBridgeIsRememberedAsOne() throws {
        let scratch = Scratch()
        let bridge = HostConfig(id: HostID(rawValue: "mbp"), name: "MacBook", url: URL(string: "https://mbp.example.ts.net:9443")!, username: "dana", kind: .bridge)
        scratch.store.saveHosts([bridge])
        #expect(scratch.store.loadHosts() == [bridge])
    }

    @Test func aKindFromANewerAppReadsAsNoneAndKeepsTheHost() throws {
        let scratch = Scratch()
        try scratch.write(#"[{"id":"x","kind":"something-new","name":"X","url":"https:\/\/x.example"},{"id":"y","kind":7,"name":"Y","url":"https:\/\/y.example"}]"#, to: "hosts.json")
        let hosts = scratch.store.loadHosts()
        #expect(hosts.map(\.id.rawValue) == ["x", "y"])
        #expect(hosts.allSatisfy { $0.kind == nil })
    }
}

@Suite struct ThreadKeyTests {
    @Test func theSameIDOnTwoHostsIsTwoThreads() {
        let one = record("20261005_000000_abc123", host: local)
        let two = record("20261005_000000_abc123", host: mini)
        #expect(one.id == two.id)
        #expect(one.key != two.key)
        #expect(Set([one.key, two.key]).count == 2)
        // The id inside is still what the host knows the thread by.
        #expect(one.key.id.rawValue == "20261005_000000_abc123")
        #expect(one.key == ThreadKey(host: local, id: ThreadRef.ID(rawValue: "20261005_000000_abc123")))
        #expect(one.ref.key == one.key)
    }

    @Test func transcriptsWithTheSameIDOnTwoHostsAreKeptApart() {
        let scratch = Scratch()
        let id = ThreadRef.ID(rawValue: "same")
        let first = finished("on this Mac"), second = finished("on the mini")
        scratch.store.saveTranscript(first, for: ThreadKey(host: local, id: id))
        scratch.store.saveTranscript(second, for: ThreadKey(host: mini, id: id))
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: local, id: id)) == first)
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: mini, id: id)) == second)

        scratch.store.deleteTranscript(for: ThreadKey(host: local, id: id))
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: local, id: id)) == nil)
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: mini, id: id)) == second)
    }

    @Test func forgettingAHostLeavesTheOthersAlone() throws {
        let scratch = Scratch()
        let image = ImageAttachment(data: Data([1, 2, 3]), filename: "photo.jpg")
        scratch.store.saveImage(image.data, id: image.id)
        let withImage = finished("look", images: [image.reference]), transcript = finished("hello")
        scratch.store.saveThreads([record("a", host: local, agent: "claude"), record("b", host: mini), record("c", host: local, agent: "codex")])
        scratch.store.saveTranscript(withImage, for: record("a", host: local, agent: "claude").key)
        scratch.store.saveTranscript(transcript, for: record("b", host: mini).key)
        try scratch.write(LegacyFileTests.transcriptJSON, to: "transcripts/c.json")
        scratch.store.saveAgents([agent("claude", on: local), agent("hanni", on: mini)])
        scratch.store.saveLooks([
            Agent.ID(host: local, name: "claude"): AgentLook(shape: 1, face: 1, tint: 1),
            Agent.ID(host: mini, name: "hanni"): AgentLook(shape: 2, face: 2, tint: 2),
        ])

        scratch.store.forgetHost(local)

        #expect(scratch.store.loadThreads().map(\.key) == [record("b", host: mini).key])
        #expect(!scratch.exists("transcripts/local"))
        #expect(!scratch.exists("transcripts/c.json"))
        #expect(scratch.store.loadTranscript(for: record("b", host: mini).key) == transcript)
        #expect(scratch.store.loadAgents().map(\.id.host) == [mini])
        #expect(scratch.store.loadLooks().keys.map(\.host) == [mini])
        // Images sent in its threads go with them.
        #expect(scratch.store.loadImage(image.id) == nil)
    }
}

// MARK: - Sidebar

@Suite struct SidebarSectionsTests {
    private let hosts = [
        HostConfig(id: mini, name: "Mini", url: URL(string: "https://mini.example")!),
        HostConfig(id: local, name: "MacBook", url: URL(string: "http://127.0.0.1:9120")!, kind: .bridge),
    ]

    // MARK: Layout

    private func coding(_ id: String, _ agent: String, in folder: String?, updated: TimeInterval, pinned: Bool = false, archived: Bool = false) -> ThreadRecord {
        ThreadRecord(
            ref: ThreadRef(id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: local, name: agent), createdAt: t0, workingDirectory: folder),
            updatedAt: t0.addingTimeInterval(updated),
            pinned: pinned,
            archived: archived
        )
    }

    @Test func eachThreadKeepsItsPlaceUnderItsAgentAndTheOnesAtWorkAreOnTopAsWell() {
        let agents = [agent("claude", on: local), agent("codex", on: local), agent("hanni", on: mini)]
        let folder = "/Users/dev/coding_projects/aerirc"
        let threads = [
            coding("waits", "claude", in: folder, updated: 60, archived: true),
            coding("runs", "codex", in: folder, updated: 50, pinned: true),
            coding("newer", "claude", in: folder, updated: 45),
            coding("pinned", "claude", in: folder, updated: 40, pinned: true),
            coding("archived", "claude", in: folder, updated: 30, archived: true),
            coding("plain", "claude", in: folder, updated: 20),
            coding("x1", "codex", in: folder, updated: 10),
            record("h1", host: mini, agent: "hanni", updated: 5),
        ]
        let layout = SidebarLayout.build(
            hosts: hosts, agents: agents, threads: threads, waiting: [threads[0].key], running: [threads[1].key]
        )
        // Something to answer shows even in an archived thread, which stays archived.
        #expect(layout.top.waiting.map(\.id.rawValue) == ["waits"])
        #expect(layout.top.recent.isEmpty)
        #expect(layout.top.running.map(\.id.rawValue) == ["runs"])
        #expect(layout.spaces.flatMap(\.archived).map(\.id.rawValue) == ["waits", "archived"])
        // Hosts in the order they were added, agents as each host lists them, on hosts
        // whose agents work in no folder each a bot with its threads. The one running is
        // under its agent all the while.
        #expect(layout.spaces.map(\.id) == [mini, local])
        #expect(layout.spaces[0].bots.map { $0.threads.map(\.id.rawValue) } == [["h1"]])
        #expect(layout.spaces[1].bots.map { $0.threads.map(\.id.rawValue) } == [["newer", "pinned", "plain"], ["runs", "x1"]])
    }

    @Test func aThreadFinishedOutOfSightIsOnTopAsWellUntilItIsOpened() {
        let agents = [agent("claude", on: local)]
        var done = coding("done", "claude", in: "/Users/dev/coding_projects/aerirc", updated: 30)
        done.unseen = true
        var runs = coding("runs", "claude", in: "/Users/dev/coding_projects/aerirc", updated: 20)
        runs.unseen = true
        let plain = coding("plain", "claude", in: "/Users/dev/coding_projects/aerirc", updated: 10)
        let layout = SidebarLayout.build(hosts: [hosts[1]], agents: agents, threads: [done, runs, plain], waiting: [], running: [runs.key])
        // Running again, it is running; finished and not opened, it is under Finished.
        // Under their agent, both are where they were.
        #expect(layout.top.running.map(\.id.rawValue) == ["runs"])
        #expect(layout.top.finished.map(\.id.rawValue) == ["done"])
        #expect(layout.spaces[0].bots[0].threads.map(\.id.rawValue) == ["done", "runs", "plain"])
    }

    // MARK: By project

    @Test func byProjectAThreadIsUnderItsFolderWhicheverAgentItIsWith() {
        var macBook = hosts[1]
        macBook.generalFolder = "/Users/dev/Portals"
        let agents = [agent("claude", on: local), agent("codex", on: local), agent("hanni", on: mini)]
        let aerirc = "/Users/dev/coding_projects/aerirc"
        // A host that offers no folders may still say where a thread ran.
        var elsewhere = record("h1", host: mini, agent: "hanni", updated: 70)
        elsewhere.ref.workingDirectory = "/Users/dev/somewhere"
        let threads = [
            elsewhere,
            coding("g1", "claude", in: "/Users/dev/Portals", updated: 60),
            coding("a1", "claude", in: aerirc, updated: 50),
            coding("a2", "codex", in: aerirc, updated: 40, pinned: true),
            coding("old", "claude", in: nil, updated: 5),
        ]
        let layout = SidebarLayout.build(
            hosts: [hosts[0], macBook], agents: agents, threads: threads, waiting: [], running: [], withFolders: [local]
        )
        #expect(layout.spaces.map(\.id) == [mini, local])
        // No folders on this host: its agents, each a bot.
        #expect(layout.spaces[0].folders.isEmpty)
        #expect(layout.spaces[0].bots.map { $0.threads.map(\.id.rawValue) } == [["h1"]])
        // In each folder, a pinned thread ahead of the others.
        let projects = layout.spaces[1].folders
        // No project, the General folder, is last, whenever it was worked in. A thread
        // saved before folders were kept is in it.
        #expect(projects.map(\.name) == ["aerirc", "No project"])
        #expect(projects.map(\.id.path) == [aerirc, "/Users/dev/Portals"])
        #expect(projects.map(\.isGeneral) == [false, true])
        #expect(projects.map { $0.threads.map(\.id.rawValue) } == [["a2", "a1"], ["old", "g1"]])
        #expect(layout.spaces[1].bots.isEmpty)
    }

    /// A thread working in a git worktree is under its repository's project, with its
    /// branch on its row; the worktree is never a project of its own, also once it is gone
    /// (the host keeps `repo`). Its own folder stays the one it works in.
    @Test func byProjectAThreadInAWorktreeIsUnderItsRepository() {
        var macBook = hosts[1]
        macBook.generalFolder = "/Users/dev/Portals"
        let agents = [agent("claude", on: local), agent("codex", on: local)]
        let portals = "/Users/dev/coding_projects/Portals"
        var night = coding("w1", "claude", in: "/Users/dev/coding_projects/portals-night", updated: 60)
        night.repo = portals
        night.branch = "night/plan"
        var nested = coding("w2", "codex", in: "/Users/dev/coding_projects/portals-night/bridge", updated: 50)
        nested.repo = portals + "/bridge"
        nested.branch = "night/plan"
        var detached = coding("w3", "codex", in: "/Users/dev/coding_projects/portals-review", updated: 45)
        detached.repo = portals
        var main = coding("m1", "claude", in: portals, updated: 40)
        main.branch = "main"
        let layout = SidebarLayout.build(
            hosts: [macBook], agents: agents, threads: [night, nested, detached, main], waiting: [], running: [], withFolders: [local]
        )
        let projects = layout.spaces[0].folders
        #expect(projects.map(\.id.path) == [portals, portals + "/bridge"])
        #expect(projects.map { $0.threads.map(\.id.rawValue) } == [["w3", "w1", "m1"], ["w2"]])
        #expect(night.ref.workingDirectory == "/Users/dev/coding_projects/portals-night")
        // Its row's branch: a worktree's thread says it, the main checkout's does not.
        #expect([night, detached, main].map(\.worktreeBranch) == ["night/plan", "portals-review", nil])
    }

    @Test func aFolderIsListedWhileAThreadOfItIsNotArchived() {
        let agents = [agent("claude", on: local)]
        let runs = coding("runs", "claude", in: "/Users/dev/busy", updated: 30)
        let threads = [runs, coding("put", "claude", in: "/Users/dev/done", updated: 20, archived: true)]
        let layout = SidebarLayout.build(
            hosts: [hosts[1]], agents: agents, threads: threads, waiting: [], running: [runs.key], withFolders: [local]
        )
        // A thread under Running is in its folder too; a folder with nothing but
        // archived threads has no row.
        #expect(layout.top.running.map(\.id.rawValue) == ["runs"])
        #expect(layout.spaces[0].folders.map(\.name) == ["busy"])
        #expect(layout.spaces[0].folders[0].threads.map(\.id.rawValue) == ["runs"])
        #expect(layout.spaces[0].archived.map(\.id.rawValue) == ["put"])
    }

    @Test func theSameFolderOnTwoHostsIsTwoProjects() {
        let agents = [agent("claude", on: local), agent("claude", on: mini)]
        let folder = "/Users/dev/coding_projects/aerirc"
        var onMini = record("m1", host: mini, agent: "claude", updated: 20)
        onMini.ref.workingDirectory = folder
        let layout = SidebarLayout.build(
            hosts: hosts, agents: agents, threads: [onMini, coding("l1", "claude", in: folder, updated: 10)],
            waiting: [], running: [], withFolders: [local, mini]
        )
        #expect(layout.spaces.map { $0.folders.map(\.id) } == [
            [SidebarProject.ID(host: mini, path: folder)], [SidebarProject.ID(host: local, path: folder)],
        ])
        #expect(layout.spaces.map { $0.folders[0].threads.map(\.id.rawValue) } == [["m1"], ["l1"]])
    }

    @Test func aFolderTheUserAddedIsAProjectBeforeAnyThreadRunsInIt() {
        let agents = [agent("claude", on: local)]
        let listed = [
            Folder(path: "/Users/dev/notes", lastUsed: t0.addingTimeInterval(30), isAdded: true),
            // Worked in by an agent at the desk, never added: no project of its own.
            Folder(path: "/Users/dev/scratch", lastUsed: t0.addingTimeInterval(40)),
            Folder(path: "/Users/dev/aerirc", lastUsed: t0.addingTimeInterval(5), isAdded: true),
            Folder(path: "/Users/dev/old", isAdded: true),
        ]
        let threads = [coding("a1", "claude", in: "/Users/dev/aerirc", updated: 20), coding("s1", "claude", in: "/Users/dev/site", updated: 10)]
        let layout = SidebarLayout.build(
            hosts: hosts, agents: agents, threads: threads, waiting: [], running: [],
            withFolders: [local], folders: [local: listed, mini: [Folder(path: "/Users/dev/elsewhere", isAdded: true)]]
        )
        // When each was first seen (or last worked in, for an added one) puts it; one with
        // no date comes last. A host whose agents do not work in folders has no projects,
        // whatever it lists.
        let projects = layout.spaces[1].folders
        #expect(projects.map(\.name) == ["notes", "aerirc", "site", "old"])
        #expect(projects.map(\.isAdded) == [true, true, false, true])
        #expect(projects.map(\.hasThreads) == [false, true, true, false])
        #expect(projects.map(\.isOnlyAdded) == [true, false, false, true])
        #expect(projects.map { $0.threads.map(\.id.rawValue) } == [[], ["a1"], ["s1"], []])
        #expect(layout.spaces[0].folders.isEmpty)

        // General is a project by its threads only, as before.
        var withGeneral = hosts
        withGeneral[1].generalFolder = "/Users/dev/notes"
        let general = SidebarLayout.build(
            hosts: withGeneral, agents: agents, threads: [], waiting: [], running: [], withFolders: [local], folders: [local: Array(listed.prefix(1))]
        )
        #expect(general.spaces[1].folders.isEmpty)
    }

    @Test func theRecentProjectsKeepTheOpenOnes() {
        let projects = (0..<8).map { SidebarProject(id: SidebarProject.ID(host: local, path: "/p\($0)"), name: "p\($0)", threads: []) }
        #expect(SidebarSections.recent(projects, count: 6, keeping: []).map(\.name) == ["p0", "p1", "p2", "p3", "p4", "p5"])
        #expect(SidebarSections.recent(projects, count: 6, keeping: [projects[7].id]).map(\.name) == ["p0", "p1", "p2", "p3", "p4", "p5", "p7"])
    }

    @Test func aTitleIsTidiedToOneLine() {
        #expect(ThreadRecord.tidyTitle("  Retry\n failed   pushes ") == "Retry failed pushes")
        #expect(ThreadRecord.tidyTitle(" \n ") == nil)
        #expect(ThreadRecord.tidyTitle(String(repeating: "a", count: 300))?.count == 200)
    }

    @Test func pinsAndArchivesAreKeptAndOldListsReadAsNeither() throws {
        let pinned = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: "p"), agent: Agent.ID(host: local, name: "claude")), pinned: true)
        let data = try JSONEncoder().encode(pinned)
        #expect(try JSONDecoder().decode(ThreadRecord.self, from: data).isPinned)
        // A list saved before pins existed.
        var plain = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        plain["pinned"] = nil
        let old = try JSONDecoder().decode(ThreadRecord.self, from: JSONSerialization.data(withJSONObject: plain))
        #expect(!old.isPinned && !old.isArchived)
    }

    @Test func theRecentThreadsKeepTheOneOnScreen() {
        let threads = (0..<8).map { record("t\($0)", updated: TimeInterval(-$0)) }
        #expect(SidebarSections.recent(threads, count: 5, keeping: nil).map(\.id.rawValue) == ["t0", "t1", "t2", "t3", "t4"])
        #expect(SidebarSections.recent(threads, count: 5, keeping: threads[6].key).map(\.id.rawValue) == ["t0", "t1", "t2", "t3", "t4", "t6"])
        // The same id on another host is another thread.
        let elsewhere = ThreadKey(host: local, id: threads[6].id)
        #expect(SidebarSections.recent(threads, count: 5, keeping: elsewhere).count == 5)
        // Pinned threads always show, and the count is of the others.
        var pinned = (0..<2).map { record("p\($0)", updated: TimeInterval(-$0)) }
        for index in pinned.indices { pinned[index].pinned = true }
        #expect(SidebarSections.recent(pinned + threads, count: 3, keeping: nil).map(\.id.rawValue) == ["p0", "p1", "t0", "t1", "t2"])
    }

    @Test func searchLooksThroughEveryHost() {
        let threads = [
            record("a", host: mini, title: "Fix the build", updated: 10),
            record("b", host: local, agent: "claude", title: "Refactor", preview: "fix the tests", updated: 20),
            record("c", host: local, agent: "codex", title: "Unrelated", updated: 30),
        ]
        #expect(SidebarSections.search("fix", in: threads).map(\.key) == [threads[1].key, threads[0].key])
        #expect(SidebarSections.search("  ", in: threads).isEmpty)
        #expect(SidebarSections.search("nothing", in: threads).isEmpty)
    }

    @Test func theSearchMatchesAsLocalizedStandardContainsDoes() {
        let texts = [
            "Fix the tests", "café au lait", "CAFE", "Straße", "STRASSE", "İstanbul", "istanbul", "ıi",
            "naïve résumé", "日本語のテキスト", "emoji 👩‍💻 here", "ﬁle", "file", "", "Ⅻ", "Ａｂｃ", "abc",
            "Ünïcödé", "e\u{301}", "é", "ç", "C", "\u{0}null",
        ]
        let needles = ["fix", "CAFÉ", "cafe", "ss", "ß", "i", "I", "ı", "İ", "resume", "テキスト", "👩‍💻", "fi", "abc", "é", "e", "c", "x"]
        for needle in needles {
            let holds = StandardContains(needle)
            for text in texts {
                #expect(holds.isIn(text) == text.localizedStandardContains(needle), "\(needle) in \(text)")
            }
        }
        #expect(!StandardContains("").isIn("anything"))
    }
}

// MARK: - Notifications

@Suite struct PushRouteTests {
    @Test func aPayloadNamesItsThreadAndMaybeItsHost() {
        let plugin: [AnyHashable: Any] = ["aps": ["alert": "x"], "aeriportal": ["thread": "20261005_000000_abc123", "kind": "approval", "agent": "karina"]]
        #expect(PushRoute(userInfo: plugin) == PushRoute(thread: ThreadRef.ID(rawValue: "20261005_000000_abc123")))

        let bridge: [AnyHashable: Any] = ["aeriportal": ["thread": "t1", "host": "mbp", "agent": "claude"]]
        #expect(PushRoute(userInfo: bridge) == PushRoute(host: HostID(rawValue: "mbp"), thread: ThreadRef.ID(rawValue: "t1")))

        let emptyHost: [AnyHashable: Any] = ["aeriportal": ["thread": "t1", "host": ""]]
        #expect(PushRoute(userInfo: emptyHost)?.host == nil)
    }

    @Test func aPayloadWithoutAThreadIsNotRouted() {
        #expect(PushRoute(userInfo: [:]) == nil)
        #expect(PushRoute(userInfo: ["aeriportal": ["thread": ""]]) == nil)
        #expect(PushRoute(userInfo: ["aeriportal": ["thread": 7]]) == nil)
        #expect(PushRoute(userInfo: ["aeriportal": "t1"]) == nil)
    }

    @Test func withAHostOnlyThatHostsThreadWillDo() {
        let threads = [record("t1", host: mini, updated: 30), record("t1", host: local, agent: "claude", updated: 10)]
        #expect(PushRoute(host: local, thread: ThreadRef.ID(rawValue: "t1")).resolve(in: threads)?.key == threads[1].key)
        #expect(PushRoute(host: HostID(rawValue: "other"), thread: ThreadRef.ID(rawValue: "t1")).resolve(in: threads) == nil)
    }

    @Test func withoutAHostEveryHostIsSearchedMostRecentFirst() {
        let threads = [record("t1", host: local, agent: "claude", updated: 10), record("t1", host: mini, updated: 30), record("t2", host: mini)]
        #expect(PushRoute(thread: ThreadRef.ID(rawValue: "t1")).resolve(in: threads)?.key == threads[1].key)
        #expect(PushRoute(thread: ThreadRef.ID(rawValue: "t2")).resolve(in: threads)?.key == threads[2].key)
        #expect(PushRoute(thread: ThreadRef.ID(rawValue: "gone")).resolve(in: threads) == nil)
    }

    @Test func hostsAreComparedOnlyWhenBothHaveOne() {
        let t1 = ThreadRef.ID(rawValue: "t1")
        #expect(PushRoute(host: mini, thread: t1).matches(PushRoute(host: mini, thread: t1)))
        #expect(!PushRoute(host: mini, thread: t1).matches(PushRoute(host: local, thread: t1)))
        #expect(PushRoute(thread: t1).matches(PushRoute(host: local, thread: t1)))
        #expect(PushRoute(host: mini, thread: t1).matches(PushRoute(thread: t1)))
        #expect(!PushRoute(host: mini, thread: t1).matches(PushRoute(host: mini, thread: ThreadRef.ID(rawValue: "t2"))))
    }
}

@Suite struct NotificationAvatarNameTests {
    private let avatars = NotificationAvatars(directory: URL(fileURLWithPath: "/group/NotificationAvatars"))

    @Test func anAgentIsFiledUnderItsHost() {
        #expect(avatars.url(forAgent: "karina", on: mini).lastPathComponent == "mini--karina.png")
        #expect(avatars.url(forAgent: "karina").lastPathComponent == "karina.png")
        // A host's dashes are encoded, so the first `--` always ends the host.
        #expect(NotificationAvatars.fileName(forAgent: "b", on: HostID(rawValue: "a-")) == "a%2D--b.png")
        #expect(NotificationAvatars.fileName(forAgent: "-b", on: HostID(rawValue: "a")) == "a---b.png")
        // Neither part can name a path.
        #expect(avatars.url(forAgent: "../x", on: HostID(rawValue: "../y")).path == "/group/NotificationAvatars/%2E%2E%2Fy--%2E%2E%2Fx.png")
        #expect(NotificationAvatars.fileName(forAgent: "", on: HostID(rawValue: "")) == "host--agent.png")
    }

    @Test func theBareNameIsKeptOnlyWhenOneHostHasThatAgent() {
        let files = NotificationAvatars.files(for: [
            Agent.ID(host: mini, name: "default"), Agent.ID(host: mini, name: "hanni"),
            Agent.ID(host: local, name: "default"), Agent.ID(host: local, name: "claude"),
        ])
        #expect(Set(files.keys) == ["mini--default.png", "mini--hanni.png", "local--default.png", "local--claude.png", "hanni.png", "claude.png"])
        #expect(files["hanni.png"] == Agent.ID(host: mini, name: "hanni"))
        #expect(files["local--default.png"] == Agent.ID(host: local, name: "default"))
    }

    @Test func oneHostKeepsEveryBareName() {
        let files = NotificationAvatars.files(for: [Agent.ID(host: mini, name: "default"), Agent.ID(host: mini, name: "hanni")])
        #expect(Set(files.keys) == ["mini--default.png", "mini--hanni.png", "default.png", "hanni.png"])
    }
}
