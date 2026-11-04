import XCTest

/// The welcome's states for measuring the app at rest with no host (the battery hunt
/// of 2026-10-30): the welcome alone, under Add a host, and under the scanner's sheet. Each
/// state is held for `hold` seconds, quiet (no query meanwhile, as each look the
/// test takes at the app costs it main-thread time), and named in `markers.txt` in the
/// folder as it begins (`<unix time> <state>`), for a script outside to measure the app
/// then. Skipped unless the folder, `/private/tmp/portals-welcome-rest/uitest-<simulator>/`,
/// has `plan.txt`: the app's bundle id on its first line, and on a second, optionally, the
/// seconds to hold each state (130 if none). The app is a build with no host on launch:
/// a Release one built with `-DPORTALS_WELCOME_BENCH` (no simulator default host). Run as
/// the file's neighbours are:
///
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/WelcomeRestUITests
final class WelcomeRestUITests: XCTestCase {
    private let folder = "/private/tmp/portals-welcome-rest/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func mark(_ state: String) {
        let url = URL(fileURLWithPath: "\(folder)/markers.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + "\(Int(Date().timeIntervalSince1970)) \(state)\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    func testTheWelcomeAtRest() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan")
        let plan = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let hold = plan.count > 1 ? TimeInterval(plan[1]) ?? 130 : 130
        let app = XCUIApplication(bundleIdentifier: plan.first ?? "com.danielou.portals")
        app.terminate()
        app.launch()

        let scan = app.buttons["welcome-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 30), "no welcome")
        Thread.sleep(forTimeInterval: 10)
        shot("welcome")
        mark("welcome")
        Thread.sleep(forTimeInterval: hold)

        // Add a host, by hand.
        app.buttons["welcome-add-by-hand"].tap()
        XCTAssertTrue(app.buttons["host-settings-cancel"].waitForExistence(timeout: 10), "no Add a host")
        Thread.sleep(forTimeInterval: 3)
        shot("add-host")
        mark("add-host")
        Thread.sleep(forTimeInterval: hold)
        app.buttons["host-settings-cancel"].tap()
        Thread.sleep(forTimeInterval: 2)

        // The scanner, over its own sheet (a simulator has no camera: it says so).
        scan.tap()
        Thread.sleep(forTimeInterval: 4)
        shot("scan")
        mark("scan")
        Thread.sleep(forTimeInterval: hold)
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.exists { cancel.tap() }
        Thread.sleep(forTimeInterval: 1.5)
        if app.buttons["host-settings-cancel"].exists { app.buttons["host-settings-cancel"].tap() }
        Thread.sleep(forTimeInterval: 2)

        mark("end")
    }
}
