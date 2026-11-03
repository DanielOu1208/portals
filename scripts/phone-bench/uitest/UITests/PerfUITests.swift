import XCTest

/// Scrolls the chat, goes between it and the sidebar, and scrolls the sidebar, in the
/// Portals copy already running in the simulator (its bundle id in target.txt), for
/// scripts/phone-bench.sh. Writes "<unix time> <phase> start|end" to marks.txt.
final class PerfUITests: XCTestCase {
    /// Where the bench reads and writes: a folder of the simulator's own, so that benches
    /// in two simulators keep apart.
    private let folder = "/private/tmp/portals-n5/bench/perf/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func mark(_ phase: String, _ edge: String) {
        let url = URL(fileURLWithPath: "\(folder)/marks.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        let line = String(format: "%.3f %@ %@\n", Date().timeIntervalSince1970, phase, edge)
        try? (old + line).write(to: url, atomically: true, encoding: .utf8)
    }

    func testScrollAndSwitch() throws {
        continueAfterFailure = true
        let id = try String(contentsOfFile: "\(folder)/target.txt", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: id)
        app.activate()
        let sidebarButton = app.buttons["Agents and threads"]
        XCTAssertTrue(sidebarButton.waitForExistence(timeout: 20), "the chat's sidebar button")
        // Where the sidebar's button and its first two rows are, found before anything
        // is measured: asking the app where something is takes an accessibility snapshot
        // of it, which costs its main thread about a sixth of a core at two a second
        // (the `query` stretch). Within the stretches every touch is placed on
        // SpringBoard's coordinates instead, which asks SpringBoard, not the app.
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let screen = board.frame.size
        func at(_ point: CGPoint) -> XCUICoordinate {
            board.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y))
        }
        func center(_ frame: CGRect) -> CGPoint { CGPoint(x: frame.midX, y: frame.midY) }
        let button = center(sidebarButton.frame)
        sidebarButton.tap()
        let rows = app.descendants(matching: .any).matching(identifier: "thread-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5), "the sidebar's rows")
        sleep(1)
        let row = [center(rows.element(boundBy: 0).frame), center(rows.element(boundBy: 1).frame)]
        let chatEdge = CGPoint(x: screen.width * 0.95, y: screen.height * 0.5)
        at(chatEdge).tap()
        sleep(2)
        // Vertical drags: x 0.5 of the screen is the chat, 0.35 the sidebar when it is
        // out (it covers the left 82%, at most 340 points).
        func fling(_ x: CGFloat, up: Bool, _ velocity: XCUIGestureVelocity) {
            let a = at(CGPoint(x: screen.width * x, y: screen.height * (up ? 0.75 : 0.3)))
            let b = at(CGPoint(x: screen.width * x, y: screen.height * (up ? 0.3 : 0.75)))
            a.press(forDuration: 0.02, thenDragTo: b, withVelocity: velocity, thenHoldForDuration: 0)
        }

        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/chat.png"))
        // What the test's own look at the app costs, with nothing moved: 16 readings
        // of where a point of the app is, half a second apart.
        mark("query", "start")
        for _ in 0..<16 {
            _ = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).screenPoint
            usleep(500_000)
        }
        mark("query", "end")
        sleep(1)

        mark("chat", "start")
        for _ in 0..<4 { fling(0.5, up: false, .fast) }
        for _ in 0..<4 { fling(0.5, up: true, .fast) }
        for _ in 0..<4 { fling(0.5, up: false, .default) }
        for _ in 0..<4 { fling(0.5, up: true, .default) }
        mark("chat", "end")

        mark("switch", "start")
        for round in 0..<4 {
            at(button).tap()
            usleep(1_200_000)
            // Another thread, then back to the first one, on alternate rounds.
            at(row[round % 2 == 0 ? 1 : 0]).tap()
            usleep(1_200_000)
        }
        mark("switch", "end")

        at(button).tap()
        usleep(1_200_000)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/sidebar.png"))
        mark("sidebar", "start")
        for _ in 0..<3 { fling(0.35, up: true, .fast) }
        for _ in 0..<3 { fling(0.35, up: false, .fast) }
        for _ in 0..<3 { fling(0.35, up: true, .default) }
        for _ in 0..<3 { fling(0.35, up: false, .default) }
        mark("sidebar", "end")
        // Back to the first thread, as the run started.
        sleep(1)
        at(row[0]).tap()
        usleep(500_000)
    }
}
