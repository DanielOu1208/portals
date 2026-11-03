import XCTest

/// Shared setup only. Concrete cases opt in through a private scratch bridge config.
class DroidParityUIHarness: XCTestCase {
    struct Configuration: Decodable {
        let bundleIdentifier: String
        let hosts: String
        let agent: String
        let live: Bool
        let cwd: String
        let secondCwd: String?
        let auditFile: String?
        let personalCommand: String?
        let maxModelName: String?
        let nonMaxModelName: String?
        let haikuModelName: String?
        let legacyKind: String?
    }

    var configuration: Configuration!

    override func setUpWithError() throws {
        continueAfterFailure = false
        let path = ProcessInfo.processInfo.environment["PORTALS_PARITY_UI_CONFIG"] ?? ""
        try XCTSkipUnless(!path.isEmpty, "no isolated Droid parity bridge configured")
        configuration = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertTrue(["com.danielou.portals.parity", "com.danielou.portals.parity.sendprobe"].contains(configuration.bundleIdentifier))
    }

    func launch(prompt: String, environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: configuration.bundleIdentifier)
        app.launchEnvironment = [
            "PORTALS_DEBUG_HOSTS": configuration.hosts,
            "PORTALS_DEBUG_AGENT": configuration.agent,
            "PORTALS_DEBUG_PROMPT": prompt,
            "PORTALS_DEV_CWD": configuration.cwd,
            "PORTALS_DEV_MODEL": configuration.live ? "claude-haiku-5-5" : "fake-1",
            "PORTALS_DEV_PROVIDER": configuration.live ? "droid" : "fake",
        ].merging(environment) { $1 }
        if configuration.bundleIdentifier == "com.danielou.portals.parity.sendprobe" {
            app.launchEnvironment["PORTALS_SEND_PROBE"] = "1"
        }
        app.launch()
        return app
    }

    func contains(_ label: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
    }

    func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func captureDetailed(_ name: String, in app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let hierarchy = app.debugDescription
        for attachment in [XCTAttachment(screenshot: screenshot), XCTAttachment(string: hierarchy)] {
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        // Independent evidence survives an xcodebuild timeout/incomplete xcresult.
        if let audit = configuration.auditFile, audit.hasPrefix("/private/tmp/portals-droid-parity-") {
            let root = URL(fileURLWithPath: audit).deletingLastPathComponent()
            let safeName = name.replacingOccurrences(of: "[^A-Za-z0-9-]", with: "-", options: .regularExpression)
            let path = root.appendingPathComponent("\(safeName)-\(UUID().uuidString)")
            do {
                try screenshot.pngRepresentation.write(to: path.appendingPathExtension("png"))
                try hierarchy.write(to: path.appendingPathExtension("txt"), atomically: true, encoding: .utf8)
                print("UI_EVIDENCE \(path.path)")
            } catch { XCTFail("Could not retain scratch UI evidence: \(error)") }
        }
    }

    func send(_ text: String, in app: XCUIApplication) {
        let field = app.textFields["composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(text)
        let send = app.buttons["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(contains(text, in: app).waitForExistence(timeout: 10), "Send did not add the user prompt to the transcript")
    }
}
