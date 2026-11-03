import XCTest

/// Opt-in elapsed-clock lifecycle check against a scratch fake bridge. The plan is
/// simulator-specific, like the other phone benches. Callback measurements require
/// a temporarily instrumented app; no logger is needed in the shipping app.
final class ElapsedUITests: XCTestCase {
    private struct Plan: Decodable {
        let bundle: String
        let environment: [String: String]
        let mode: String
        let output: String
        let cycles: Int
        let mainTitle: String
        let otherTitle: String
        /// A running thread's row reads its prompt, not its title.
        let mainMatch: String?
        let startsTool: Bool?
    }

    private struct Tick {
        let wall: Double
        let source: String
        let date: Double
        let out: String
        let phase: String
    }

    private var plan: Plan!
    private var sources: Set<String> = []

    private func ticks() throws -> [Tick] {
        let body = try String(contentsOfFile: "\(plan.output)/ticks.tsv", encoding: .utf8)
        return body.split(separator: "\n").compactMap { line in
            let fields = line.split(separator: "\t").map(String.init)
            guard fields.count == 6, let wall = Double(fields[0]), let date = Double(fields[2]),
                  fields[1].hasPrefix(plan.mode == "crew" ? "subagent:" : "tool:") else { return nil }
            return Tick(wall: wall, source: fields[1], date: date, out: fields[3], phase: fields[4])
        }
    }

    private func record(_ fields: [String: Any]) throws {
        let url = URL(fileURLWithPath: "\(plan.output)/intervals.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) {
            XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: JSONSerialization.data(withJSONObject: fields))
        try handle.write(contentsOf: Data("\n".utf8))
    }

    private func capture(_ name: String, app: XCUIApplication) throws {
        try app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(plan.output)/\(name).png"))
        try app.debugDescription.write(toFile: "\(plan.output)/\(name).tree", atomically: true, encoding: .utf8)
    }

    private func interval(_ name: String, paused: Bool) throws {
        // No accessibility polling within an interval. Separate transition callbacks
        // from the stable schedule, and count distinct context dates, not body calls.
        Thread.sleep(forTimeInterval: 2)
        let begin = Date().timeIntervalSince1970
        Thread.sleep(forTimeInterval: 3)
        let end = Date().timeIntervalSince1970
        let rows = try ticks().filter { $0.wall >= begin && $0.wall < end }
        if sources.isEmpty {
            sources = Set(rows.map(\.source))
            XCTAssertEqual(sources.count, plan.mode == "crew" ? 4 : 1, "All expected elapsed sources must be visible")
        }
        XCTAssertFalse(sources.isEmpty, "No visible elapsed sources: fixture/setup failure")
        for source in sources.sorted() {
            let values = rows.filter { $0.source == source }
            let count = Set(values.map(\.date)).count
            try record(["interval": name, "begin": begin, "end": end, "source": source,
                        "callbacks": values.count, "dates": count,
                        "states": Array(Set(values.map { "\($0.out),\($0.phase)" })).sorted()])
            if paused {
                XCTAssertLessThanOrEqual(count, 1, "\(name): \(source) kept scheduling hidden dates")
            } else {
                XCTAssertGreaterThanOrEqual(count, 2, "\(name): \(source) did not resume")
                XCTAssertTrue(values.allSatisfy { $0.phase == "active" && $0.out == "false" })
            }
        }
    }

    private func resumed(since began: Double, name: String) throws {
        for source in sources {
            // A view that comes back first re-evaluates with its frozen context date;
            // that is not a tick. The contract: a fresh date promptly (SwiftUI re-queries
            // the schedule at the next render pass), and that date is now, not a
            // catch-up burst of the skipped seconds. Poll: the render pass can land
            // a beat after the gesture.
            var fresh: Tick?
            let deadline = began + 2
            while fresh == nil && Date().timeIntervalSince1970 < deadline {
                let rows = try ticks().filter { $0.source == source && $0.phase == "active" && $0.out == "false" }
                let old = Set(rows.filter { $0.wall < began }.map(\.date))
                fresh = rows.first { $0.wall >= began && !old.contains($0.date) }
                if fresh == nil { Thread.sleep(forTimeInterval: 0.2) }
            }
            XCTAssertNotNil(fresh, "\(name): no fresh tick within 2s of resume for \(source)")
            if let fresh {
                try record(["resume": name, "source": source, "wall": fresh.wall, "date": fresh.date])
                XCTAssertLessThan(abs(fresh.wall - fresh.date), 0.25, "\(name): first fresh date was stale")
            }
        }
    }

    private func select(_ title: String, app: XCUIApplication) {
        let side = app.buttons["Agents and threads"]
        side.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Missing scratch thread \(title)")
        row.tap()
    }

    func testElapsedClocksPauseAndResume() throws {
        continueAfterFailure = false
        let simulator = ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown"
        let path = "/private/tmp/n19-perf-elapsed-ui-\(simulator)/plan.json"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: path), "No isolated elapsed plan")
        plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertEqual(plan.bundle, "com.danielou.portals.n19elapsed")
        XCTAssertTrue(["crew", "tool"].contains(plan.mode))
        XCTAssertTrue(plan.output.hasPrefix("/private/tmp/n19-perf-"))
        let app = XCUIApplication(bundleIdentifier: plan.bundle)
        app.launchEnvironment = plan.environment
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["Agents and threads"].waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 7)
        if plan.startsTool == true {
            // Start after the app is ready, so the tool is genuinely younger than
            // ToolElapsed.shownFrom and its elapsed text initially has zero size.
            try Data().write(to: URL(fileURLWithPath: "\(plan.output)/start"), options: .atomic)
        }
        // A status line without anything to open intentionally removes its button
        // trait, so its identifier is more reliable than its accessibility type.
        let identifier = plan.mode == "crew" ? "foot-line" : "run-status"
        let target = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 15), "Elapsed work must actually be visible")
        try capture("visible", app: app)
        try record(["initialTargetFrame": String(describing: target.frame), "initialHittable": target.isHittable])
        try interval("visible", paused: false)

        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // A narrow phone destroys the previous chat on selection. Settings instead
        // retains this exact view and sets its inherited isOutOfSight flag.
        app.buttons["Agents and threads"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        // SwiftUI folds the footer's Settings button into its sidebar-connection
        // container on the phone; use whichever identifier survives.
        let settingsButton = app.buttons["host-settings"].exists
            ? app.buttons["host-settings"] : app.buttons["sidebar-connection"]
        XCTAssertTrue(settingsButton.waitForExistence(timeout: 5), "Sidebar Settings must exist")
        settingsButton.tap()
        XCTAssertTrue(app.buttons["settings-close"].waitForExistence(timeout: 5))
        try capture("covered", app: app)
        // Recorded observation, not a gate: RootView applies accessibilityHidden, but
        // what XCTest still sees under Settings is app behavior to note, not fix here.
        try record(["coveredTargetExistsAfterWait": !target.waitForNonExistence(timeout: 5)])
        try interval("covered", paused: true)
        app.buttons["settings-close"].tap()
        board.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        // Anchor after the return action: XCTest gestures take seconds, and the
        // contract is about how fast the schedule answers once the view is back.
        let coveredReturn = Date().timeIntervalSince1970
        try resumed(since: coveredReturn, name: "covered")
        try interval("covered-return", paused: false)

        func fling(older: Bool) {
            let start = board.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.3 : 0.75))
            let end = board.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: older ? 0.75 : 0.3))
            start.press(forDuration: 0.02, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
        }
        for cycle in 1...plan.cycles {
            for _ in 0..<4 { fling(older: true) }
            try capture("scrolled-\(cycle)", app: app)
            try interval("scrolled-\(cycle)", paused: true)
            // The foot-line ends the running turn: fling to the bottom, past it if
            // the flings land short, so every elapsed row is back in view.
            for _ in 0..<6 { fling(older: false) }
            let scrollReturn = Date().timeIntervalSince1970
            try resumed(since: scrollReturn, name: "scroll-\(cycle)")
            try interval("scroll-return-\(cycle)", paused: false)

            select(plan.otherTitle, app: app)
            try capture("unselected-\(cycle)", app: app)
            try interval("unselected-\(cycle)", paused: true)
            select(plan.mainMatch ?? plan.mainTitle, app: app)
            let tabReturn = Date().timeIntervalSince1970
            try resumed(since: tabReturn, name: "tab-\(cycle)")
            try interval("tab-return-\(cycle)", paused: false)

            XCUIDevice.shared.press(.home)
            let background = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                app.state == .runningBackground || app.state == .runningBackgroundSuspended
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [background], timeout: 5), .completed)
            try interval("background-\(cycle)", paused: true)
            app.activate()
            let sceneReturn = Date().timeIntervalSince1970
            try resumed(since: sceneReturn, name: "scene-\(cycle)")
            try interval("scene-return-\(cycle)", paused: false)
            try capture("returned-\(cycle)", app: app)
            try record(["cycle": cycle, "accessibleLabel": target.label])
        }
    }
}
