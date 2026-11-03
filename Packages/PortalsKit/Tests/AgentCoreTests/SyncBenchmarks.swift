import Foundation
import Testing
@testable import AgentCore

// What thread sync costs a device: the time
// of each step of `HostSync`, and what it reads, writes and asks of the host, with 100,
// 1000 and 5000 threads. Seconds of work at 5000, so the suite runs only when asked:
//
//     PORTALS_BENCH=1 swift test --no-parallel --filter SyncBenchmarks
//     PORTALS_BENCH=1 swift test -c release -Xswiftc -enable-testing --no-parallel --filter SyncBenchmarks
//
// The second builds the package as the app is built, which the merge and the sidebar's
// layout are several times faster for; the table says which build it was. It prints a
// table for each size; with PORTALS_BENCH_JSON=<path> each row is also appended to that
// file, a JSON object a line. The row that decodes an answer is in HermesBackendTests
// (SyncBenchmarksWire.swift), which the same command runs.
//
// The times are this Mac's, for setting sizes and fixes beside each other, not what a
// phone takes. The counts are the same anywhere.

/// Each step of a host's sync on a device that holds `count` of its threads, timed and
/// counted. Nothing is asserted of the numbers: they are there to be changed.
@MainActor
@Suite(.serialized, .enabled(if: SyncBench.isAsked, "Only with PORTALS_BENCH=1")) struct SyncBenchmarks {
    private let mac = HostID(rawValue: "mac")

    @Test(arguments: SyncBench.sizes) func whatSyncCostsADevice(holding count: Int) async throws {
        let listed = SyncBench.threads(count)
        let fake = FakeListHost()
        await fake.start(listed)
        let tally = SyncTally()
        let host = CountedHost(fake, tally)
        let table = SyncTable(threads: count, tally)
        let few = count > 1000 ? 3 : 5
        var step = SyncStep()

        // A device with nothing takes the whole list. The fake host hands over typed
        // values, so nothing is decoded here: that is the row in HermesBackendTests.
        var phone = AppLikeDevice(host, mac, tally)
        await table.row(
            "First sync: the whole list taken", rounds: few, files: phone.store,
            ready: { phone = AppLikeDevice(host, mac, tally) },
            meant: { step.merged && phone.threads.count == count }
        ) { step = await phone.sync.step() }

        // A poll that finds the list where the device has it.
        var list = await fake.list
        await table.row(
            "At rest: a step with the list where it is", rounds: 50, files: phone.store,
            meant: { !step.merged && step.error == nil }
        ) { step = await phone.sync.step(listNow: list) }

        // A turn ended in one thread, somewhere else: the next poll's step merges it.
        var turn = 0
        await table.row(
            "One thread changed on the host", rounds: 10, files: phone.store,
            ready: {
                await fake.endTurn(listed[turn % count].id)
                turn += 1
                list = await fake.list
            },
            meant: { step.merged && step.error == nil }
        ) { step = await phone.sync.step(listNow: list) }

        // A step that does not know where the host's list is, as the app's is after a
        // `sessions.activity` that failed: it fetches, and nothing is new.
        await table.row(
            "A fetch that brings nothing new", rounds: 10, files: phone.store,
            meant: { step.merged && step.error == nil }
        ) { step = await phone.sync.step(listNow: nil) }

        // A pin as the app makes one: kept to send, shown and saved, then the step that
        // sends it and merges the list it moved, from the host's answer.
        let unmarked = listed.filter { !$0.pinned && !$0.archived }.map(\.id)
        var pin = 0
        await table.row(
            "A pin made here, and the step that sends it", rounds: 10, files: phone.store,
            ready: { pin += 1 },
            meant: { step.merged && step.error == nil && phone.sync.pending.isEmpty }
        ) { step = await phone.pin(unmarked[pin % unmarked.count]) }

        // A thread whose turn ended is looked at: seen here at once, and the host told.
        var looked = unmarked[0]
        await table.row(
            "A thread seen", rounds: 10, files: phone.store,
            ready: {
                turn += 1
                looked = unmarked[turn % unmarked.count]
                await fake.endTurn(looked)
                let moved = await fake.list
                await phone.sync.step(listNow: moved)
            },
            meant: { phone.threads.first { $0.id == looked }?.isUnseen == false }
        ) { await phone.sync.seen(looked) }

        // The merge by itself, with no file: the whole list into nothing, and one thread
        // into them all.
        let full = try await fake.threadListChanges(since: nil)
        var merge: ThreadMerge?
        await table.row("The merge alone: the whole list", rounds: few, meant: { merge?.threads.count == count }) {
            merge = ThreadSync.merge(full, into: [], heldWhenAsking: [], pending: [], list: nil, host: mac)
        }
        let held = phone.threads, asking = Set(held.map(\.id))
        var changed = full.threads[0]
        changed.revision = full.list.revision + 1
        let one = ThreadListChanges(list: ThreadListRevision(id: full.list.id, revision: changed.revision), threads: [changed])
        await table.row("The merge alone: one thread", rounds: 20, meant: { merge?.threads.count == count && merge?.list == one.list }) {
            merge = ThreadSync.merge(one, into: held, heldWhenAsking: asking, pending: [], list: full.list, host: mac)
        }

        // The store by itself: the two files as a step reads and writes them.
        let store = phone.store, state = phone.sync.state
        var loaded: [ThreadRecord] = []
        var saved = false
        await table.row(
            "The store alone: threads.json read", rounds: few, files: store,
            ready: { tally.makeUnread(store) }, meant: { loaded.count == count }
        ) {
            loaded = tally.load(store)
        }
        // Written with one thread changed since the save before, as after a turn; a list
        // saved as the file has it is not written at all, which is the row after.
        var saving = held
        var saves = 0
        await table.row(
            "The store alone: threads.json written", rounds: few, files: store,
            ready: {
                saves += 1
                saving[saves % count].revision = (saving[saves % count].revision ?? 0) + 1
            },
            meant: { saved }
        ) {
            saved = tally.save(saving, store)
        }
        // Handed over as a list of its own, as the app's is each time.
        saved = false
        await table.row("The store alone: threads.json saved as it is", rounds: 20, files: store, meant: { saved }) {
            saved = tally.save(saving.map { $0 }, store)
        }
        // A second Mac's threads in the file as well, half of the list each. Each Mac's
        // model saves the other's threads first, as loaded, and its own after them
        // (`HostModel.saveThreads`), so with nothing changed the list comes mixed the
        // other way from the save before.
        let mini = HostID(rawValue: "mini")
        let ofMini = saving[..<(count / 2)].map { record -> ThreadRecord in
            var other = record
            other.ref.agent.host = mini
            return other
        }
        let ofMac = Array(saving[(count / 2)...])
        let saveAs = { (host: HostID, own: [ThreadRecord]) in
            tally.save(tally.load(store).filter { $0.ref.agent.host != host } + own, store)
        }
        saved = tally.save(ofMini + ofMac, store)
        await table.row(
            "The store alone: threads.json saved as it is, after a second Mac's save", rounds: 20, files: store,
            ready: { _ = saveAs(mini, ofMini) }, meant: { saved }
        ) {
            saved = saveAs(mac, ofMac)
        }
        await table.row("The store alone: sync.json read and written", rounds: 20, files: store, meant: { saved }) {
            saved = store.saveSync(state, for: mac)
        }

        // The sidebar's list, which the app builds again after any change on any host.
        let config = HostConfig(id: mac, name: "Mac", url: URL(string: "http://127.0.0.1:9120")!, generalFolder: "/Users/dev/Portals")
        let agents = [Agent(id: Agent.ID(host: mac, name: "claude"))]
        var layout = SidebarLayout()
        await table.row("The sidebar's layout", rounds: 20, meant: { !layout.spaces.isEmpty }) {
            layout = SidebarLayout.build(hosts: [config], agents: agents, threads: held, waiting: [], running: [], withFolders: [mac])
        }

        table.report(store)
    }
}

/// The one check of these that runs every time: what a device at rest costs.
@MainActor
@Suite struct SyncAtRestTests {
    /// A read of sync.json by the package would not show here: no test file can see
    /// one. `ThreadStore` reads it when a `HostSync` is made, and before each write of it.
    @Test func aStepWithTheListWhereItIsAsksTheHostNothingAndWritesNoFile() async {
        let mac = HostID(rawValue: "mac")
        let listed = SyncBench.threads(50)
        let fake = FakeListHost()
        await fake.start(listed)
        let tally = SyncTally()
        let phone = AppLikeDevice(CountedHost(fake, tally), mac, tally)
        await phone.sync.step()
        #expect(phone.threads.count == 50)

        var list = await fake.list
        let asked = await fake.calls.count
        tally.begin(watching: phone.store)
        let atRest = await phone.sync.step(listNow: list)
        #expect(!atRest.merged)
        #expect(tally.end() == SyncTally.Counts())
        #expect(await fake.calls.count == asked)

        // And the count is not blind: a step that has something to fetch shows as one
        // call, and each of the two files written.
        await fake.endTurn(listed[0].id)
        list = await fake.list
        tally.begin(watching: phone.store)
        let fetching = await phone.sync.step(listNow: list)
        let fetched = tally.end()
        #expect(fetching.merged)
        #expect(fetched.calls == 1)
        // Saved with the other hosts' threads, which are those of the save before: the
        // file is not read for them.
        #expect(fetched.threadsReads == 0)
        #expect(fetched.threadsSaves == 1)
        #expect(fetched.threadsWrites == 1)
        #expect(fetched.syncWrites == 1)
        #expect(fetched.threadsBytes > 0 && fetched.syncBytes > 0)
    }

    /// A step that does not know where the host's list is, as the app's is after a
    /// `sessions.activity` that failed, asks for what changed. When nothing did, the
    /// threads and the list are as the two files have them, and neither is written.
    @Test func aFetchThatBringsNothingNewWritesNoFile() async {
        let mac = HostID(rawValue: "mac")
        let fake = FakeListHost()
        await fake.start(SyncBench.threads(50))
        let tally = SyncTally()
        let phone = AppLikeDevice(CountedHost(fake, tally), mac, tally)
        await phone.sync.step()
        let held = phone.threads, state = phone.sync.state, holds = phone.holds

        tally.begin(watching: phone.store)
        let step = await phone.sync.step(listNow: nil)
        let counts = tally.end()
        #expect(step.merged && step.error == nil)
        #expect(counts.calls == 1)
        // The device is not handed the threads it holds already: the app would go
        // through them all and ask for them to be saved, and the store would have to
        // find for itself that the file holds them.
        #expect(phone.holds == holds)
        #expect(counts.threadsReads == 0)
        #expect(counts.threadsSaves == 0)
        #expect(counts.threadsWrites == 0)
        #expect(counts.syncWrites == 0)
        #expect(phone.threads == held)
        #expect(phone.sync.state == state)
        #expect(phone.store.loadSync(for: mac) == state)
    }

    /// A change the host does not answer is tried again at each step, and such a step
    /// fetches the list, which the change may have moved on the host all the same. For
    /// as long as that lasts a step is those two calls, and no file while nothing is new.
    @Test func aChangeTheHostDoesNotAnswerCostsAStepTwoCallsAndNoFile() async {
        let mac = HostID(rawValue: "mac")
        let listed = SyncBench.threads(50)
        let fake = FakeListHost()
        await fake.start(listed)
        let tally = SyncTally()
        let phone = AppLikeDevice(CountedHost(fake, tally), mac, tally)
        await phone.sync.step()
        let pinned = listed[0].id
        let pending = [PendingThreadChange(thread: pinned, pinned: true)]
        await fake.neverAnswerMarks(of: [pinned])
        let first = await phone.pin(pinned)
        #expect(first.error != nil)
        #expect(phone.sync.pending == pending)

        let list = await fake.list
        for _ in 0..<2 {
            tally.begin(watching: phone.store)
            let step = await phone.sync.step(listNow: list)
            let counts = tally.end()
            #expect(step.error != nil && step.merged)
            #expect(counts.calls == 2)
            #expect(counts.threadsReads == 0)
            #expect(counts.threadsSaves == 0)
            #expect(counts.threadsWrites == 0)
            #expect(counts.syncWrites == 0)
        }
        // The pin shows here meanwhile, is still to send, and goes once the host answers.
        #expect(phone.threads.first { $0.id == pinned }?.isPinned == true)
        #expect(phone.sync.pending == pending)
        #expect(phone.store.loadSync(for: mac)?.pending == pending)
        await fake.neverAnswerMarks(of: [])
        let step = await phone.sync.step(listNow: list)
        #expect(step.error == nil)
        #expect(phone.sync.pending.isEmpty)
        #expect(await fake.thread(pinned)?.pinned == true)
    }
}

// MARK: - A device that holds its threads as the app does

/// A device that holds a host's threads as the app does: in memory, and saved whole, the
/// list loaded first for the other hosts' threads.
///
/// It is a model of `HostModel`, not `HostModel`: `hold`, `saveThreads` and `setPinned`
/// are in the app target (Portals/App/HostModel.swift), where the package's tests
/// cannot reach, so what they do to the threads and the file is written again here and
/// has to be kept in step by hand. `Device` as it is reads threads.json each time the
/// sync looks at the threads, which the app never does.
@MainActor
private final class AppLikeDevice {
    private let device: Device
    private let host: HostID
    private let tally: SyncTally
    private(set) var threads: [ThreadRecord] = []
    /// Titles the last merge changed, which the app tells its open thread and its
    /// notifications.
    private(set) var renamed = 0
    /// The times the sync handed the device its threads to hold.
    private(set) var holds = 0

    var store: ThreadStore { device.store }
    var sync: HostSync { device.sync }

    init(_ remote: any ThreadSyncing, _ host: HostID, _ tally: SyncTally) {
        var store = Device.scratchStore()
        store.onAccess = { access in
            MainActor.assumeIsolated { tally.accessed(access) }
        }
        device = Device(remote, host, store: store)
        self.host = host
        self.tally = tally
        device.sync.heldThreads = { [unowned self] in
            tally.look()
            return self.threads
        }
        device.sync.holdThreads = { [unowned self] threads, _ in self.hold(threads) }
    }

    /// As `HostModel.hold`: the threads taken and saved, then the titles gone through
    /// for those the host changed.
    private func hold(_ held: [ThreadRecord]) -> Bool {
        holds += 1
        let before = threads
        threads = held
        guard save() else {
            threads = before
            return false
        }
        let titles = Dictionary(before.map { ($0.id, $0.ref.title) }, uniquingKeysWith: { first, _ in first })
        renamed = threads.filter { record in titles[record.id].map { $0 != record.ref.title } ?? false }.count
        return true
    }

    /// As `HostModel.saveThreads`: the file holds every host's threads, so the list is
    /// loaded for the others' and then written whole.
    @discardableResult
    private func save() -> Bool {
        tally.save(tally.load(store).filter { $0.ref.agent.host != host } + threads, store)
    }

    /// As `HostModel.setPinned` on a host that keeps the list: the change kept to send,
    /// shown and saved, then a step that sends it and merges the list it moved, from the
    /// host's answer. (The app asks for that step and does not wait for it.)
    func pin(_ id: ThreadRef.ID) async -> SyncStep {
        guard let index = threads.firstIndex(where: { $0.id == id }),
              (try? sync.record(PendingThreadChange(thread: id, pinned: true))) == true else { return SyncStep() }
        tally.look()
        threads[index].pinned = true
        save()
        return await sync.step(listNow: sync.state?.list)
    }
}

// MARK: - Counting

/// The host as a device reaches it: each call counted, and the wait for its answer
/// timed.
@MainActor
private final class CountedHost: ThreadSyncing {
    private let host: FakeListHost
    private let tally: SyncTally

    init(_ host: FakeListHost, _ tally: SyncTally) {
        self.host = host
        self.tally = tally
    }

    /// What the last connection said, which the app knows without asking: not a call.
    var syncsThreads: Bool? {
        get async {
            tally.look()
            return await host.syncsThreads
        }
    }

    func threadListChanges(since: ThreadListRevision?) async throws -> ThreadListChanges {
        try await tally.asking { try await host.threadListChanges(since: since) }
    }

    func markThread(_ thread: ThreadRef.ID, _ marks: ThreadMarks) async throws -> ListedThread? {
        try await tally.asking { try await host.markThread(thread, marks) }
    }

    func renameThread(_ thread: ThreadRef, to title: String) async throws {
        try await tally.asking { try await host.renameThread(thread, to: title) }
    }

    func removeThread(_ thread: ThreadRef.ID) async throws {
        try await tally.asking { try await host.removeThread(thread) }
    }
}

/// What one step asked of the host and did to the device's two files.
///
/// Reads and writes of threads.json are the store's own count of them
/// (`ThreadStore.onAccess`), so a load the store answers from the list it kept is not a
/// read, and a save of the list the file holds already not a write. sync.json is
/// written by `HostSync` itself, and a write is counted by its file having been replaced
/// (`FileWatch`), looked for each time the sync hands over to the device or the host,
/// and when the step is done. threads.json is watched the same way, and its two counts
/// of writes must agree, which each counted step checks.
/// Reads of sync.json are not counted: `ThreadStore.saveSync` reads the file before each
/// write of it, which is in the step's time.
@MainActor
private final class SyncTally {
    struct Counts: Equatable {
        /// Calls that went to the host.
        var calls = 0
        /// The times the store read threads.json from the disk, and wrote it.
        var threadsReads = 0
        var threadsSaves = 0
        /// The times each file was found replaced, and the bytes of the files found.
        var threadsWrites = 0
        var threadsBytes = 0
        var syncWrites = 0
        var syncBytes = 0
    }

    private var counts = Counts()
    /// The store's two files, while a step is counted. A timed step watches nothing.
    private var files: (threads: FileWatch, sync: FileWatch)?
    /// How long the device waited for the host's answers. That is the fake host's own
    /// work, not the app's, and is taken off a step's time.
    var waited: Duration = .zero

    func begin(watching store: ThreadStore?) {
        counts = Counts()
        files = store.map {
            (FileWatch($0.directory.appendingPathComponent("threads.json")), FileWatch($0.directory.appendingPathComponent("sync.json")))
        }
    }

    func end() -> Counts {
        look()
        if let files {
            counts.threadsWrites = files.threads.writes
            counts.threadsBytes = files.threads.bytes
            counts.syncWrites = files.sync.writes
            counts.syncBytes = files.sync.bytes
        }
        files = nil
        return counts
    }

    func look() {
        files?.threads.look()
        files?.sync.look()
    }

    /// A call to the host: counted, and the wait for its answer kept.
    func asking<Answer: Sendable>(_ ask: () async throws -> Answer) async rethrows -> Answer {
        look()
        counts.calls += 1
        let start = ContinuousClock.now
        defer { waited += ContinuousClock.now - start }
        return try await ask()
    }

    /// What the store read or wrote on the disk (`ThreadStore.onAccess`): a load of the
    /// thread list that the store answers from the list it kept reads no file.
    func accessed(_ access: ThreadStore.FileAccess) {
        guard access.file == "threads.json" else { return }
        if access.isWrite {
            counts.threadsSaves += 1
        } else {
            counts.threadsReads += 1
        }
    }

    func load(_ store: ThreadStore) -> [ThreadRecord] {
        store.loadThreads()
    }

    /// Makes threads.json another file than the one the store kept, with the same
    /// content, as when the app starts: the next load reads it.
    func makeUnread(_ store: ThreadStore) {
        let file = store.directory.appendingPathComponent("threads.json")
        if let data = try? Data(contentsOf: file) { try? data.write(to: file, options: .atomic) }
        look()
    }

    func save(_ threads: [ThreadRecord], _ store: ThreadStore) -> Bool {
        let saved = store.saveThreads(threads)
        look()
        return saved
    }
}

/// One file, looked at for having been written. `ThreadStore` writes a file whole and
/// atomically, which puts a new file in the old one's place, so the file found there is
/// another one each time. Two writes with no look in between show as one.
private struct FileWatch {
    private struct Found: Equatable {
        var file: UInt64
        var seconds: Int
        var nanoseconds: Int
        var bytes: Int
    }

    private let path: String
    private var last: Found?
    private(set) var writes = 0
    private(set) var bytes = 0

    init(_ url: URL) {
        path = url.path
        last = Self.find(path)
    }

    mutating func look() {
        let now = Self.find(path)
        guard now != last else { return }
        last = now
        guard let now else { return }
        writes += 1
        bytes += now.bytes
    }

    private static func find(_ path: String) -> Found? {
        var info = stat()
        guard lstat(path, &info) == 0 else { return nil }
        return Found(
            file: UInt64(info.st_ino), seconds: info.st_mtimespec.tv_sec, nanoseconds: info.st_mtimespec.tv_nsec, bytes: Int(info.st_size)
        )
    }
}

// MARK: - The table

/// The rows of one size, measured one after another.
@MainActor
private final class SyncTable {
    struct Row: Encodable {
        var at = Date.now
        var build = SyncBench.build
        var load = SyncBench.load
        var row: String
        var threads: Int
        var rounds: Int
        /// The middle one of the rounds' times, the shortest and the longest.
        var ms: Double
        var msMin: Double
        var msMax: Double
        var calls: Int
        var threadsReads: Int
        var threadsWrites: Int
        var threadsBytes: Int
        var syncWrites: Int
        var syncBytes: Int
    }

    private let threads: Int
    private let tally: SyncTally
    private var rows: [Row] = []

    init(threads: Int, _ tally: SyncTally) {
        self.threads = threads
        self.tally = tally
    }

    /// Measures one step and keeps its row. Once with everything counted and the files
    /// watched, which also warms the step up; then `rounds` times by the clock with
    /// nothing watched. `ready` runs before each, outside the time; `meant` says
    /// afterwards whether the step did what the row is about.
    func row(
        _ name: String, rounds: Int, files: @autoclosure () -> ThreadStore? = nil,
        ready: () async -> Void = {}, meant: () -> Bool = { true }, _ step: () async -> Void
    ) async {
        await ready()
        tally.begin(watching: files())
        await step()
        let counts = tally.end()
        #expect(meant(), "\(name), with \(threads) threads")
        #expect(counts.threadsWrites == counts.threadsSaves, "\(name): the store wrote threads.json \(counts.threadsSaves) times")

        var times: [Double] = []
        for _ in 0..<rounds {
            await ready()
            tally.waited = .zero
            let start = ContinuousClock.now
            await step()
            let whole = ContinuousClock.now - start
            times.append(SyncBench.milliseconds(whole - tally.waited))
            #expect(meant(), "\(name), with \(threads) threads")
        }
        times.sort()
        rows.append(Row(
            row: name, threads: threads, rounds: rounds, ms: times[times.count / 2], msMin: times[0], msMax: times[times.count - 1],
            calls: counts.calls, threadsReads: counts.threadsReads, threadsWrites: counts.threadsWrites, threadsBytes: counts.threadsBytes,
            syncWrites: counts.syncWrites, syncBytes: counts.syncBytes
        ))
    }

    /// Prints the table, ready to paste into your notes, and appends the rows to the
    /// file PORTALS_BENCH_JSON names.
    func report(_ store: ThreadStore) {
        let size = { (file: String) in
            ((try? FileManager.default.attributesOfItem(atPath: store.directory.appendingPathComponent(file).path))?[.size] as? Int) ?? 0
        }
        var lines = [
            "",
            "App sync with \(threads) threads: \(SyncBench.build) build, \(Date.now.formatted(.iso8601)), load average \(SyncBench.load).",
            "threads.json is \(size("threads.json")) bytes, sync.json \(size("sync.json")). ms is the middle one of a step's rounds, "
                + "without the wait for the fake host's answers.",
            "",
            "| Step | ms | Calls to the host | threads.json read | written | bytes written | sync.json written | bytes written |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for row in rows {
            let cells = [row.calls, row.threadsReads, row.threadsWrites, row.threadsBytes, row.syncWrites, row.syncBytes].map(String.init)
            lines.append("| \(row.row) | \(String(format: "%.3f", row.ms)) | \(cells.joined(separator: " | ")) |")
        }
        print(lines.joined(separator: "\n") + "\n")
        SyncBench.append(rows)
    }
}

/// What the benchmarks share: the switch, the sizes, the threads and the numbers.
private enum SyncBench {
    static let isAsked = ProcessInfo.processInfo.environment["PORTALS_BENCH"] == "1"
    static let sizes = [100, 1000, 5000]

    #if DEBUG
    static let build = "debug"
    #else
    static let build = "release"
    #endif

    /// The Mac's load average over the last minute: several agents may share it.
    static var load: Double {
        var averages = [0.0, 0.0, 0.0]
        getloadavg(&averages, 3)
        return (averages[0] * 100).rounded() / 100
    }

    static func milliseconds(_ time: Duration) -> Double {
        let ms = Double(time.components.seconds) * 1000 + Double(time.components.attoseconds) / 1e15
        return (ms * 10_000).rounded() / 10_000
    }

    /// Appends each row as a line to the file PORTALS_BENCH_JSON names, in one write, so
    /// the two suites' rows never cut into each other. Lines add up over runs: a path of
    /// its own keeps a run apart.
    static func append(_ rows: [some Encodable]) {
        guard let path = ProcessInfo.processInfo.environment["PORTALS_BENCH_JSON"], !path.isEmpty else { return }
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let lines = rows.compactMap { try? encoder.encode($0) + Data("\n".utf8) }.reduce(Data(), +)
        let file = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        let written = file < 0 ? -1 : lines.withUnsafeBytes { write(file, $0.baseAddress, $0.count) }
        if file >= 0 { close(file) }
        if written != lines.count { Issue.record("PORTALS_BENCH_JSON: the rows could not be written to \(path)") }
    }

    /// `count` threads as a host lists them, shaped like real ones, since their size
    /// decides several numbers, and the same every run: titles of 40 to 120 characters
    /// and previews of 20 to 140, one in five of them not ASCII, twenty folders, one
    /// thread in twenty pinned and one archived. The bridge's harness makes its lists
    /// the same way (bridge/scripts/bench/registry.ts). The times and revisions are the
    /// host's to give.
    static func threads(_ count: Int) -> [ListedThread] {
        (0..<count).map { index in
            let plain = index % 5 != 4
            return ListedThread(
                id: ThreadRef.ID(rawValue: String(format: "%08lx-4c1d-4e7a-9b3f-%012lx", index &* 2_654_435_761 & 0xffff_ffff, index)),
                agent: "claude",
                title: text(40 + index * 37 % 81, from: index, plain: plain),
                folder: String(format: "/Users/dev/coding_projects/project-%02ld", index % 20 + 1),
                updated: .distantPast,
                revision: 0,
                preview: text(20 + index * 53 % 121, from: index + 7, plain: plain),
                pinned: index % 20 == 3,
                archived: index % 20 == 11
            )
        }
    }

    private static let words = """
        sync fleet thread bridge poll merge counters revision device sidebar archive rename pinned window build \
        review plan budget list write change update remove agent session folder project notes draft report
        """.split(separator: " ").map(String.init)
    private static let notASCII = ["café", "naïve", "über", "résumé", "日本語", "修正", "测试", "🚀", "Zürich", "señal"]

    /// `length` characters of words, from the `index`th on; when not `plain`, one word
    /// in three is not ASCII.
    private static func text(_ length: Int, from index: Int, plain: Bool) -> String {
        var made = ""
        var next = index
        while made.count < length {
            let word = plain || next % 3 != 0 ? words[next % words.count] : notASCII[next % notASCII.count]
            made += (made.isEmpty ? "" : " ") + word
            next += 1
        }
        return String(made.prefix(length)).trimmingCharacters(in: .whitespaces)
    }
}
