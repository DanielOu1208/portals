import XCTest

/// Test connection and Add must both use edited fields, not the original QR link.
final class PairingFieldsUITests: XCTestCase {
    private struct Fields: Decodable {
        var address: String
        var username: String
        var password: String
    }
    private struct Fixture: Decodable {
        var link: String
        var original: Fields
        var address: String
        var username: String
        var password: String
        var members: String
    }

    private func replace(_ field: XCUIElement, old: String, with text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + text)
    }

    private func devices(_ fixture: Fixture) throws -> Int {
        let data = try Data(contentsOf: URL(fileURLWithPath: fixture.members))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let members = try XCTUnwrap(state["members"] as? [[String: Any]])
        return members.filter { $0["kind"] as? String == "device" && $0["removed"] as? Bool != true }.count
    }

    func testTestAndAddUseTheSameEditedPairingFields() throws {
        let plan = "/private/tmp/n19-pairing-fields-ui.noindex/plan.json"
        guard FileManager.default.fileExists(atPath: plan) else {
            throw XCTSkip("Start pairing-fields-bridge.mts before this simulator test.")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: plan)))
        XCTAssertEqual(try devices(fixture), 0)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_FIRST_RUN": "1", "PORTALS_DEBUG_OPEN_LINK": fixture.link]
        app.launch()
        continueAfterFailure = false
        let sheet = app.descendants(matching: .any)["host-settings-sheet"].firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 30))
        replace(app.textFields["host-address"], old: fixture.original.address, with: fixture.address)
        replace(app.textFields["host-user"], old: fixture.original.username, with: fixture.username)
        replace(app.secureTextFields["host-password"], old: fixture.original.password, with: fixture.password)
        app.secureTextFields["host-password"].typeText("\n")
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["Test connection"].tap()
        XCTAssertTrue(app.staticTexts["Connected. 0 agents."].waitForExistence(timeout: 30))
        let add = app.buttons["add-from-code"]
        for _ in 0..<3 where !add.isHittable { app.swipeDown() }
        XCTAssertTrue(add.isHittable)
        add.tap()
        let joined = NSPredicate { _, _ in (try? self.devices(fixture)) == 1 }
        expectation(for: joined, evaluatedWith: app)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
        XCTAssertEqual(try devices(fixture), 1)
    }
}
