import Foundation
import Synchronization
import Testing
@testable import Watchdog

@Suite struct CappedLogTests {
    private func scratch() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("watchdog-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func linesGoAtTheEndAndTheFolderIsMade() throws {
        let folder = try scratch()
        defer { try? FileManager.default.removeItem(at: folder) }
        let log = CappedLog(url: folder.appendingPathComponent("Diagnostics/watchdog.jsonl"), cap: 1000)
        try log.append("one")
        try log.append("two")
        #expect(try String(contentsOf: log.url, encoding: .utf8) == "one\ntwo\n")
    }

    @Test func theFileNeverGrowsPastItsCapAndKeepsTheNewestWholeLines() throws {
        let folder = try scratch()
        defer { try? FileManager.default.removeItem(at: folder) }
        let log = CappedLog(url: folder.appendingPathComponent("watchdog.jsonl"), cap: 4096)
        var rewrites = 0
        var lastSize = 0
        for index in 0..<2000 {
            try log.append(#"{"entry":\#(index),"stack":"\#(String(repeating: "x", count: index % 90))"}"#)
            let size = try #require(try FileManager.default.attributesOfItem(atPath: log.url.path)[.size] as? Int)
            #expect(size <= 4096)
            if size < lastSize { rewrites += 1 }
            lastSize = size
        }
        let lines = try String(contentsOf: log.url, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
        #expect(lines.last == "")
        let entries = lines.dropLast().map { line -> Int in
            let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            return object?["entry"] as? Int ?? -1
        }
        // Whole lines, in order, ending with the last one written.
        #expect(!entries.contains(-1))
        #expect(entries == Array((entries.first ?? 0)...1999))
        #expect(entries.count > 20)
        // Trimmed to half each time, so rewritten now and then, not at every line.
        #expect(rewrites > 10 && rewrites < 200)
    }

    @Test func newestLinesCutsAtALineEnd() {
        let data = Data("aaaa\nbbbb\ncccc\n".utf8)
        #expect(CappedLog.newestLines(of: data, within: 100) == data)
        #expect(String(decoding: CappedLog.newestLines(of: data, within: 10), as: UTF8.self) == "cccc\n")
        #expect(String(decoding: CappedLog.newestLines(of: data, within: 11), as: UTF8.self) == "bbbb\ncccc\n")
        #expect(CappedLog.newestLines(of: data, within: 3).isEmpty)
        #expect(CappedLog.newestLines(of: data, within: 0).isEmpty)
    }

    @Test func aReportFolderKeepsTheNewest() throws {
        let folder = try scratch()
        defer { try? FileManager.default.removeItem(at: folder) }
        for (day, size) in [(1, 100), (2, 100), (3, 500), (4, 100), (5, 100), (6, 100)] {
            try Data(count: size).write(to: folder.appendingPathComponent("2026-10-0\(day)-diagnostics.json"))
        }
        // Four at most: the two oldest go.
        let byCount = ReportFolder.prune(folder, keeping: 4, within: 10_000)
        #expect(byCount.sorted() == ["2026-10-01-diagnostics.json", "2026-10-02-diagnostics.json"])
        // 700 bytes at most: the 500-byte one does not fit after the three newest, and
        // nothing older than it stays either.
        let byBytes = ReportFolder.prune(folder, keeping: 10, within: 700)
        #expect(byBytes == ["2026-10-03-diagnostics.json"])
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
            == ["2026-10-04-diagnostics.json", "2026-10-05-diagnostics.json", "2026-10-06-diagnostics.json"])
    }
}

/// Keeps a thread of its own running its run loop, to watch as the app's main thread is.
final class LoopThread: Thread, @unchecked Sendable {
    private let ready = DispatchSemaphore(value: 0)
    private(set) var runLoop: CFRunLoop!
    private(set) var probe: ThreadProbe!

    static func started() -> LoopThread {
        let thread = LoopThread()
        thread.start()
        thread.ready.wait()
        return thread
    }

    override func main() {
        runLoop = CFRunLoopGetCurrent()
        probe = .current()
        // Something to wait for, so the run loop does not return at once.
        RunLoop.current.add(Timer(timeInterval: 1000, repeats: true) { _ in }, forMode: .default)
        ready.signal()
        while !isCancelled {
            RunLoop.current.run(mode: .default, before: .distantFuture)
        }
    }

    /// Runs `work` on the thread, in a turn of its run loop.
    func perform(_ work: @escaping @Sendable () -> Void) {
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, work)
        CFRunLoopWakeUp(runLoop)
    }

    func stop() {
        cancel()
        perform {}
    }
}

/// Keeps the CPU busy for `seconds` on the thread it is called on.
@inline(never)
public func watchdogTestSpin(_ seconds: Double) {
    let end = Date().addingTimeInterval(seconds)
    var x = 0.0
    while Date() < end {
        for i in 0..<1000 { x += sin(Double(i)) }
    }
    blackHole(x)
}

/// Keeps the CPU busy on the thread it is called on until the thread has used `cpuSeconds`
/// more CPU time, by the system's clock of the thread's own CPU time (not its probe), however
/// long that takes on a loaded Mac.
@inline(never)
public func watchdogTestSpin(cpuSeconds: Double) {
    let end = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) + UInt64(cpuSeconds * 1e9)
    var x = 0.0
    while clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) < end {
        for i in 0..<1000 { x += sin(Double(i)) }
    }
    blackHole(x)
}

/// Keeps the CPU busy on the thread it is called on, from when it signals `started` until
/// `stop` is set.
@inline(never)
public func watchdogTestSpin(started: DispatchSemaphore, until stop: SpinStop) {
    started.signal()
    var x = 0.0
    while !stop.isSet {
        for i in 0..<1000 { x += sin(Double(i)) }
    }
    blackHole(x)
}

public final class SpinStop: Sendable {
    private let flag = Atomic(false)
    public init() {}
    public var isSet: Bool { flag.load(ordering: .acquiring) }
    public func set() { flag.store(true, ordering: .releasing) }
}

@inline(never)
func blackHole(_ value: Double) {
    if value == .infinity { print(value) }
}

@Suite(.serialized) struct ThreadProbeTests {
    @Test func cpuTimeOfABusyThreadGrowsWithTheClockAndOfAnIdleOneDoesNot() throws {
        let thread = LoopThread.started()
        defer { thread.stop() }
        let probe = try #require(thread.probe)
        let before = try #require(probe.cpuSeconds())
        Thread.sleep(forTimeInterval: 0.3)
        let idle = try #require(probe.cpuSeconds()) - before
        #expect(idle < 0.02)
        // Busy for 0.4 s of its own CPU time, however long a loaded Mac takes to give it.
        let spun = DispatchSemaphore(value: 0)
        let start = Date()
        thread.perform {
            watchdogTestSpin(cpuSeconds: 0.4)
            spun.signal()
        }
        spun.wait()
        let wall = Date().timeIntervalSince(start)
        let busy = try #require(probe.cpuSeconds()) - before - idle
        // All of it counted, and little more: the probe reads the thread's CPU time, not
        // the clock (it never runs ahead of the time that passed).
        #expect(busy >= 0.4 - 0.001 && busy < 0.45, "\(busy) s of CPU")
        #expect(busy <= wall + 0.001, "\(busy) s of CPU in \(wall) s")
    }

    @Test func theStackOfABusyThreadNamesWhatItIsDoing() throws {
        let thread = LoopThread.started()
        defer { thread.stop() }
        // Looked at while it spins, for sure: from when the spin has begun to when it is
        // told to stop.
        let started = DispatchSemaphore(value: 0)
        let stop = SpinStop()
        defer { stop.set() }
        thread.perform { watchdogTestSpin(started: started, until: stop) }
        started.wait()
        let addresses = thread.probe.backtrace()
        stop.set()
        #expect(addresses.count > 5)
        let frames = StackText.frames(addresses)
        let symbols = frames.compactMap(\.symbol)
        #expect(symbols.contains { $0.contains("watchdogTestSpin") }, "\(frames.map(\.line))")
        #expect(symbols.contains { $0.contains("CFRunLoop") }, "\(frames.map(\.line))")
        // The images are named and their builds found.
        #expect(!StackText.uuids(of: frames).isEmpty)
    }

    @Test func aThreadDoesNotLookAtItsOwnStack() {
        #expect(ThreadProbe.current().backtrace().isEmpty)
    }
}

/// The watchdog on a thread of the tests', with short thresholds.
@Suite(.serialized) struct WatchdogRunTests {
    struct Line: Decodable {
        var kind: String
        var phase: String
        var seconds: Double
        var busy: Double?
        var screen: String
        var stack: [String]?
        var images: [String: String]?
    }

    /// `busyShare` is lower than the app's: a Mac building something else meanwhile does not
    /// give the test's thread a whole core.
    private func run(busyFor: Double = 1, _ body: (LoopThread, Watchdog) -> Void) throws -> [Line] {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("watchdog-run-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let thread = LoopThread.started()
        defer { thread.stop() }
        let thresholds = MainThreadWatch.Thresholds(busyShare: 0.5, busyFor: busyFor, hangFor: 0.5, stoppedAfter: 5, stillBusyFirst: 60)
        let watchdog = Watchdog(thread: thread.probe, runLoop: thread.runLoop, folder: folder, about: "tests",
                                thresholds: thresholds, interval: 0.1)
        watchdog.start()
        body(thread, watchdog)
        watchdog.stop()
        let url = folder.appendingPathComponent(Watchdog.fileName)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return try text.split(separator: "\n").map { try JSONDecoder().decode(Line.self, from: Data($0.utf8)) }
    }

    @Test func aThreadAtRestOrBusyNowAndThenWritesNothing() throws {
        let lines = try run { thread, _ in
            Thread.sleep(forTimeInterval: 0.8)
            // Short pieces of work, a third of the time.
            for _ in 0..<30 {
                thread.perform { watchdogTestSpin(0.01) }
                Thread.sleep(forTimeInterval: 0.03)
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        #expect(lines.isEmpty, "\(lines)")
    }

    @Test func aLongTurnIsAHangWithTheStackWhileItLasts() throws {
        // Not long enough for a busy stretch.
        let lines = try run(busyFor: 3) { thread, watchdog in
            watchdog.note(screen: "chat · test")
            Thread.sleep(forTimeInterval: 0.3)
            thread.perform { watchdogTestSpin(0.9) }
            Thread.sleep(forTimeInterval: 1.4)
        }
        #expect(lines.map(\.kind) == ["hang", "hang"], "\(lines)")
        guard lines.count == 2 else { return }
        #expect(lines[0].phase == "began")
        #expect(lines[0].screen == "chat · test")
        #expect(lines[0].stack?.contains { $0.contains("watchdogTestSpin") } == true, "\(lines[0].stack ?? [])")
        #expect(lines[0].images?.isEmpty == false)
        #expect(lines[1].phase == "ended")
        #expect(lines[1].seconds >= 0.85 && lines[1].seconds < 1.1)
        #expect(lines[1].stack == nil)
    }

    @Test func busyInShortTurnsIsBusyNotAHang() throws {
        let lines = try run { thread, _ in
            Thread.sleep(forTimeInterval: 0.3)
            // Each turn 20 ms, one after another, for two seconds, the way a loop of
            // SwiftUI updates keeps the main thread busy without ever stopping it.
            let end = Date().addingTimeInterval(2)
            @Sendable func next() {
                watchdogTestSpin(0.02)
                if Date() < end { thread.perform(next) }
            }
            thread.perform(next)
            // The end is seen once the last second's share has fallen, at the look after:
            // given time, as a process in the background on battery has its timer's looks
            // spaced out by the system (every 0.2 s for 0.1 s, seen 2026-10-19).
            Thread.sleep(forTimeInterval: 4.5)
        }
        #expect(lines.map(\.kind) == ["busy", "busy"], "\(lines)")
        guard lines.count == 2 else { return }
        #expect(lines[0].phase == "began")
        #expect((lines[0].busy ?? 0) >= 0.5)
        #expect(lines[0].stack?.isEmpty == false)
        #expect(lines[1].phase == "ended")
        #expect(lines[1].seconds >= 1.6 && lines[1].seconds <= 2.3, "\(lines[1])")
    }

    /// Paused (the app away from the front), it makes no look, and a turn that runs on
    /// across the pause is no hang once it looks again.
    @Test func pausedItLooksAtNothingAndTheTimeAwayIsNoHang() throws {
        var looks: [Int] = []
        let lines = try run(busyFor: 3) { thread, watchdog in
            Thread.sleep(forTimeInterval: 0.5)
            watchdog.pause()
            watchdog.pause()
            Thread.sleep(forTimeInterval: 0.1)
            looks.append(watchdog.cost().looks)
            thread.perform { watchdogTestSpin(0.9) }
            Thread.sleep(forTimeInterval: 1.2)
            looks.append(watchdog.cost().looks)
            watchdog.resume()
            watchdog.resume()
            Thread.sleep(forTimeInterval: 0.6)
            looks.append(watchdog.cost().looks)
        }
        #expect(looks[0] == looks[1], "\(looks)")
        #expect(looks[2] > looks[1], "\(looks)")
        #expect(lines.isEmpty, "\(lines)")
    }

    @Test func itsLooksCostAlmostNothing() throws {
        var cost: (looks: Int, seconds: Double, entries: Int) = (0, 0, 0)
        _ = try run { _, watchdog in
            Thread.sleep(forTimeInterval: 2)
            cost = watchdog.cost()
        }
        // About 20 at 0.1 s, fewer on battery, where the system spaces out the timer's looks.
        #expect(cost.looks >= 5)
        #expect(cost.entries == 0)
        // Under 200 µs a look, unoptimised: at one a second, 0.02% of a core.
        #expect(cost.seconds / Double(cost.looks) < 200e-6, "\(cost)")
    }
}
