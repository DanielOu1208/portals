import XCTest

/// Checks an image an agent shows in a reply (`ReplyImageView`) and the pop-up a tap on it
/// opens (`ImageLightbox`, Dana's ask of 2026-10-20), in the Portals app installed in the
/// simulator (a debug build for the simulator, `com.danielou.portals`): no caption under the
/// image; a tap opens the picture alone (no file name, path, title or Done); a tap on it, or
/// a swipe down, closes it; zoomed in, a drag moves about the picture and a tap zooms back
/// out; the keyboard goes as it opens
/// and comes back as it closes; and the chat has not moved once it is closed. Not Esc: a UI
/// test's key presses reach no key command in the simulator (the file viewer's Done, which
/// Esc presses on a Mac, stays open to one too).
///
/// Needs a scratch bridge with the fake agent only (docs: the testing notes) on
/// `127.0.0.1:9471`, user `n6`, password `n6-files-pass`, whose general folder holds
/// `stripes.png`, an image larger than the reply decodes (4000 by 2500, a box of one-pixel
/// stripes in the middle): the fake agent says back the Markdown image it is sent. Skipped
/// unless its folder, `/private/tmp/portals-answers/image-popup/uitest-<simulator>/`, is
/// there; it writes its notes and pictures of the screen there. Run with
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/ImagePopupUITests
final class ImagePopupUITests: XCTestCase {
    private let folder = "/private/tmp/portals-answers/image-popup/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private static let hosts = #"[{"name":"Scratch","url":"http://127.0.0.1:9471","user":"n6","password":"n6-files-pass"}]"#
    private static let prompt = "![relayed bubble](/private/tmp/portals-answers/image-popup/work/stripes.png)"

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: folder), "no folder for the image pop-up checks")
        continueAfterFailure = true
    }

    private func launch(_ more: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": Self.hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PUSH": "1", "PORTALS_DEBUG_PROMPT": Self.prompt]
            .merging(more) { $1 }
        app.launch()
        // The first launch on a simulator asks about notifications, over everything.
        let ask = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Don’t Allow"]
        if ask.waitForExistence(timeout: 6) { ask.tap() }
        return app
    }

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    /// The reply's image, once it is drawn and the chat has settled. Found by what VoiceOver
    /// says of it: the reply's text gives its identifier to what is in it.
    private func replyImage(in app: XCUIApplication, _ label: String = "Image: relayed bubble") -> XCUIElement {
        let images = app.buttons.matching(NSPredicate(format: "label == %@", label))
        if !images.firstMatch.waitForExistence(timeout: 40) {
            XCTFail("no image in the reply")
            note(app.debugDescription)
        }
        Thread.sleep(forTimeInterval: 2)
        return images.element(boundBy: images.count - 1)
    }

    private func lightbox(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["image-lightbox"]
    }

    /// Opened with nothing but the picture: none of the file viewer's title, path or Done.
    /// (What is under it is hidden from VoiceOver, but a UI test's view of the screen lists
    /// hidden elements all the same, the sidebar behind the chat's too: not checked here.)
    private func checkPictureAlone(_ app: XCUIApplication, _ name: String) {
        let opened = lightbox(in: app)
        XCTAssertTrue(opened.waitForExistence(timeout: 5), "\(name): no pop-up")
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertFalse(app.buttons["file-viewer-done"].exists, "\(name): the file viewer opened")
        XCTAssertFalse(app.staticTexts["stripes.png"].exists, "\(name): its file name shows")
        note("\(name): pop-up \(opened.frame) label \(opened.label)")
        XCTAssertEqual(opened.label, "Image: relayed bubble")
    }

    private func waitGone(_ element: XCUIElement, _ name: String) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 4), .completed, "\(name): still open")
    }

    /// No caption under the image; VoiceOver still names it by it.
    func testCaptionIsNotWritten() {
        let app = launch()
        let image = replyImage(in: app)
        note("reply: image \(image.frame) label \(image.label)")
        XCTAssertEqual(image.label, "Image: relayed bubble")
        XCTAssertFalse(app.staticTexts["relayed bubble"].exists, "the caption is written under it")
        shot("reply")
    }

    /// A tap opens the picture alone; a tap on it closes it; the chat stays where it was.
    func testTapOpensAndTapCloses() {
        let app = launch()
        let image = replyImage(in: app)
        let before = image.frame
        image.tap()
        checkPictureAlone(app, "tap")
        shot("open")
        lightbox(in: app).tap()
        waitGone(lightbox(in: app), "tap")
        Thread.sleep(forTimeInterval: 1.5)
        note("tap: before \(before) after \(image.frame)")
        XCTAssertEqual(image.frame.minY, before.minY, accuracy: 0.5, "the chat moved")
        shot("closed-by-tap")
    }

    /// Zoomed in it shows the file decoded whole (its stripes), and a tap zooms back out
    /// rather than closing; the next tap closes it.
    func testZoomedTapZoomsOut() {
        let app = launch()
        let image = replyImage(in: app)
        image.tap()
        checkPictureAlone(app, "zoom")
        let opened = lightbox(in: app)
        // Time for the file decoded whole to come in its place.
        Thread.sleep(forTimeInterval: 2)
        opened.doubleTap()
        Thread.sleep(forTimeInterval: 0.8)
        opened.pinch(withScale: 4, velocity: 4)
        Thread.sleep(forTimeInterval: 1)
        shot("zoomed")
        opened.tap()
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertTrue(opened.exists, "a tap zoomed in closed it")
        shot("zoomed-out")
        opened.tap()
        waitGone(opened, "zoom")
    }

    /// Zoomed in, a drag moves about the picture: sideways it scrolls (the screen is not
    /// the same once let go of, where the picture slid back before), and down it neither
    /// moves the picture away nor closes it. Fitted again, a drag sideways closes nothing.
    func testZoomedDragMovesAbout() {
        let app = launch()
        let image = replyImage(in: app)
        image.tap()
        checkPictureAlone(app, "drag")
        let opened = lightbox(in: app)
        // Time for the file decoded whole to come in its place.
        Thread.sleep(forTimeInterval: 2)
        opened.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).doubleTap()
        Thread.sleep(forTimeInterval: 1.2)
        let zoomed = XCUIScreen.main.screenshot()
        shot("drag-zoomed")
        let middle = opened.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: -150, dy: 0)), withVelocity: 200, thenHoldForDuration: 0.5)
        Thread.sleep(forTimeInterval: 1.2)
        let panned = XCUIScreen.main.screenshot()
        shot("drag-sideways")
        XCTAssertTrue(opened.exists, "a drag sideways zoomed in closed it")
        XCTAssertNotEqual(zoomed.pngRepresentation, panned.pngRepresentation, "a drag sideways zoomed in did not move about the picture")
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: 250)), withVelocity: 400, thenHoldForDuration: 0.3)
        Thread.sleep(forTimeInterval: 1.2)
        shot("drag-down-zoomed")
        XCTAssertTrue(opened.exists, "a drag down zoomed in closed it")
        note("drag: open after the drags zoomed in \(opened.exists)")
        // Back to fitted, then a drag sideways: still open.
        opened.tap()
        Thread.sleep(forTimeInterval: 1.2)
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: -150, dy: 0)), withVelocity: 300, thenHoldForDuration: 0.3)
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(opened.exists, "a drag sideways fitted closed it")
        shot("drag-fitted-sideways")
        opened.swipeDown()
        waitGone(opened, "drag")
    }

    /// A swipe down closes it; held part way, the picture is where the finger took it and
    /// the backdrop has faded (the pictures taken meanwhile from outside show it).
    func testSwipeDownCloses() {
        let app = launch()
        let image = replyImage(in: app)
        let before = image.frame
        image.tap()
        checkPictureAlone(app, "swipe")
        let opened = lightbox(in: app)
        let start = opened.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 20, dy: 240)), withVelocity: 250, thenHoldForDuration: 2)
        waitGone(opened, "swipe")
        Thread.sleep(forTimeInterval: 1.5)
        note("swipe: before \(before) after \(image.frame)")
        XCTAssertEqual(image.frame.minY, before.minY, accuracy: 0.5, "the chat moved")
        image.tap()
        XCTAssertTrue(opened.waitForExistence(timeout: 5), "no pop-up the second time")
        Thread.sleep(forTimeInterval: 0.8)
        opened.swipeDown()
        waitGone(opened, "fast swipe")
        Thread.sleep(forTimeInterval: 1.5)
        note("fast swipe: before \(before) after \(image.frame)")
        XCTAssertEqual(image.frame.minY, before.minY, accuracy: 0.5, "the chat moved")
        shot("closed-by-swipe")
    }

    /// Typing when it opens: the composer's focus goes while it is open and comes back as
    /// it closes, and the chat does not glide.
    func testFocusComesBack() {
        let app = launch(["PORTALS_DEBUG_FOCUS": "1"])
        let image = replyImage(in: app)
        let composer = app.descendants(matching: .any)["composer-field"]
        XCTAssertTrue(composer.exists, "no composer")
        let focused = { (composer.value(forKey: "hasKeyboardFocus") as? Bool) ?? false }
        XCTAssertTrue(focused(), "the composer did not have the focus to begin with")
        let before = image.frame
        shot("typing")
        image.tap()
        checkPictureAlone(app, "typing")
        shot("typing-open")
        lightbox(in: app).tap()
        waitGone(lightbox(in: app), "typing")
        Thread.sleep(forTimeInterval: 1.5)
        note("typing: focus after \(focused()) before \(before) after \(image.frame)")
        XCTAssertTrue(focused(), "the composer's focus did not come back")
        XCTAssertEqual(image.frame.minY, before.minY, accuracy: 0.5, "the chat moved")
        shot("typing-closed")
    }

    /// Scrolled up, away from the end, to an image further up the reply: closed again (by a
    /// tap and by a swipe), the chat is where it was, not glided to its end.
    func testScrolledUpStaysPut() {
        let app = launch(["PORTALS_DEBUG_PROMPT": "imagetest"])
        let chart = replyImage(in: app, "Image: Sales by month")
        XCTAssertTrue(chart.exists, "no chart")
        let tall = replyImage(in: app, "Image: A tall gradient")
        // Its top in view: the chat away from its end.
        for _ in 0..<8 where tall.frame.minY < 160 {
            let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: 160)), withVelocity: 400, thenHoldForDuration: 0.3)
            Thread.sleep(forTimeInterval: 0.8)
        }
        Thread.sleep(forTimeInterval: 1.5)
        let before = tall.frame
        shot("scrolled")
        tall.tap()
        let opened = lightbox(in: app)
        XCTAssertTrue(opened.waitForExistence(timeout: 5), "no pop-up")
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertEqual(opened.label, "Image: A tall gradient")
        shot("scrolled-open")
        opened.tap()
        waitGone(opened, "scrolled tap")
        Thread.sleep(forTimeInterval: 1.5)
        note("scrolled tap: before \(before) after \(tall.frame)")
        XCTAssertEqual(tall.frame.minY, before.minY, accuracy: 0.5, "the chat moved")
        tall.tap()
        XCTAssertTrue(opened.waitForExistence(timeout: 5), "no pop-up the second time")
        Thread.sleep(forTimeInterval: 0.8)
        opened.swipeDown()
        waitGone(opened, "scrolled swipe")
        Thread.sleep(forTimeInterval: 1.5)
        note("scrolled swipe: before \(before) after \(tall.frame)")
        XCTAssertEqual(tall.frame.minY, before.minY, accuracy: 0.5, "the chat moved")
        shot("scrolled-closed")
    }

    /// Held, it offers Copy, Save to Photos and Share, and nothing opens on its own.
    func testHoldOffersItsMenu() {
        let app = launch()
        let image = replyImage(in: app)
        image.tap()
        checkPictureAlone(app, "hold")
        let opened = lightbox(in: app)
        opened.press(forDuration: 1.2)
        let copy = app.buttons["Copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 4), "no menu")
        XCTAssertTrue(app.buttons["Save to Photos"].exists, "no Save to Photos")
        XCTAssertTrue(app.buttons["Share…"].exists, "no Share")
        Thread.sleep(forTimeInterval: 0.5)
        shot("menu")
        copy.tap()
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(opened.exists, "Copy closed it")
        opened.tap()
        waitGone(opened, "hold")
    }

    /// Turned while open, it is fitted to the screen again, and still closes with a tap: on
    /// an iPad (the app keeps an iPhone upright).
    func testTurnedStaysFitted() {
        let app = launch()
        let image = replyImage(in: app)
        image.tap()
        checkPictureAlone(app, "turned")
        shot("upright-open")
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2)
        let opened = lightbox(in: app)
        note("turned: pop-up \(opened.frame) window \(app.windows.firstMatch.frame)")
        shot("turned-open")
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 2)
        opened.tap()
        waitGone(opened, "turned")
    }

    /// Open and left alone for a while, for the app's CPU time to be read from outside
    /// (nothing should be drawn while it is still): the reply at rest for 8 s first, then
    /// the pop-up for 8 s. The moments are in the notes.
    func testHoldsStill() {
        let app = launch()
        let image = replyImage(in: app)
        note("still: closed from \(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 8)
        image.tap()
        XCTAssertTrue(lightbox(in: app).waitForExistence(timeout: 5), "no pop-up")
        Thread.sleep(forTimeInterval: 1)
        note("still: open from \(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 8)
        note("still: open until \(Date().timeIntervalSince1970)")
        lightbox(in: app).tap()
    }

    /// What a tap opens, whatever it is: for a build from before the pop-up, the viewer.
    func testWhatATapOpens() {
        let app = launch()
        let image = replyImage(in: app)
        shot("what-reply")
        image.tap()
        Thread.sleep(forTimeInterval: 2.5)
        shot("what-open")
    }
}
