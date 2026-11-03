import AgentCore
import Foundation
import MetricKit
import UIKit
import Watchdog

/// The app's watchdog on its main thread (`Watchdog`): started as the app is, on iPhone,
/// iPad and Mac, in every build. It writes `Diagnostics/watchdog.jsonl` in the app's data
/// folder (`Application Support/AeriPortal`) when the main thread is busy for 10 s or more
/// (80% of a core) or stuck on one turn of its run loop for 2 s or more, and keeps the
/// system's own reports of CPU use and hangs (MetricKit) in `Diagnostics/MetricKit`.
/// Read them from a phone with
///
///     xcrun devicectl device copy from --device <id> --domain-type appDataContainer \
///         --domain-identifier com.danielou.portals \
///         --source "Library/Application Support/AeriPortal/Diagnostics" --destination <folder>
///
/// and on a Mac in `~/Library/Containers/com.danielou.portals/Data/Library/Application Support/AeriPortal/Diagnostics`.
///
/// On an iPhone or iPad it looks only while the app is active, in front: away from it
/// (inactive, in the background) its look a second woke the app for nothing anyone waits
/// on. A Mac's app is inactive whenever another app is in front, its window in view and
/// working: there it always looks.
enum AppWatchdog {
    /// `Application Support/AeriPortal/Diagnostics`, beside the threads.
    static var folder: URL {
        ThreadStore.standard.directory.appendingPathComponent("Diagnostics", isDirectory: true)
    }

    static func start() {
        guard !DebugLaunch.leavesOutWatchdog else { return }
        let watchdog = Watchdog.start(folder: folder, about: about)
        if !Platform.isMac { followTheFront(watchdog) }
        MetricReports.shared.start(in: folder.appendingPathComponent("MetricKit", isDirectory: true))
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if let path = DebugLaunch.watchdogCostPath { writeCost(of: watchdog, to: path) }
        if let busy = DebugLaunch.busyMainThread { makeBusy(busy) }
        #endif
    }

    /// Pauses `watchdog` as the app leaves the front and has it look again as it is back.
    /// It starts looking at launch, before the app is first active, for a launch that hangs.
    private static func followTheFront(_ watchdog: Watchdog) {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { _ in watchdog.pause() },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { _ in watchdog.resume() },
        ]
    }

    private nonisolated(unsafe) static var observers: [any NSObjectProtocol] = []

    /// What is on screen, for the entries written from now on: cheap, and never waits.
    static func note(screen: String) {
        Watchdog.shared?.note(screen: screen)
    }

    /// `Portals 1.0 (12) · iOS 27.0.1 · iPhone18,2`.
    private static var about: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let system = Platform.isMac ? "Mac Catalyst" : UIDevice.current.systemName
        return "Portals \(version) (\(build)) · \(system) \(UIDevice.current.systemVersion) · \(machine)"
    }

    /// The model's identifier: `iPhone18,2`, `iPad16,5`, `Mac16,7`; `arm64` in a simulator.
    private static var machine: String {
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    /// Writes what the watchdog has cost so far every ten seconds, for measuring it. Off
    /// the main actor: its timer fires on a queue of its own.
    private nonisolated static func writeCost(of watchdog: Watchdog, to path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let file = FileHandle(forWritingAtPath: path) else { return }
        let started = Date()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 10, repeating: 10)
        timer.setEventHandler {
            let cost = watchdog.cost()
            let line = String(format: "%.0f %d %.6f %d\n", Date().timeIntervalSince(started), cost.looks, cost.seconds, cost.entries)
            file.write(Data(line.utf8))
        }
        timer.resume()
        costTimer = timer
    }

    private nonisolated(unsafe) static var costTimer: DispatchSourceTimer?

    /// Keeps the main thread busy as a debug switch asks (`PORTALS_DEBUG_BUSY`), starting
    /// five seconds after launch: in turns of 30 ms one after another, as a loop of
    /// SwiftUI updates would, or in one turn, a hang.
    private static func makeBusy(_ busy: DebugLaunch.Busy) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            AppLog.chat.notice("Debug: main thread busy (\(busy.hangs ? "one turn" : "short turns", privacy: .public)) for \(busy.seconds) s")
            if busy.hangs {
                spin(for: busy.seconds)
            } else {
                spinInTurns(until: Date().addingTimeInterval(busy.seconds))
            }
        }
    }

    private static func spinInTurns(until end: Date) {
        spin(for: 0.03)
        guard Date() < end else { return }
        DispatchQueue.main.async { spinInTurns(until: end) }
    }

    @inline(never)
    private static func spin(for seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        var x = 0.0
        while Date() < end {
            for i in 0..<1000 { x += sin(Double(i)) }
        }
        if x == .infinity { print(x) }
    }
    #endif
}

/// Keeps what MetricKit delivers, at most once a day: the diagnostics (CPU use over the
/// system's limit, hangs, crashes, disk writes) and the day's metrics (CPU time, hang
/// times), each payload as it came, a JSON file named by the day it covers. The newest
/// 30, at most 8 MB together.
nonisolated final class MetricReports: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = MetricReports()

    private let queue = DispatchQueue(label: "com.danielou.portals.metrickit", qos: .utility)
    private var folder: URL?

    func start(in folder: URL) {
        queue.async { [self] in
            self.folder = folder
            // Delivered before this launch subscribed: kept if not already.
            save(MXMetricManager.shared.pastDiagnosticPayloads.map { ($0.timeStampEnd, Self.name(of: $0), $0.jsonRepresentation()) })
            DispatchQueue.main.async { MXMetricManager.shared.add(self) }
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let reports = payloads.map { ($0.timeStampEnd, Self.name(of: $0), $0.jsonRepresentation()) }
        queue.async { [self] in save(reports) }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        let reports = payloads.map { ($0.timeStampEnd, "metrics", $0.jsonRepresentation()) }
        queue.async { [self] in save(reports) }
    }

    /// What a diagnostics payload holds: `diagnostics-cpu1-hang2`.
    private static func name(of payload: MXDiagnosticPayload) -> String {
        var name = "diagnostics"
        for (kind, count) in [("cpu", payload.cpuExceptionDiagnostics?.count), ("hang", payload.hangDiagnostics?.count),
                              ("crash", payload.crashDiagnostics?.count), ("disk", payload.diskWriteExceptionDiagnostics?.count)] {
            if let count, count > 0 { name += "-\(kind)\(count)" }
        }
        return name
    }

    private func save(_ reports: [(end: Date, kind: String, json: Data)]) {
        guard let folder, !reports.isEmpty else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let day = Date.ISO8601FormatStyle(timeSeparator: .omitted, timeZone: .current)
        var saved = 0
        for report in reports {
            let url = folder.appendingPathComponent("\(day.format(report.end))-\(report.kind).json")
            guard !FileManager.default.fileExists(atPath: url.path) else { continue }
            if (try? report.json.write(to: url, options: .atomic)) != nil { saved += 1 }
        }
        guard saved > 0 else { return }
        ReportFolder.prune(folder, keeping: 30, within: 8 * 1024 * 1024)
        Watchdog.logger.notice("MetricKit: kept \(saved) report(s): \(reports.map(\.kind).joined(separator: ", "), privacy: .public)")
    }
}
