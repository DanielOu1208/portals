import XCTest

/// `/new` in an agent's one ongoing conversation (a Hermes profile's Bot Chat) compacts it
/// in place, and puts no new thread on screen, not even for a moment (2026-10-28:
/// "it creates a new tab momentarily and when we click enter it just returns to the
/// original thread"). Against a scratch bridge whose fake agent keeps one ongoing thread.
/// Skipped unless its folder, `/private/tmp/portals-ongoing-new/uitest-<simulator>/`, has
/// `hosts.json` (`PORTALS_DEBUG_HOSTS`, one line); it writes pictures of the screen there,
/// one every tenth of a second from the Return on, and notes.txt.
final class OngoingNewUITests: XCTestCase {
    private let folder = "/private/tmp/portals-ongoing-new/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")
    private var notes: [String] = []

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: "\(folder)/hosts.json"), "no folder for the ongoing /new check")
        continueAfterFailure = true
    }

    override func tearDown() {
        try? notes.joined(separator: "\n").write(toFile: "\(folder)/notes.txt", atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    func testNewInTheOngoingThreadShowsNoNewThread() throws {
        let hosts = try String(contentsOfFile: "\(folder)/hosts.json", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        // Typed under XCTest on an iPad, "/new" came out "//newnew": the draft is put there instead.
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_OPEN_LATEST": "1", "PORTALS_DEBUG_DRAFT": "/new"]
        app.launch()

        let field = app.textFields["composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no composer")
        // The ongoing thread is on screen once its tab is.
        sleep(3)
        shot("0-before")
        shot("1-typed")
        let start = Date()
        // Return in the field is a new line under XCTest on an iPad: the send button sends.
        let send = app.buttons["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "no send button")
        send.tap()
        var sawNew = false
        for index in 0..<40 {
            let newThread = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'New thread'")).firstMatch.exists
            if newThread, !sawNew { notes.append(String(format: "New thread at %.1f s (shot %d)", Date().timeIntervalSince(start), index)) }
            sawNew = sawNew || newThread
            shot(String(format: "2-after-%02d", index))
            usleep(100_000)
        }
        notes.append(sawNew ? "A New thread showed after /new." : "No New thread showed after /new.")
        XCTAssertFalse(sawNew, "a new thread showed after /new in the ongoing thread")
    }
}
