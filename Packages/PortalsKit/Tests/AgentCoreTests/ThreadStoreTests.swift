import Foundation
import Testing
@testable import AgentCore

@Suite struct ThreadStoreTests {
    /// A store in a fresh temporary folder, removed when the test ends.
    private final class Scratch {
        let store: ThreadStore

        init() {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-tests-\(UUID().uuidString)")
            store = ThreadStore(directory: directory)
        }

        deinit {
            try? FileManager.default.removeItem(at: store.directory)
        }
    }

    private let host = HostID(rawValue: "mini")
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func record(_ id: String, agent: String = "hanni", title: String? = nil, updated: TimeInterval = 0) -> ThreadRecord {
        ThreadRecord(
            ref: ThreadRef(id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: host, name: agent), title: title, createdAt: t0),
            updatedAt: t0.addingTimeInterval(updated)
        )
    }

    @Test func aNewStoreIsEmpty() {
        let scratch = Scratch()
        #expect(scratch.store.loadThreads().isEmpty)
        #expect(scratch.store.loadAgents().isEmpty)
        #expect(scratch.store.loadLooks().isEmpty)
        #expect(scratch.store.loadTranscript(for: ThreadKey(host: host, id: ThreadRef.ID(rawValue: "none"))) == nil)
    }

    @Test func threadsComeBackMostRecentFirst() {
        let scratch = Scratch()
        scratch.store.saveThreads([record("a", updated: 10), record("b", updated: 30), record("c", updated: 20)])
        #expect(scratch.store.loadThreads().map(\.id.rawValue) == ["b", "c", "a"])
        #expect(scratch.store.loadThreads().first == record("b", updated: 30))
    }

    @Test func theThreadListIsReadFromTheFileOnlyWhenTheFileIsAnotherOne() throws {
        let scratch = Scratch()
        let reads = Count()
        var store = scratch.store
        store.onAccess = { access in
            if access.file == "threads.json", !access.isWrite { reads.add() }
        }
        let ids = { (threads: [ThreadRecord]) in threads.map(\.id.rawValue) }

        // What was saved is what the file holds: it is not read to be loaded again.
        store.saveThreads([record("a", updated: 10), record("b", updated: 30)])
        #expect(ids(store.loadThreads()) == ["b", "a"])
        #expect(ids(store.loadThreads()) == ["b", "a"])
        #expect(reads.count == 0)

        // Nor by a copy of the store, as each host's model has one of the app's store,
        // and loads the list before each save for the other hosts' threads.
        let copy = store
        copy.saveThreads(copy.loadThreads() + [record("c", updated: 20)])
        #expect(ids(store.loadThreads()) == ["b", "c", "a"])
        #expect(reads.count == 0)

        // Written by anything else, the file is another one: read again, once.
        ThreadStore(directory: store.directory).saveThreads([record("d")])
        #expect(ids(store.loadThreads()) == ["d"])
        #expect(ids(store.loadThreads()) == ["d"])
        #expect(reads.count == 1)

        // A file that cannot be read as a list is empty, each time it is asked for, and
        // so is one that is gone.
        let file = store.directory.appendingPathComponent("threads.json")
        try Data("{".utf8).write(to: file)
        #expect(store.loadThreads().isEmpty)
        #expect(store.loadThreads().isEmpty)
        #expect(reads.count == 3)
        try FileManager.default.removeItem(at: file)
        #expect(store.loadThreads().isEmpty)

        // A list that was read is kept as well as one that was saved.
        ThreadStore(directory: store.directory).saveThreads([record("e", updated: 5), record("f", updated: 6)])
        let before = reads.count
        #expect(ids(store.loadThreads()) == ["f", "e"])
        #expect(ids(store.loadThreads()) == ["f", "e"])
        #expect(reads.count == before + 1)
    }

    @Test func aListSavedComesBackAsTheFileHasItOnceTheFileIsReadAgain() {
        let scratch = Scratch()
        // The file has times to the second; the list kept from a save has them as saved.
        var half = record("a", updated: 10.5)
        half.preview = "said last"
        scratch.store.saveThreads([half])
        #expect(scratch.store.loadThreads() == [half])
        let read = ThreadStore(directory: scratch.store.directory).loadThreads()
        #expect(read.map(\.id) == [half.id])
        #expect(read.first?.preview == "said last")
        #expect(abs((read.first?.updatedAt ?? .distantPast).timeIntervalSince(half.updatedAt)) <= 0.5)
    }

    @Test func aListThatIsWhatTheFileHoldsIsNotWrittenAgain() throws {
        let scratch = Scratch()
        let writes = Count()
        var store = scratch.store
        store.onAccess = { access in
            if access.file == "threads.json", access.isWrite { writes.add() }
        }
        let file = store.directory.appendingPathComponent("threads.json")
        // The threads as another store reads them from the file, in the file's order.
        let inFile = { try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]] }
        let ids = { try inFile()?.compactMap { ($0["ref"] as? [String: Any])?["id"] as? String } }
        var threads = [record("a", updated: 10), record("b", updated: 30), record("c", updated: 20)]
        #expect(store.saveThreads(threads))
        #expect(writes.count == 1)

        // Saved again as it is, as each open thread's entry is when the app leaves the
        // screen, by the store or a copy of it, loaded in between or not: nothing is written.
        #expect(store.saveThreads(threads))
        let copy = store
        #expect(copy.saveThreads(threads))
        #expect(store.loadThreads().map(\.id.rawValue) == ["b", "c", "a"])
        #expect(store.saveThreads(threads))
        #expect(writes.count == 1)
        #expect(try ids() == ["a", "b", "c"])

        // In another order it is another file, and so it is with one thread changed.
        threads = store.loadThreads()
        #expect(store.saveThreads(threads))
        #expect(writes.count == 2)
        #expect(try ids() == ["b", "c", "a"])
        threads[1].unseen = true
        #expect(store.saveThreads(threads))
        #expect(writes.count == 3)
        #expect(try inFile()?[1]["unseen"] as? Bool == true)
        #expect(store.saveThreads(threads))
        #expect(writes.count == 3)

        // A file something else wrote since is written over, also with the list last
        // saved here; and so is one that is gone.
        #expect(ThreadStore(directory: store.directory).saveThreads([]))
        #expect(store.saveThreads(threads))
        #expect(writes.count == 4)
        #expect(try ids() == ["b", "c", "a"])
        try FileManager.default.removeItem(at: file)
        #expect(store.saveThreads(threads))
        #expect(writes.count == 5)
        #expect(try ids() == ["b", "c", "a"])

        // A save that failed is not taken for the file: the same list is written once it can be.
        threads[0].pinned = true
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: store.directory.path)
        #expect(!store.saveThreads(threads))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: store.directory.path)
        #expect(try inFile()?[0]["pinned"] == nil)
        #expect(store.saveThreads(threads))
        #expect(try inFile()?[0]["pinned"] as? Bool == true)

        // A list another store read from the file and saves as it read it is not written.
        var reader = ThreadStore(directory: store.directory)
        reader.onAccess = store.onAccess
        let read = reader.loadThreads()
        let written = writes.count
        #expect(reader.saveThreads(read))
        #expect(writes.count == written)
        #expect(reader.saveThreads(Array(read.reversed())))
        #expect(writes.count == written + 1)
    }

    /// A device with two Macs. Each Mac's model holds its own threads and saves the file
    /// whole, the other Mac's threads first, as loaded, and its own after them
    /// (`HostModel.saveThreads`): the same list comes mixed one way from one model and
    /// the other way from the other.
    @Test func twoHostsSavingInTurnWriteNothingWhileNothingChanged() throws {
        let scratch = Scratch()
        let writes = Count()
        var store = scratch.store
        store.onAccess = { access in
            if access.file == "threads.json", access.isWrite { writes.add() }
        }
        let mac = HostID(rawValue: "mac")
        let onMac = { (id: String, updated: TimeInterval) -> ThreadRecord in
            var thread = self.record(id, updated: updated)
            thread.ref.agent.host = mac
            return thread
        }
        var held = [host: [record("a", updated: 30), record("b", updated: 10)], mac: [onMac("c", 40), onMac("d", 20)]]
        func save(_ host: HostID) -> Bool {
            store.saveThreads(store.loadThreads().filter { $0.ref.agent.host != host } + (held[host] ?? []))
        }
        let file = store.directory.appendingPathComponent("threads.json")
        let ids = { (host: HostID) in ThreadStore(directory: store.directory).loadThreads().filter { $0.ref.agent.host == host }.map(\.id.rawValue) }
        #expect(save(host) && save(mac))
        #expect(writes.count == 2)
        let settled = try Data(contentsOf: file)

        // Nothing changed, and each saves in turn, as when the app leaves the screen
        // with a thread of each Mac open: the file is not written.
        for _ in 0..<3 {
            #expect(save(host) && save(mac))
        }
        #expect(writes.count == 2)
        #expect(try Data(contentsOf: file) == settled)

        // A thread of one Mac changed: written once, by that Mac's save, and not again
        // by the other's after it.
        held[mac]?[1].unseen = true
        #expect(save(mac))
        #expect(writes.count == 3)
        #expect(save(host) && save(mac) && save(host))
        #expect(writes.count == 3)
        #expect(ThreadStore(directory: store.directory).loadThreads().first { $0.id.rawValue == "d" }?.unseen == true)

        // One Mac's threads in another order are another file, as with one Mac alone:
        // written, and a store that reads the file gives them in that order where
        // their times do not decide.
        held[host]?.append(record("e", updated: 10))
        #expect(save(host))
        #expect(writes.count == 4)
        #expect(ids(host) == ["a", "b", "e"])
        held[host]?.swapAt(1, 2)
        #expect(save(mac))
        #expect(writes.count == 4)
        #expect(save(host))
        #expect(writes.count == 5)
        #expect(ids(host) == ["a", "e", "b"])
        #expect(save(mac) && save(host))
        #expect(writes.count == 5)
        #expect(ids(mac) == ["c", "d"])
    }

    /// The store keeps the list it wrote for as long as the file is the one it wrote.
    /// Which file that is, it sees before the file is in place: in place, the file could
    /// be another one already.
    @Test func aFileSomethingElseWroteRightAfterASaveIsNotTakenForTheListSaved() {
        let scratch = Scratch()
        var store = scratch.store
        let other = ThreadStore(directory: store.directory)
        let mine = record("mine", updated: 10)
        let theirs = {
            var thread = record("theirs", updated: 20)
            thread.ref.agent.host = HostID(rawValue: "mac")
            return thread
        }()
        // The store says it wrote as soon as its file is in place: the first moment
        // something else can write another over it.
        store.onAccess = { access in
            if access.file == "threads.json", access.isWrite, access.bytes > 0 { other.saveThreads([mine, theirs]) }
        }
        #expect(store.saveThreads([mine]))
        store.onAccess = nil
        #expect(store.loadThreads().map(\.id.rawValue) == ["theirs", "mine"])

        // So a save of this host's threads carries the other host's over, as loaded.
        var changed = mine
        changed.preview = "said since"
        #expect(store.saveThreads(store.loadThreads().filter { $0.ref.agent.host != host } + [changed]))
        let read = ThreadStore(directory: store.directory).loadThreads()
        #expect(read.map(\.id.rawValue) == ["theirs", "mine"])
        #expect(read.last?.preview == "said since")
    }

    @Test func aSaveOfTheThreadListMakesTextOfTheThreadsThatChangedAndWritesTheSameFile() throws {
        let scratch = Scratch()
        let made = Count()
        var store = scratch.store
        store.onAccess = { access in
            if access.file == "threads.json", access.isWrite { made.set(access.threadsMadeText ?? -1) }
        }
        // The file as it was written before any text was kept: the whole list encoded at once.
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let file = store.directory.appendingPathComponent("threads.json")
        let isWhole = { (threads: [ThreadRecord]) in try Data(contentsOf: file) == encoder.encode(threads) }

        var threads = (0..<200).map { index -> ThreadRecord in
            var thread = record("t\(index)", agent: index % 3 == 0 ? "hanni" : "claude", title: index % 4 == 0 ? nil : "Title \(index) of \"café\" 修正 🚀", updated: Double(index) + 0.25)
            thread.preview = index % 5 == 0 ? nil : "said last, line \(index)\n</end> / \\ and a tab\t"
            thread.pinned = index % 20 == 3 ? true : nil
            thread.unseen = index % 7 == 0 ? true : nil
            thread.revision = index % 2 == 0 ? index : nil
            thread.startedBy = index % 9 == 0 ? ThreadStarter(name: "Aeri", thread: ThreadRef.ID(rawValue: "aeri")) : nil
            return thread
        }
        #expect(store.saveThreads(threads))
        #expect(made.count == 200)
        #expect(try isWhole(threads))

        // One thread changed: its text is made, the others' is the text of the save before.
        threads[17].pinned = true
        threads[17].updatedAt += 90
        #expect(store.saveThreads(threads))
        #expect(made.count == 1)
        #expect(try isWhole(threads))

        // None changed, in another order: no text is made, and the file is in that order.
        threads.reverse()
        #expect(store.saveThreads(threads))
        #expect(made.count == 0)
        #expect(try isWhole(threads))

        // One gone and one new; then the one gone back, whose text was let go of.
        let gone = threads.remove(at: 3)
        threads.append(record("new", title: "New", updated: 500))
        #expect(store.saveThreads(threads))
        #expect(made.count == 1)
        #expect(try isWhole(threads))
        threads.insert(gone, at: 0)
        #expect(store.saveThreads(threads))
        #expect(made.count == 1)
        #expect(try isWhole(threads))

        // The same thread twice, one thread and none are written as they would be whole.
        for few in [[threads[0], threads[0]], [threads[1]], []] {
            #expect(store.saveThreads(few))
            #expect(try isWhole(few))
        }
        #expect(store.loadThreads().isEmpty)
        #expect(ThreadStore(directory: store.directory).loadThreads().isEmpty)

        // And what a save wrote is what another store reads.
        #expect(store.saveThreads(threads))
        #expect(made.count == threads.count)
        #expect(ThreadStore(directory: store.directory).loadThreads().map(\.id) == store.loadThreads().map(\.id))
    }

    /// Many saves and loads in an order made up from a seed: threads changed, added,
    /// removed and moved, the same list saved again, a save that fails, the file written
    /// by something else. After each, the file is what encoding the list last written
    /// gives, byte for byte, and the store says what a store that never read it reads.
    /// The list last written is the list last saved, or one that holds each host's
    /// threads as that one does and mixes the hosts another way.
    @Test(arguments: [1, 2, 3, 4]) func aStoreInUseAlwaysSaysWhatItsFileHolds(seed: UInt64) throws {
        let scratch = Scratch()
        let store = scratch.store, copy = store
        let file = store.directory.appendingPathComponent("threads.json")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        var state = seed &* 0x9E37_79B9_7F4A_7C15
        func next(_ below: Int) -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((state >> 33) % UInt64(below))
        }
        // Whole seconds, each used once, so a list read back is the list saved.
        var clock = 0
        func made(_ name: String) -> ThreadRecord {
            clock += 1 + next(50)
            var thread = record(name, agent: next(2) == 0 ? "hanni" : "claude", title: next(3) == 0 ? nil : "Title \(name) café 修正", updated: Double(clock))
            thread.ref.agent.host = HostID(rawValue: next(2) == 0 ? "mini" : "mac")
            thread.preview = next(4) == 0 ? nil : "said \(next(1000))\n\"last\""
            return thread
        }
        var names = 0
        var list = (0..<40).map { _ -> ThreadRecord in
            names += 1
            return made("t\(names)")
        }
        /// The list the file holds: the last one written, by this store or anything else.
        var written: [ThreadRecord] = []
        /// Saves of a list that differs from the file's, which left the file as it was.
        var unwritten = 0
        #expect(store.saveThreads(list))
        written = list

        for step in 0..<300 {
            switch next(12) {
            case 0, 1, 2, 3:
                // One thread changes, as after a turn or a mark.
                let index = next(list.count)
                clock += 1 + next(50)
                list[index].updatedAt = t0.addingTimeInterval(Double(clock))
                list[index].unseen = next(2) == 0 ? true : nil
                list[index].pinned = next(5) == 0 ? true : nil
                list[index].revision = step
            case 4:
                names += 1
                list.insert(made("t\(names)"), at: next(list.count + 1))
            case 5:
                if list.count > 5 { list.remove(at: next(list.count)) }
            case 6:
                list.swapAt(next(list.count), next(list.count))
            case 7:
                // The file is written by something else, with a thread less. Either that
                // is loaded and carried on from, or it is not looked at, and the list as
                // it was here is saved over it below.
                let other = ThreadStore(directory: store.directory)
                let theirs = Array(other.loadThreads().dropLast())
                #expect(other.saveThreads(theirs))
                written = theirs
                if next(2) == 0 {
                    #expect((next(2) == 0 ? store : copy).loadThreads() == theirs, "step \(step), after the file was written by something else")
                    list = theirs
                }
            case 8:
                // A save that cannot be made leaves the file, and says so.
                clock += 1
                list[0].updatedAt = t0.addingTimeInterval(Double(clock))
                try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: store.directory.path)
                #expect(!store.saveThreads(list), "step \(step)")
                try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: store.directory.path)
                #expect(try Data(contentsOf: file) == encoder.encode(written), "step \(step), after a save that failed")
                #expect(store.loadThreads() == ThreadStore(directory: store.directory).loadThreads(), "step \(step), after a save that failed")
            case 9:
                // One host's threads first and the other's after them, as that host's
                // model, or the other's, saves the list.
                let first = next(2) == 0 ? "mini" : "mac"
                list = list.filter { $0.ref.agent.host.rawValue == first } + list.filter { $0.ref.agent.host.rawValue != first }
            default:
                // Nothing changes: the list is saved as it is, or loaded.
                break
            }
            // Saved by the store or its copy, as one Mac's model or another's would.
            #expect((next(2) == 0 ? store : copy).saveThreads(list), "step \(step)")
            if try Data(contentsOf: file) == encoder.encode(list) {
                written = list
            } else {
                // Left as it was: only for a list with each host's threads as the file
                // has them, the two hosts' mixed another way.
                let ofEach = { (threads: [ThreadRecord]) in ["mini", "mac"].map { name in threads.filter { $0.ref.agent.host.rawValue == name } } }
                #expect(ofEach(list) == ofEach(written), "step \(step), a list that was not written")
                unwritten += 1
            }
            #expect(try Data(contentsOf: file) == encoder.encode(written), "step \(step)")
            let read = ThreadStore(directory: store.directory).loadThreads()
            #expect((next(2) == 0 ? store : copy).loadThreads() == read, "step \(step)")
            #expect(read == written.sorted { $0.updatedAt > $1.updatedAt }, "step \(step)")
        }
        #expect(unwritten > 0)
    }

    /// A count kept from wherever a store's file is read or written.
    private final class Count: @unchecked Sendable {
        private let lock = NSLock()
        private var counted = 0

        func add() { lock.withLock { counted += 1 } }
        func set(_ count: Int) { lock.withLock { counted = count } }
        var count: Int { lock.withLock { counted } }
    }

    @Test func aTranscriptRoundTrips() {
        let scratch = Scratch()
        var state = ThreadState()
        state.messageSent("fix it", at: t0)
        state.apply(.reasoningDelta("hmm"), at: t0)
        state.apply(.toolStarted(ToolRun(id: "t1", name: "patch", label: "a.py", startedAt: t0)), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t1", name: "patch", succeeded: true, duration: 0.5, diff: "+x")), at: t0)
        state.apply(.textDelta("Done."), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(3))

        let id = ThreadKey(host: host, id: ThreadRef.ID(rawValue: "20261004_225107_ee09b5"))
        #expect(scratch.store.saveTranscript(state.transcript, for: id))
        #expect(scratch.store.loadTranscript(for: id) == state.transcript)

        scratch.store.deleteTranscript(for: id)
        #expect(scratch.store.loadTranscript(for: id) == nil)
    }

    /// The saved copy of a thread being opened is read and decoded away from the main
    /// thread, and is the same as read there.
    @MainActor
    @Test func aTranscriptCanBeReadOffTheMainThread() async throws {
        let scratch = Scratch()
        var state = ThreadState()
        state.messageSent("fix it", at: t0)
        state.apply(.textDelta("Done."), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(3))
        let id = ThreadKey(host: host, id: ThreadRef.ID(rawValue: "far"))
        #expect(scratch.store.saveTranscript(state.transcript, for: id))

        let readOnMain = Count()
        var store = scratch.store
        store.onAccess = { access in if !access.isWrite, Thread.isMainThread { readOnMain.add() } }
        let loaded = await store.loadTranscriptInBackground(for: id)
        #expect(loaded == scratch.store.loadTranscript(for: id))
        #expect(loaded == state.transcript)
        #expect(readOnMain.count == 0)
        #expect(await store.loadTranscriptInBackground(for: ThreadKey(host: host, id: ThreadRef.ID(rawValue: "none"))) == nil)
    }

    /// Saving a thread whose transcript has not changed since it was saved writes nothing:
    /// the app saves every open thread each time it leaves the screen.
    @Test func anUnchangedTranscriptIsNotWrittenAgain() throws {
        let scratch = Scratch()
        let writes = Count()
        var store = scratch.store
        store.onAccess = { access in if access.isWrite, access.file.hasPrefix("transcripts/") { writes.add() } }
        var state = ThreadState()
        state.messageSent("fix it", at: t0)
        state.apply(.textDelta("Done."), at: t0)
        let id = ThreadKey(host: host, id: ThreadRef.ID(rawValue: "kept"))

        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(writes.count == 1)

        // Changed: written.
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(3))
        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(writes.count == 2)
        #expect(store.loadTranscript(for: id) == state.transcript)

        // The file changed by someone else, or gone: written again, though the transcript
        // is the one this store last wrote.
        let url = store.directory.appendingPathComponent(store.transcriptFile(id))
        try Data("{}".utf8).write(to: url)
        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(writes.count == 3)
        #expect(store.loadTranscript(for: id) == state.transcript)
        try FileManager.default.removeItem(at: url)
        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(writes.count == 4)
        store.deleteTranscript(for: id)
        #expect(store.saveTranscript(state.transcript, for: id))
        #expect(writes.count == 5)
        #expect(store.loadTranscript(for: id) == state.transcript)
    }

    /// It remembers the last few it wrote, not every thread ever saved.
    @Test func theTranscriptsRememberedAreBounded() {
        let scratch = Scratch()
        let writes = Count()
        var store = scratch.store
        store.onAccess = { access in if access.isWrite, access.file.hasPrefix("transcripts/") { writes.add() } }
        var state = ThreadState()
        state.messageSent("hello", at: t0)
        let ids = (0..<(ThreadStore.keptTranscripts + 3)).map { ThreadKey(host: host, id: ThreadRef.ID(rawValue: "t\($0)")) }
        for id in ids { store.saveTranscript(state.transcript, for: id) }
        #expect(writes.count == ids.count)
        // The newest are remembered; the three oldest were forgotten, and are written again.
        for id in ids.suffix(ThreadStore.keptTranscripts) { store.saveTranscript(state.transcript, for: id) }
        #expect(writes.count == ids.count)
        for id in ids.prefix(3) { store.saveTranscript(state.transcript, for: id) }
        #expect(writes.count == ids.count + 3)
    }

    /// A copy that could not be written says so, for the thread to be kept in memory
    /// (`OpenThreads`): letting it go would lose what only this device has of it.
    @Test func aTranscriptNotWrittenSaysSo() throws {
        let scratch = Scratch()
        var state = ThreadState()
        state.messageSent("fix it", at: t0)
        let id = ThreadKey(host: host, id: ThreadRef.ID(rawValue: "unwritable"))
        #expect(scratch.store.saveTranscript(state.transcript, for: id))
        let folder = scratch.store.directory.appendingPathComponent(scratch.store.transcriptFolder(host))
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path) }
        // Changed (a second message sent during the turn waits in its queue, which the
        // transcript does not hold).
        state.apply(.textDelta("On it."), at: t0)
        #expect(!scratch.store.saveTranscript(state.transcript, for: id))
    }

    @Test func aTurnSavedWhileRunningLoadsAsStopped() throws {
        let scratch = Scratch()
        var state = ThreadState()
        state.messageSent("go", at: t0)
        state.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", startedAt: t0)), at: t0)
        state.apply(.textDelta("partial"), at: t0)
        let id = ThreadKey(host: host, id: ThreadRef.ID(rawValue: "running"))
        scratch.store.saveTranscript(state.transcript, for: id)

        let loaded = try #require(scratch.store.loadTranscript(for: id))
        #expect(loaded.turns[0].outcome == .interrupted)
        #expect(loaded.turns[0].endedAt != nil)
        guard case let .tool(run) = loaded.turns[0].items[1].content else {
            Issue.record("expected the tool run")
            return
        }
        #expect(run.state == .failed)
        // What was written before the stop is kept.
        #expect(loaded.turns[0].items.last?.content == .text("partial"))
    }

    @Test func aThreadIDCanNeverNameAPath() {
        let store = ThreadStore(directory: URL(fileURLWithPath: "/tmp/x"))
        func file(_ id: String, on host: String = "mini") -> String {
            store.transcriptFile(ThreadKey(host: HostID(rawValue: host), id: ThreadRef.ID(rawValue: id)))
        }
        #expect(file("20261004_225107_ee09b5") == "transcripts/mini/20261004_225107_ee09b5.json")
        #expect(file("../../etc/passwd") == "transcripts/mini/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd.json")
        #expect(file("") == "transcripts/mini/thread.json")
        #expect(!file("a/b").dropFirst("transcripts/mini/".count).contains("/"))
        // Nor can a host's.
        #expect(file("t1", on: "../..") == "transcripts/%2E%2E%2F%2E%2E/t1.json")
        #expect(file("t1", on: "") == "transcripts/host/t1.json")
        #expect(store.legacyTranscriptFile(ThreadRef.ID(rawValue: "../x")) == "transcripts/%2E%2E%2Fx.json")
    }

    @Test func anAgentsNotificationAvatarStaysInItsFolder() {
        let avatars = NotificationAvatars(directory: URL(fileURLWithPath: "/group/NotificationAvatars"))
        #expect(avatars.url(forAgent: "karina").path == "/group/NotificationAvatars/karina.png")
        #expect(avatars.url(forAgent: "../../Library/x").path == "/group/NotificationAvatars/%2E%2E%2F%2E%2E%2FLibrary%2Fx.png")
        #expect(avatars.url(forAgent: "").lastPathComponent == "agent.png")
    }

    @Test func agentsAndLooksRoundTrip() {
        let scratch = Scratch()
        let karina = Agent(id: Agent.ID(host: host, name: "default"), displayName: "Karina", summary: "Runs the house", model: "m", isDefault: true)
        let hanni = Agent(id: Agent.ID(host: host, name: "hanni"), displayName: "Hanni")
        scratch.store.saveAgents([karina, hanni])
        #expect(scratch.store.loadAgents() == [karina, hanni])

        let looks = [karina.id: AgentLook(shape: 1, face: 2, tint: 3), hanni.id: AgentLook(shape: 4, face: 0, tint: 5)]
        scratch.store.saveLooks(looks)
        #expect(scratch.store.loadLooks() == looks)
    }

    @Test func aDamagedFileReadsAsEmptyAndIsRepairedByTheNextSave() throws {
        let scratch = Scratch()
        try FileManager.default.createDirectory(at: scratch.store.directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: scratch.store.directory.appendingPathComponent("threads.json"))
        #expect(scratch.store.loadThreads().isEmpty)
        scratch.store.saveThreads([record("a")])
        #expect(scratch.store.loadThreads().count == 1)
    }

    @Test func whatAHostThatKeepsTheListSaysOfAThreadIsKept() {
        let scratch = Scratch()
        var thread = record("a", title: "Check the build")
        thread.startedBy = ThreadStarter(name: "Aeri", thread: ThreadRef.ID(rawValue: "aeri"))
        thread.revision = 805
        thread.fromHost = true
        var mine = record("b", updated: 5)
        mine.localOnly = true
        scratch.store.saveThreads([thread, mine])
        #expect(scratch.store.loadThreads() == [mine, thread])
    }

    @Test func eachHostsSyncIsKeptApartAndForgottenWithTheHost() {
        let scratch = Scratch()
        let other = HostID(rawValue: "mbp")
        #expect(scratch.store.loadSync().isEmpty)
        #expect(scratch.store.loadSync(for: host) == nil)
        let mini = HostSyncState(
            list: ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812),
            pending: [
                PendingThreadChange(thread: ThreadRef.ID(rawValue: "a"), pinned: false, title: "Renamed"),
                PendingThreadChange(thread: ThreadRef.ID(rawValue: "b"), remove: true),
            ]
        )
        let mbp = HostSyncState(pending: [PendingThreadChange(thread: ThreadRef.ID(rawValue: "c"), archived: true)])
        #expect(scratch.store.saveSync(mini, for: host))
        #expect(scratch.store.saveSync(mbp, for: other))
        #expect(scratch.store.loadSync() == [host: mini, other: mbp])
        // Only the keys given are written.
        let text = (try? String(contentsOf: scratch.store.directory.appendingPathComponent("sync.json"), encoding: .utf8)) ?? ""
        #expect(text.contains(#"{"pinned":false,"thread":"a","title":"Renamed"}"#))

        scratch.store.forgetHost(host)
        #expect(scratch.store.loadSync() == [other: mbp])
        #expect(scratch.store.saveSync(nil, for: other))
        #expect(scratch.store.loadSync().isEmpty)
    }

    @Test func theThreadsAndSyncFilesSayWhenTheyCouldNotBeWritten() throws {
        let scratch = Scratch()
        #expect(scratch.store.saveThreads([record("a")]))
        // Something else stands where each file goes.
        for file in ["threads.json", "sync.json"] {
            let url = scratch.store.directory.appendingPathComponent(file)
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.createDirectory(at: url.appendingPathComponent("in-the-way"), withIntermediateDirectories: true)
        }
        #expect(!scratch.store.saveThreads([record("b")]))
        #expect(!scratch.store.saveSync(HostSyncState(), for: host))
    }

    @Test func aThreadIsCalledByItsTitleThenItsPreview() {
        #expect(record("a", title: "Fix the plugin").displayTitle == "Fix the plugin")
        var untitled = record("a", title: "  ")
        #expect(untitled.displayTitle == "New thread")
        untitled.preview = "What did you find?"
        #expect(untitled.displayTitle == "What did you find?")
    }
}

@Suite struct HostConfigTests {
    @Test func aTypedAddressBecomesAURL() {
        #expect(HostConfig.url(fromTyped: " mini.example.ts.net:8443 ")?.absoluteString == "https://mini.example.ts.net:8443")
        #expect(HostConfig.url(fromTyped: "https://mini.example.ts.net:8443/")?.absoluteString == "https://mini.example.ts.net:8443")
        #expect(HostConfig.url(fromTyped: "http://127.0.0.1:9119")?.absoluteString == "http://127.0.0.1:9119")
        #expect(HostConfig.url(fromTyped: "HTTP://Mac.local:9119//")?.host() == "Mac.local")
    }

    @Test func whatIsNotAnAddressIsRefused() {
        #expect(HostConfig.url(fromTyped: "") == nil)
        #expect(HostConfig.url(fromTyped: "   ") == nil)
        #expect(HostConfig.url(fromTyped: "ftp://mini.example") == nil)
        #expect(HostConfig.url(fromTyped: "https://") == nil)
        #expect(HostConfig.url(fromTyped: "not an address") == nil)
    }

    @Test func aHostNeedsSignInOnlyWithAUserName() {
        let url = URL(string: "https://mini.example.ts.net")!
        #expect(HostConfig(name: "Mini", url: url, username: "dana").needsSignIn)
        #expect(!HostConfig(name: "Mini", url: url, username: "").needsSignIn)
        #expect(!HostConfig(name: "Mini", url: url).needsSignIn)
    }

    @Test func hostsRoundTripThroughTheStore() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-hosts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ThreadStore(directory: directory)
        #expect(store.loadHosts().isEmpty)
        let hosts = [
            HostConfig(id: HostID(rawValue: "local"), name: "This Mac", url: URL(string: "http://127.0.0.1:9119")!),
            HostConfig(name: "Mini", url: URL(string: "https://mini.example.ts.net:8443")!, username: "dana"),
        ]
        store.saveHosts(hosts)
        #expect(store.loadHosts() == hosts)
    }

    @Test func passwordsAreKeptPerHostAndAnEmptyOneRemovesIt() {
        let store = InMemoryCredentialStore()
        let mini = HostID(rawValue: "mini"), mac = HostID(rawValue: "mac")
        store.setPassword("one", for: mini)
        store.setPassword("two", for: mac)
        #expect(store.password(for: mini) == "one")
        #expect(store.password(for: mac) == "two")
        store.setPassword("", for: mini)
        #expect(store.password(for: mini) == nil)
        store.setPassword(nil, for: mac)
        #expect(store.password(for: mac) == nil)
    }
}

@Suite struct AgentLookTests {
    private let catalogue = AgentLook.Catalogue(shapes: 8, faces: 6, tints: 11)

    @Test func aNameAlwaysGetsTheSameLook() {
        let first = AgentLook.derived(from: "hanni", in: catalogue)
        #expect(AgentLook.derived(from: "hanni", in: catalogue) == first)
        #expect(AgentLook.derived(from: "Hanni", in: catalogue) == first) // case does not matter
        #expect((0..<8).contains(first.shape))
        #expect((0..<6).contains(first.face))
        #expect((0..<11).contains(first.tint))
        // Pinned: a change to the hash would silently re-dress every agent.
        #expect(AgentLook.stableHash("hanni") == 0x81d6_8c69_306c_02f5)
    }

    @Test func theAgentsOfOneHostAreToldApart() {
        let names = ["default", "aeri", "hanni", "wonyoung"]
        let looks = AgentLook.assign(to: names, keeping: [:], in: catalogue)
        #expect(looks.count == 4)
        #expect(Set(looks.values.map(\.shape)).count == 4)
        #expect(Set(looks.values.map(\.tint)).count == 4)
        // The order agents are listed in does not change who gets what.
        #expect(AgentLook.assign(to: names.reversed(), keeping: [:], in: catalogue) == looks)
    }

    @Test func chosenLooksAreKeptAndNewAgentsAvoidThem() {
        let chosen = ["hanni": AgentLook(shape: 3, face: 1, tint: 4)]
        let looks = AgentLook.assign(to: ["hanni", "aeri", "gone-later"], keeping: chosen, in: catalogue)
        #expect(looks["hanni"] == chosen["hanni"])
        #expect(looks["aeri"]?.shape != 3)
        #expect(looks["aeri"]?.tint != 4)

        // An agent that left the host loses its entry; the rest are untouched.
        let later = AgentLook.assign(to: ["hanni", "aeri"], keeping: looks, in: catalogue)
        #expect(later == looks.filter { $0.key != "gone-later" })
    }

    @Test func moreAgentsThanShapesStillGetLooks() {
        let small = AgentLook.Catalogue(shapes: 2, faces: 1, tints: 2)
        let looks = AgentLook.assign(to: ["a", "b", "c", "d"], keeping: [:], in: small)
        #expect(looks.count == 4)
        #expect(looks.values.allSatisfy { (0..<2).contains($0.shape) && (0..<2).contains($0.tint) })
    }
}
