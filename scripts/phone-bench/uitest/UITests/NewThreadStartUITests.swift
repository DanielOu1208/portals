import XCTest

/// A new thread's start (`NewThreadStart`, night of 2026-10-23): the agent's avatar, the
/// question and the project in the middle of the empty chat, with no avatar in the header,
/// and once the first message is sent, the start gone and the avatar back in the header.
/// 2026-10-22: "when we open a new session we should style the what should … do
/// better so that its like centered and show the project name. and at that time the avatar
/// shouldnt be floating by itself at the top". In the Portals app installed in the simulator
/// (a build for the simulator with the launch switches), against the scripted agent.
/// Pictures of the screen go to /private/tmp/portals-n9/live/polish/ui-<simulator>/. Run as
/// the file's neighbours are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/NewThreadStartUITests
final class NewThreadStartUITests: XCTestCase {
    private let folder = "/private/tmp/portals-n9/live/polish/ui-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    override func setUpWithError() throws {
        continueAfterFailure = true
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    /// The avatar buttons that open the agent's look: the start's, or the header's.
    private func lookButtons(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Change ' AND label ENDSWITH 'look'"))
    }

    func testTheStartIsCentredAndGivesTheAvatarBackToTheHeader() throws {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_FAKE": "greeting"]
        app.launch()

        let start = app.descendants(matching: .any)["new-thread-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 30), "no new thread's start")
        Thread.sleep(forTimeInterval: 1)
        shot("start")
        let screen = app.frame
        let field = app.descendants(matching: .any)["composer-field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        // In the middle: across, and down between the top of the screen and the composer.
        XCTAssertEqual(start.frame.midX, screen.midX, accuracy: screen.width * 0.05, "not centred across")
        let middle = (screen.minY + field.frame.minY) / 2
        XCTAssertEqual(start.frame.midY, middle, accuracy: screen.height * 0.1, "not in the middle of the chat")
        // The avatar is the start's only: none in the header meanwhile.
        let found = lookButtons(app).allElementsBoundByIndex.map { "\($0.identifier) \($0.frame)" }
        XCTAssertEqual(lookButtons(app).count, 1, "an avatar in the header too: \(found)")
        XCTAssertTrue(app.buttons["new-thread-avatar"].exists, "no avatar in the start")
        XCTAssertGreaterThan(app.buttons["new-thread-avatar"].frame.minY, screen.height * 0.25, "the avatar is not down in the start")

        field.tap()
        field.typeText("Hi")
        app.buttons["send"].tap()
        XCTAssertTrue(start.waitForNonExistence(timeout: 10), "the start stayed after the first message")
        Thread.sleep(forTimeInterval: 0.6)
        shot("sent")
        // The avatar back in the header, at the top.
        let header = lookButtons(app).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5), "no avatar in the header after sending")
        XCTAssertEqual(lookButtons(app).count, 1)
        XCTAssertLessThan(header.frame.maxY, screen.height * 0.2, "the header's avatar is not at the top")
        XCTAssertTrue(header.isHittable, "the header's avatar cannot be tapped")
    }
}
