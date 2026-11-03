import XCTest

/// The bars of the host settings sheet and the sessions sheet, in the sheet's own frame
/// (`PanelChrome`) since 2026-10-27, where on a Mac the window's bar cut their Cancel to
/// "C…": Cancel closes each, and the host's settings keep Save beside it. Against a scratch
/// bridge with the fake agent, which lists sessions from the desk. Skipped unless the
/// folder sheet's folder, `/private/tmp/portals-folders/uitest-<simulator>/`, has its
/// `plan.txt` (FolderSearchUITests): the bundle id, then PORTALS_DEBUG_HOSTS.
final class SheetBarUITests: XCTestCase {
    private let folder = "/private/tmp/portals-folders/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func launch(_ environment: [String: String]) throws -> XCUIApplication {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the sheets' bars")
        let lines = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n").map(String.init)
        try XCTSkipUnless(lines.count >= 2, "plan.txt needs two lines")
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = environment.merging(["PORTALS_DEBUG_HOSTS": lines[1]]) { new, _ in new }
        app.launch()
        continueAfterFailure = false
        return app
    }

    /// Taps `cancel` once the sheet holds still, and checks that the sheet `sheet` goes.
    private func cancel(_ cancel: XCUIElement, closes sheet: String, in app: XCUIApplication, name: String) {
        var frame = cancel.frame
        var still = 0
        for _ in 0 ..< 20 where still < 2 {
            Thread.sleep(forTimeInterval: 0.5)
            still = cancel.frame == frame ? still + 1 : 0
            frame = cancel.frame
        }
        shot("\(name)-open")
        cancel.tap()
        let gone = app.descendants(matching: .any)[sheet].waitForNonExistence(timeout: 10)
        if !gone { shot("\(name)-stayed") }
        XCTAssertTrue(gone, "the \(name) sheet stayed after Cancel")
    }

    func testHostSettingsHaveCancelAndSave() throws {
        let app = try launch(["PORTALS_DEBUG_HOST_SETTINGS": "1"])
        let cancel = app.buttons["host-settings-cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 30), "no Cancel in the host's settings")
        XCTAssertEqual(cancel.label, "Cancel")
        XCTAssertTrue(app.buttons["save-host"].exists, "no Save beside Cancel")
        XCTAssertEqual(app.buttons["save-host"].label, "Save")
        self.cancel(cancel, closes: "host-settings-sheet", in: app, name: "host-settings")
    }

    func testSessionsCancelClosesTheSheet() throws {
        let app = try launch(["PORTALS_DEBUG_DESK": "fake"])
        let cancel = app.buttons["desk-sheet-cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 30), "no Cancel in the sessions sheet")
        XCTAssertEqual(cancel.label, "Cancel")
        self.cancel(cancel, closes: "desk-sheet", in: app, name: "sessions")
    }
}
