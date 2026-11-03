import XCTest

/// Against initial-mode-failure-bridge.mts. The explicit pre-application RPC fault
/// must retain the message; manual retry must reach native Codex with Ask policies.
final class InitialModeFailureUITests: XCTestCase {
    private struct Fixture: Decodable {
        var hosts: String
        var cwd: String
        var audit: String
        var failure: String
    }

    private func rows(_ fixture: Fixture) throws -> [[String: Any]] {
        try String(contentsOfFile: fixture.audit, encoding: .utf8)
            .split(separator: "\n").map {
                try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
    }

    func testFailedAskNeverSendsAndManualRetryAppliesAsk() throws {
        let path = "/private/tmp/n19-app-mode-failure-ui.json"
        guard FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("Start initial-mode-failure-bridge.mts before this simulator test.")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        try Data().write(to: URL(fileURLWithPath: fixture.audit))
        try Data().write(to: URL(fileURLWithPath: fixture.failure))
        defer { try? FileManager.default.removeItem(atPath: fixture.failure) }
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = [
            "PORTALS_DEBUG_HOSTS": fixture.hosts, "PORTALS_DEBUG_AGENT": "codex",
            "PORTALS_DEV_CWD": fixture.cwd, "PORTALS_DEBUG_MODE_PICKER": "1",
            "PORTALS_DEBUG_DRAFT": "n19-failed-ask-probe",
        ]
        app.launch()
        continueAfterFailure = false
        let ask = app.buttons["mode-ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 40))
        ask.tap()
        let send = app.buttons["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        let retry = app.buttons["Try again"].firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout: 20), "the failed message was not retained for manual retry")
        let failed = try rows(fixture)
        XCTAssertTrue(failed.contains { $0["event"] as? String == "mode_requested" && $0["failed"] as? Bool == true })
        XCTAssertFalse(failed.contains { ["send_requested", "native_turn"].contains($0["event"] as? String ?? "") },
                       "a failed Ask request still started a native turn")
        try FileManager.default.removeItem(atPath: fixture.failure)
        retry.tap()
        let nativeAsk = NSPredicate { _, _ in
            guard let rows = try? self.rows(fixture) else { return false }
            return rows.contains {
                $0["event"] as? String == "native_turn" && $0["approval"] as? String == "untrusted"
                    && ($0["sandbox"] as? [String: Any])?["type"] as? String == "workspaceWrite"
            }
        }
        expectation(for: nativeAsk, evaluatedWith: app)
        waitForExpectations(timeout: 20)
        let sent = try rows(fixture).filter { $0["event"] as? String == "send_requested" }
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["mode"] as? String, "ask")
        XCTAssertEqual(sent.first?["text"] as? String, "n19-failed-ask-probe")
    }
}
