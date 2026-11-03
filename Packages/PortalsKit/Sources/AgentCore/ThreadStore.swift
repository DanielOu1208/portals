import Foundation
import Synchronization

/// A thread as the app lists it: who it is with, what it is called, when it last moved.
///
/// With most hosts the app lists only threads it started. A host that keeps the list for
/// every device (`ThreadSyncing`) lists them all, and these records are the device's copy
/// of that list. The host keeps the full transcript; the app keeps a copy for opening a
/// thread at once and for reading without a connection.
public struct ThreadRecord: Identifiable, Codable, Hashable, Sendable {
    public var ref: ThreadRef
    /// When the thread last ran: a turn started or ended in it (a message was sent, or the
    /// host said so), or it was taken up from the desk. Nothing else moves it, a title,
    /// a pin, an archive, a seen or a sync included: from a host that keeps the list it
    /// is the host's own time for the same (`ListedThread.updated`, which only a turn
    /// moves there). The groups on top of the sidebar are in its order
    /// (`SidebarGroups`), so opening a thread or going through the tabs moves nothing.
    public var updatedAt: Date
    /// The last thing said, for the list.
    public var preview: String?
    /// How full the model's context was when the host last said, so it can be shown
    /// before the thread is used again.
    public var context: ContextUsage?
    /// Kept at the top of the list. nil (in threads saved before pins) is not pinned.
    public var pinned: Bool?
    /// Put away: out of the list until it is taken back out, or something happens in it.
    /// The session stays on the host. nil is not archived.
    public var archived: Bool?
    /// A turn finished while the thread was not on screen, and it has not been opened
    /// since. nil is seen.
    public var unseen: Bool?

    // What a host that keeps the list says of the thread (`ThreadSync`). All are nil in
    // threads saved before, and for any other host.

    /// Who started it, when an agent did.
    public var startedBy: ThreadStarter?
    /// Shown in the sidebar, though an agent started it from another thread, under which
    /// it is listed otherwise (a bridge's `agent_threads`): someone put it there. nil is
    /// false.
    public var shared: Bool?
    /// Under Recent on every device, unless archived, on a host that keeps that for them (a
    /// bridge's `recent_threads`, `RecentThreads`). nil is false.
    public var recent: Bool?
    /// The git branch checked out in its folder as a turn last started or ended there,
    /// where the work lands. nil outside a repository, and from a host that does not say.
    public var branch: String?
    /// For a thread whose folder is in a git worktree: the folder of the repository's main
    /// checkout, the project it is listed under (`SidebarProject.ID(of:)`); its own folder
    /// stays `ref.workingDirectory`. The host keeps it once the worktree is gone. nil for
    /// any other thread, and from a host that does not say.
    public var repo: String?
    /// The host's list's revision when the thread last changed there, as last listed:
    /// sent with a seen.
    public var revision: Int?
    /// Which turn is its latest, as last listed (`ListedThread.turn`): what a turn read
    /// here before the list had its end is known by.
    public var turn: Int?
    /// Listed by the host, not started or taken up on this device. nil is false.
    public var fromHost: Bool?
    /// Not on the host's list when this device first merged that list, nor taken off
    /// it: kept on this device only, and never forgotten for not being listed. Cleared
    /// once the host lists it. nil is false.
    public var localOnly: Bool?

    public init(
        ref: ThreadRef, updatedAt: Date = .now, preview: String? = nil, context: ContextUsage? = nil,
        pinned: Bool = false, archived: Bool = false
    ) {
        self.ref = ref
        self.updatedAt = updatedAt
        self.preview = preview
        self.context = context
        self.pinned = pinned ? true : nil
        self.archived = archived ? true : nil
    }

    /// What a thread working in a git worktree says on its row, beside its repository's
    /// project: the worktree's branch, or the worktree's folder on a detached HEAD. nil for
    /// a thread in no worktree, whose branch only heads its menu.
    public var worktreeBranch: String? {
        guard let repo, !repo.isEmpty else { return nil }
        if let branch, !branch.isEmpty { return branch }
        return ref.workingDirectory.map { Folder.name(of: $0, general: nil) }
    }

    public var isPinned: Bool { pinned == true }
    public var isArchived: Bool { archived == true }
    public var isUnseen: Bool { unseen == true }
    public var isShared: Bool { shared == true }
    public var isRecent: Bool { recent == true }
    public var isFromHost: Bool { fromHost == true }
    public var isLocalOnly: Bool { localOnly == true }

    public var id: ThreadRef.ID { ref.id }
    /// The thread among every host's.
    public var key: ThreadKey { ref.key }

    /// What to call the thread in a list: its title, or how it began.
    public var displayTitle: String {
        if let title = ref.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        if let preview = preview?.trimmingCharacters(in: .whitespacesAndNewlines), !preview.isEmpty { return preview }
        return "New thread"
    }
}

/// The app's files on the device: the thread list, a transcript per thread (in a folder
/// per host), the agents last seen on each host and the looks chosen for them, and for a
/// host that keeps the list of threads, the changes made here it has not taken yet.
///
/// Plain JSON files, written atomically. Losing them loses nothing the host does not
/// have, except the list of which threads are this app's and those changes.
public struct ThreadStore: Sendable {
    public var directory: URL
    /// Told of each read and each write of one of the store's files as it is made on the
    /// disk, for tests and benchmarks to count them. The app sets none.
    public var onAccess: (@Sendable (FileAccess) -> Void)?
    /// The thread list as this store, or a copy of it, last read or wrote it.
    private let kept = Kept()

    public init(directory: URL) {
        self.directory = directory
    }

    /// One read or write of a file of the store's.
    public struct FileAccess: Hashable, Sendable {
        /// The file, as a path within the store's folder: `threads.json`.
        public var file: String
        public var isWrite: Bool
        /// The bytes read or written; 0 when it failed.
        public var bytes: Int
        /// For a write of the thread list, how many of its threads were made into text
        /// for it: the others' text was kept from the write before.
        public var threadsMadeText: Int?
    }

    /// `Application Support/AeriPortal`: the folder keeps the app's name before it was
    /// Portals, so a device's threads stay where they are.
    public static var standard: ThreadStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return ThreadStore(directory: base.appendingPathComponent("AeriPortal", isDirectory: true))
    }

    // MARK: Hosts

    /// The hosts the user set up, in the order they were added.
    public func loadHosts() -> [HostConfig] {
        read([HostConfig].self, from: "hosts.json") ?? []
    }

    public func saveHosts(_ hosts: [HostConfig]) {
        write(hosts, to: "hosts.json")
    }

    // MARK: The net

    /// The device's place in a net (`NetMembership`): nil before it ever had one, or when
    /// the file cannot be read.
    public func loadNet() -> NetMembership? {
        read(NetMembership.self, from: "net.json")
    }

    /// False when the file could not be written.
    @discardableResult
    public func saveNet(_ membership: NetMembership) -> Bool {
        write(membership, to: "net.json")
    }

    // MARK: Thread list

    /// Every thread, most recently active first.
    ///
    /// Read from the file only when the file is not the one this store last read or
    /// wrote (`KeptThreads`): every save of one host's threads loads the list first, for
    /// the other hosts' to carry over, and that list is the one the save before it wrote.
    public func loadThreads() -> [ThreadRecord] {
        let path = directory.appendingPathComponent(Self.threadsFile).path
        return kept.threads.withLock { kept in
            let found = FileStamp(path)
            if let found, kept.list?.path == path, kept.list?.stamp == found, let threads = kept.list?.sorted() { return threads }
            kept.list = nil
            guard let threads = read([ThreadRecord].self, from: Self.threadsFile) else { return [] }
            // Kept only when it was read whole, from a file that was not replaced meanwhile.
            if let found, FileStamp(path) == found {
                kept.list = KeptThreads(path: path, stamp: found, threads: threads)
            }
            return kept.list?.sorted() ?? threads.sorted { $0.updatedAt > $1.updatedAt }
        }
    }

    /// False when the file could not be written.
    ///
    /// A list that is what the file holds already, each host's threads in the file's
    /// order, is not written again: every open thread saves its entry when the app
    /// leaves the screen, changed or not. How the hosts' threads are mixed is not looked
    /// at (`holdSameThreads`): each host's model saves the others' first and its own
    /// after them, so with two hosts the same list comes mixed two ways in turn.
    ///
    /// The file is the list as JSON, each thread's text after the other. A thread's text
    /// says the same for as long as the thread does, so it is kept from one save to the
    /// next (`Kept.text`) and only a thread that changed is made into text again: a turn
    /// changes one thread, and the list is saved whole each time.
    @discardableResult
    public func saveThreads(_ threads: [ThreadRecord]) -> Bool {
        let path = directory.appendingPathComponent(Self.threadsFile).path
        return kept.threads.withLock { kept in
            if let list = kept.list, list.path == path, Self.holdSameThreads(list.written, threads), FileStamp(path) == list.stamp { return true }
            kept.list = nil
            let encoder = Self.encoder()
            var text: [ThreadRecord: Data] = [:]
            text.reserveCapacity(threads.count)
            var file = Data("[".utf8)
            var made = 0
            for (index, record) in threads.enumerated() {
                var part = kept.text[record]
                if part == nil {
                    part = try? encoder.encode(record)
                    made += 1
                }
                guard let part else {
                    onAccess?(FileAccess(file: Self.threadsFile, isWrite: true, bytes: 0))
                    return false
                }
                text[record] = part
                if index > 0 { file.append(UInt8(ascii: ",")) }
                file.append(part)
            }
            file.append(UInt8(ascii: "]"))
            // Only the text of the threads now in the list is kept.
            kept.text = text
            let (isWritten, written) = writeThreadsFile(file, threadsMadeText: made)
            if let written {
                kept.list = KeptThreads(path: path, stamp: written, threads: threads)
            }
            return isWritten
        }
    }

    /// Whether two lists hold the same threads with each host's in the same order, so
    /// that they differ, if at all, in how the hosts' threads are mixed. That says
    /// nothing to anyone: whoever loads the list takes one host's threads from it, or
    /// all but one host's, and those come out the same either way.
    private static func holdSameThreads(_ one: [ThreadRecord], _ other: [ThreadRecord]) -> Bool {
        guard one.count == other.count else { return false }
        guard let first = one.indices.first(where: { one[$0] != other[$0] }) else { return true }
        // The lists are alike up to here, so two threads of one host here are that
        // host's next in each, and its threads differ: the usual case, a thread that
        // changed, found without looking further.
        guard one[first].ref.agent.host != other[first].ref.agent.host else { return false }
        var rest: [HostID: [ThreadRecord]] = [:]
        for record in other[first...] {
            rest[record.ref.agent.host, default: []].append(record)
        }
        var taken: [HostID: Int] = [:]
        for record in one[first...] {
            let host = record.ref.agent.host
            let index = taken[host, default: 0]
            guard let theirs = rest[host], index < theirs.count, theirs[index] == record else { return false }
            taken[host] = index + 1
        }
        return true
    }

    /// Writes the thread list's file, a new file in the old one's place, and says which
    /// file it wrote: nil when that could not be seen, and then the list is read from
    /// the file when it is next asked for.
    ///
    /// The file is written under a name of its own, looked at there, and then moved
    /// into place. Looked at in place after the write, it could be another file
    /// already, one that something else wrote in between, and that file would be taken
    /// to hold this list.
    private func writeThreadsFile(_ data: Data, threadsMadeText made: Int) -> (isWritten: Bool, written: FileStamp?) {
        let file = directory.appendingPathComponent(Self.threadsFile)
        let new = directory.appendingPathComponent("\(Self.threadsFile).\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: new, options: Self.writingOptions)
            let written = FileStamp(new.path)
            guard rename(new.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            onAccess?(FileAccess(file: Self.threadsFile, isWrite: true, bytes: data.count, threadsMadeText: made))
            return (true, written)
        } catch {
            try? FileManager.default.removeItem(at: new)
            onAccess?(FileAccess(file: Self.threadsFile, isWrite: true, bytes: 0))
            return (false, nil)
        }
    }

    private static let threadsFile = "threads.json"

    /// What a store and its copies share: the app makes one store and hands every host's
    /// model a copy. Locked while the file is read or written, so the list kept and the
    /// file it is said to be are of the same moment.
    private final class Kept: Sendable {
        let threads = Mutex(Threads())
        /// The transcripts last written, by file, while the file is still that one.
        let transcripts = Mutex([String: KeptTranscript]())

        struct Threads: Sendable {
            /// The list as last read or written, while the file is still that one.
            var list: KeptThreads?
            /// The JSON of each thread of the list last saved, as the file has it.
            var text: [ThreadRecord: Data] = [:]
        }
    }

    /// A transcript and the file it is the content of, the `order`th written.
    private struct KeptTranscript: Sendable {
        let stamp: FileStamp
        let transcript: Transcript
        let order: Int
    }

    /// A thread list and the file it is the content of. The file is written whole, a new
    /// file in the old one's place each time, so while the file found at `path` is still
    /// that one (`stamp`), reading it would give this list again. A list that was saved
    /// has its times as they were when saved, where the file has them to the second.
    private struct KeptThreads: Sendable {
        let path: String
        let stamp: FileStamp
        /// The list in the file's order.
        let written: [ThreadRecord]
        private var inOrder: [ThreadRecord]?

        init(path: String, stamp: FileStamp, threads: [ThreadRecord]) {
            self.path = path
            self.stamp = stamp
            written = threads
        }

        /// Most recently active first, as `loadThreads` gives them; sorted once.
        mutating func sorted() -> [ThreadRecord] {
            if let inOrder { return inOrder }
            let sorted = written.sorted { $0.updatedAt > $1.updatedAt }
            inOrder = sorted
            return sorted
        }
    }

    /// Which file is at a path now: another one after every write of it.
    private struct FileStamp: Hashable, Sendable {
        var device: Int32
        var file: UInt64
        var seconds: Int
        var nanoseconds: Int
        var bytes: Int64

        /// nil when nothing is there.
        init?(_ path: String) {
            var info = stat()
            guard lstat(path, &info) == 0 else { return nil }
            device = info.st_dev
            file = info.st_ino
            seconds = info.st_mtimespec.tv_sec
            nanoseconds = info.st_mtimespec.tv_nsec
            bytes = info.st_size
        }
    }

    // MARK: Hosts that keep the list

    /// What the device keeps about each host that keeps the list of threads for every
    /// device (`HostSync`): the list last merged and the changes not sent yet. A host
    /// that never kept it has no entry.
    public func loadSync() -> [HostID: HostSyncState] {
        let entries = read([String: HostSyncState].self, from: "sync.json") ?? [:]
        return Dictionary(uniqueKeysWithValues: entries.map { (HostID(rawValue: $0.key), $0.value) })
    }

    public func loadSync(for host: HostID) -> HostSyncState? {
        loadSync()[host]
    }

    /// Saves one host's entry, keeping the others'; nil erases it. False when the file
    /// could not be written.
    @discardableResult
    public func saveSync(_ state: HostSyncState?, for host: HostID) -> Bool {
        var entries = Dictionary(uniqueKeysWithValues: loadSync().map { ($0.key.rawValue, $0.value) })
        entries[host.rawValue] = state
        return write(entries, to: "sync.json")
    }

    // MARK: Transcripts

    /// The saved copy of a thread, with anything that was still running when it was
    /// saved marked as stopped: whatever happened next, the app did not see it.
    ///
    /// A copy saved before transcripts were kept per host is moved into its host's
    /// folder the first time it is read.
    public func loadTranscript(for thread: ThreadKey) -> Transcript? {
        guard var transcript = read(Transcript.self, from: movingLegacyTranscript(for: thread)) else { return nil }
        for index in transcript.turns.indices where transcript.turns[index].isRunning {
            transcript.turns[index].outcome = .interrupted
            transcript.turns[index].endedAt = transcript.turns[index].endedAt ?? transcript.turns[index].startedAt
            for itemIndex in transcript.turns[index].items.indices {
                guard case var .tool(run) = transcript.turns[index].items[itemIndex].content, run.state == .running else { continue }
                run.state = .failed
                transcript.turns[index].items[itemIndex].content = .tool(run)
            }
        }
        return transcript
    }

    /// `loadTranscript`, on a thread of the system's rather than the caller's: a long
    /// thread's saved copy is most of a megabyte of JSON, which the main thread read and
    /// decoded as the thread was opened (a 45-turn thread, 0.9 MB).
    @concurrent
    public func loadTranscriptInBackground(for thread: ThreadKey) async -> Transcript? {
        loadTranscript(for: thread)
    }

    /// Whether it was written: a thread is only let go once its copy is on disk.
    ///
    /// A transcript the file already holds, as this store last wrote it, is not written
    /// again: every open thread is saved each time the app leaves the screen (twice on
    /// the way to the background, and at each pull of Control Center), and each turn's end
    /// saves its thread twice, all on the main thread, a 45-turn thread being 0.9 MB of
    /// JSON. Equal transcripts mostly share their storage, so telling is quick.
    @discardableResult
    public func saveTranscript(_ transcript: Transcript, for thread: ThreadKey) -> Bool {
        let file = transcriptFile(thread)
        let path = directory.appendingPathComponent(file).path
        if let last = kept.transcripts.withLock({ $0[file] }), last.transcript == transcript, FileStamp(path) == last.stamp {
            return true
        }
        guard write(transcript, to: file) else { return false }
        if let stamp = FileStamp(path) {
            kept.transcripts.withLock { kept in
                kept[file] = KeptTranscript(stamp: stamp, transcript: transcript, order: (kept.values.map(\.order).max() ?? 0) + 1)
                // The threads saved most recently: the ones open, more or less.
                if kept.count > Self.keptTranscripts, let oldest = kept.min(by: { $0.value.order < $1.value.order }) {
                    kept[oldest.key] = nil
                }
            }
        }
        return true
    }

    /// How many transcripts the store remembers having written: as many as the app keeps
    /// open (`OpenThreads`), with room for the one on screen and a few running.
    static let keptTranscripts = 12

    /// Erases the saved copy of a thread, and the images that were sent in it.
    public func deleteTranscript(for thread: ThreadKey) {
        kept.transcripts.withLock { $0[transcriptFile(thread)] = nil }
        for file in [transcriptFile(thread), legacyTranscriptFile(thread.id)] {
            if let transcript = read(Transcript.self, from: file) {
                for case let .user(message) in transcript.turns.flatMap(\.items).map(\.content) {
                    message.images.forEach { try? FileManager.default.removeItem(at: imageURL($0.id)) }
                }
            }
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file))
        }
    }

    /// The file a thread's transcript is in. Before transcripts were kept per host they
    /// were all in one folder, by thread id; such a copy is moved to its host's folder
    /// first. It is written there before the old file is removed, so a failure halfway
    /// loses nothing, and the old file is read until the move succeeds.
    private func movingLegacyTranscript(for thread: ThreadKey) -> String {
        let files = FileManager.default
        let current = transcriptFile(thread), legacy = legacyTranscriptFile(thread.id)
        let new = directory.appendingPathComponent(current)
        guard !files.fileExists(atPath: new.path),
              let data = try? Data(contentsOf: directory.appendingPathComponent(legacy)) else { return current }
        do {
            try files.createDirectory(at: new.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: new, options: Self.writingOptions)
        } catch {
            return legacy
        }
        try? files.removeItem(at: directory.appendingPathComponent(legacy))
        return current
    }

    // MARK: Images

    /// Where the app's own copy of an image sent with a message is kept. The host's
    /// history does not hand images back, so this copy is what the transcript shows.
    public func imageURL(_ image: AttachedImage.ID) -> URL {
        directory.appendingPathComponent("images/\(image.uuidString).jpg")
    }

    public func saveImage(_ data: Data, id: AttachedImage.ID) {
        let url = imageURL(id)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    public func loadImage(_ id: AttachedImage.ID) -> Data? {
        try? Data(contentsOf: imageURL(id))
    }

    // MARK: Agents and looks

    /// The agents each host had the last time it was reachable, so the list is not empty
    /// while the app connects.
    public func loadAgents() -> [Agent] {
        read([Agent].self, from: "agents.json") ?? []
    }

    public func saveAgents(_ agents: [Agent]) {
        write(agents, to: "agents.json")
    }

    public func loadLooks() -> [Agent.ID: AgentLook] {
        Dictionary((read([StoredLook].self, from: "looks.json") ?? []).map { ($0.agent, $0.look) }, uniquingKeysWith: { _, last in last })
    }

    /// Who decided each look. A look saved before this was kept has none.
    public func loadLookOrigins() -> [Agent.ID: LookOrigin] {
        Dictionary(
            (read([StoredLook].self, from: "looks.json") ?? []).compactMap { stored in stored.origin.map { (stored.agent, $0) } },
            uniquingKeysWith: { _, last in last }
        )
    }

    /// Where each look stands with a host that keeps its agents' looks for every device
    /// (`LookSyncing`). A look that was never such a host's has none.
    public func loadLookStates() -> [Agent.ID: LookSyncState] {
        Dictionary(
            (read([StoredLook].self, from: "looks.json") ?? []).compactMap { stored in stored.sync.map { (stored.agent, $0) } },
            uniquingKeysWith: { _, last in last }
        )
    }

    /// Saves every host's looks, with who decided each and where it stands with its
    /// host, where those are known.
    public func saveLooks(
        _ looks: [Agent.ID: AgentLook], origins: [Agent.ID: LookOrigin] = [:], states: [Agent.ID: LookSyncState] = [:]
    ) {
        let stored = looks.map { StoredLook(agent: $0.key, look: $0.value, origin: origins[$0.key], sync: states[$0.key]) }
            .sorted { ($0.agent.host.rawValue, $0.agent.name) < ($1.agent.host.rawValue, $1.agent.name) }
        write(stored, to: "looks.json")
    }

    private struct StoredLook: Codable {
        var agent: Agent.ID
        var look: AgentLook
        /// Optional: files written before it was kept have none.
        var origin: LookOrigin?
        /// Optional: only a look of a host that keeps looks has one.
        var sync: LookSyncState?

        init(agent: Agent.ID, look: AgentLook, origin: LookOrigin?, sync: LookSyncState?) {
            self.agent = agent
            self.look = look
            self.origin = origin
            self.sync = sync
        }

        /// The list is decoded as a whole, so a state this version cannot read counts as
        /// none instead of losing every look.
        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            agent = try container.decode(Agent.ID.self, forKey: .agent)
            look = try container.decode(AgentLook.self, forKey: .look)
            origin = try container.decodeIfPresent(LookOrigin.self, forKey: .origin)
            sync = (try? container.decodeIfPresent(LookSyncState.self, forKey: .sync)) ?? nil
        }
    }

    // MARK: The sidebar's order

    /// The order the user gave each host's agents and folders, with where it stands
    /// with a host that keeps it for every device (`SidebarOrderSyncing`).
    public func loadOrders() -> [HostID: HeldSidebarOrder] {
        let entries = read([String: HeldSidebarOrder].self, from: "order.json") ?? [:]
        return Dictionary(uniqueKeysWithValues: entries.map { (HostID(rawValue: $0.key), $0.value) })
    }

    /// Saves one host's order, keeping the others'; nil, or one with nothing in it,
    /// erases it.
    public func saveOrder(_ order: HeldSidebarOrder?, for host: HostID) {
        var entries = Dictionary(uniqueKeysWithValues: loadOrders().map { ($0.key.rawValue, $0.value) })
        entries[host.rawValue] = order.flatMap { $0.isEmpty ? nil : $0 }
        write(entries, to: "order.json")
    }

    /// The order of the user's Macs as this device goes by it: the one arranged last
    /// that it knows of (`MachineOrder`).
    public func loadMachineOrder() -> MachineOrder? {
        read(MachineOrder.self, from: "machines.json")
    }

    public func saveMachineOrder(_ order: MachineOrder) {
        write(order, to: "machines.json")
    }

    // MARK: Removing a host

    /// Erases everything kept for a host: its threads and their transcripts and images,
    /// what was kept about its list, its agents and their looks, and the order they were
    /// given. The host's own entry and password are the caller's.
    public func forgetHost(_ host: HostID) {
        let submissions = SubmissionStore(threads: self)
        for draft in submissions.load() where draft.agent.host == host {
            try? submissions.remove(draft.id)
        }
        let threads = loadThreads()
        for thread in threads where thread.ref.agent.host == host {
            deleteTranscript(for: thread.key)
        }
        saveThreads(threads.filter { $0.ref.agent.host != host })
        if loadSync(for: host) != nil { saveSync(nil, for: host) }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(transcriptFolder(host)))
        saveAgents(loadAgents().filter { $0.id.host != host })
        saveLooks(loadLooks().filter { $0.key.host != host }, origins: loadLookOrigins(), states: loadLookStates())
        if loadOrders()[host] != nil { saveOrder(nil, for: host) }
    }

    // MARK: Files

    /// A thread's transcript, in its host's folder. Neither id can name a path
    /// (`safeFileName`).
    func transcriptFile(_ thread: ThreadKey) -> String {
        "\(transcriptFolder(thread.host))/\(safeFileName(thread.id.rawValue, otherwise: "thread")).json"
    }

    func transcriptFolder(_ host: HostID) -> String {
        "transcripts/\(safeFileName(host.rawValue, otherwise: "host"))"
    }

    /// Where a transcript was kept before there was a folder per host.
    func legacyTranscriptFile(_ thread: ThreadRef.ID) -> String {
        "transcripts/\(safeFileName(thread.rawValue, otherwise: "thread")).json"
    }

    private func read<Value: Decodable>(_ type: Value.Type, from file: String) -> Value? {
        let data = try? Data(contentsOf: directory.appendingPathComponent(file))
        onAccess?(FileAccess(file: file, isWrite: false, bytes: data?.count ?? 0))
        guard let data else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(type, from: data)
    }

    /// False when the file could not be written. Most callers need not care: a failed
    /// save costs a cache entry, not data, as the host has the transcript.
    @discardableResult
    private func write(_ value: some Encodable, to file: String) -> Bool {
        guard let data = try? Self.encoder().encode(value) else {
            onAccess?(FileAccess(file: file, isWrite: true, bytes: 0))
            return false
        }
        return write(data, to: file)
    }

    /// Writes a file's JSON, a new file in the old one's place.
    private func write(_ data: Data, to file: String) -> Bool {
        let url = directory.appendingPathComponent(file)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: Self.writingOptions)
            onAccess?(FileAccess(file: file, isWrite: true, bytes: data.count))
            return true
        } catch {
            onAccess?(FileAccess(file: file, isWrite: true, bytes: 0))
            return false
        }
    }

    /// How every file of the store is written: the same value gives the same text.
    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static var writingOptions: Data.WritingOptions {
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        // Readable after the first unlock, so a turn can be saved in the background.
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        return options
    }
}
