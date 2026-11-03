import XCTest

/// Against existing-mode-bridge.mts: a warm, explicitly Full Claude thread must not
/// take another native input while its Ask permission control remains unapplied.
final class ExistingModeUITests: XCTestCase {
    private struct Fixture: Decodable {
        var hosts: String
        var cwd: String
        var audit: String
        var hold: String
    }

    private func rows(_ fixture: Fixture) throws -> [[String: Any]] {
        try String(contentsOfFile: fixture.audit, encoding: .utf8).split(separator: "\n").map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
    }

    private func waitForRows(_ fixture: Fixture, app: XCUIApplication, _ matches: @escaping ([[String: Any]]) -> Bool) {
        let condition = NSPredicate { _, _ in
            guard let rows = try? self.rows(fixture) else { return false }
            return matches(rows)
        }
        expectation(for: condition, evaluatedWith: app)
        waitForExpectations(timeout: 20)
    }

    func testExistingFullThreadWaitsForAskBeforeNativeInput() throws {
        let plan = "/private/tmp/n19-existing-mode-ui.noindex/plan.json"
        guard FileManager.default.fileExists(atPath: plan) else {
            throw XCTSkip("Start existing-mode-bridge.mts before this simulator test.")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: plan)))
        try Data().write(to: URL(fileURLWithPath: fixture.audit))
        try Data().write(to: URL(fileURLWithPath: fixture.hold))
        defer { try? FileManager.default.removeItem(atPath: fixture.hold) }
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = [
            "PORTALS_DEBUG_HOSTS": fixture.hosts, "PORTALS_DEBUG_AGENT": "claude",
            "PORTALS_DEV_CWD": fixture.cwd,
            "PORTALS_DEBUG_DRAFT": "n19-existing-full-first",
        ]
        app.launch()
        continueAfterFailure = false
        let mode = app.buttons["mode-chip"]
        XCTAssertTrue(mode.waitForExistence(timeout: 40))
        mode.tap()
        let full = app.buttons["mode-full"]
        XCTAssertTrue(full.waitForExistence(timeout: 10))
        full.tap()
        let send = app.buttons["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        waitForRows(fixture, app: app) { rows in rows.contains { $0["event"] as? String == "turn_finished" } }
        let first = try rows(fixture).filter { $0["event"] as? String == "native_input" }
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first.first?["mode"] as? String, "bypassPermissions")
        mode.tap()
        let ask = app.buttons["mode-ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        ask.tap()
        waitForRows(fixture, app: app) { rows in
            rows.contains { $0["event"] as? String == "mode_pending" && $0["mode"] as? String == "default" }
        }
        let field = app.descendants(matching: .any)["composer-field"].firstMatch
        field.tap()
        field.typeText("n19-existing-ask-second")
        send.tap()
        let overtaken = expectation(for: NSPredicate { _, _ in
            guard let rows = try? self.rows(fixture) else { return false }
            return rows.filter { $0["event"] as? String == "native_input" }.count > 1
        }, evaluatedWith: app)
        overtaken.isInverted = true
        wait(for: [overtaken], timeout: 1)
        XCTAssertFalse(try rows(fixture).contains { $0["event"] as? String == "mode_applied" && $0["mode"] as? String == "default" })
        try FileManager.default.removeItem(atPath: fixture.hold)
        waitForRows(fixture, app: app) { rows in rows.filter { $0["event"] as? String == "native_input" }.count == 2 }
        let received = try rows(fixture).filter { $0["event"] as? String == "native_input" }
        XCTAssertEqual(received.count, 2)
        XCTAssertEqual(received.last?["mode"] as? String, "default")
        XCTAssertEqual(received.last?["text"] as? String, "n19-existing-ask-second")
    }
}
