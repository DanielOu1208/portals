import XCTest

/// The chat's text selected where it is (`SelectableProse`, `SelectablePlainText`), in the
/// Portals app installed in the simulator (a Debug build for the simulator, with the
/// launch switches) against the scripted agent. Notes, pictures and what was copied
/// (`PORTALS_DEBUG_COPY_LOG`) go to /private/tmp/portals-select-text/ui. Run as the
/// file's neighbours are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/SelectionUITests (an iPad)
///       or -only-testing:UITests/TouchSelectionUITests (an iPhone)
class SelectionUITestCase: XCTestCase {
    let folder = "/private/tmp/portals-select-text/ui"
    var copyLog: String { "\(folder)/copied.txt" }

    override func setUpWithError() throws {
        continueAfterFailure = true
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(atPath: copyLog)
    }

    func launch(_ script: String = "markdown", prompt: String = "Show me", more: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = more.merging([
            "PORTALS_FAKE": script, "PORTALS_DEBUG_PROMPT": prompt, "PORTALS_DEBUG_COPY_LOG": copyLog,
        ]) { $1 }
        app.launch()
        return app
    }

    func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    var copied: String { (try? String(contentsOfFile: copyLog, encoding: .utf8)) ?? "(nothing)" }

    var selectionLog: String { "\(folder)/selection.txt" }
    /// What the chat's text has selected now, as the app says (`PORTALS_DEBUG_SELECTION_LOG`).
    var selection: String { (try? String(contentsOfFile: selectionLog, encoding: .utf8)) ?? "(no log)" }

    /// Two scripted replies, a message of yours between them ("Again"), the selection logged.
    func launchTwoReplies() -> XCUIApplication {
        try? FileManager.default.removeItem(atPath: selectionLog)
        let app = launch(more: ["PORTALS_DEBUG_THEN": "Again", "PORTALS_DEBUG_SELECTION_LOG": selectionLog])
        Thread.sleep(forTimeInterval: 16)
        shot("two-replies")
        return app
    }

    /// The point on the screen at `x`, `y`.
    func at(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    /// The element whose text holds `words`: a text view, or the text of one with blocks
    /// drawn over it.
    func text(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", words, words)).firstMatch
    }

    func menuItems(_ app: XCUIApplication) -> String {
        (app.menuItems.allElementsBoundByIndex.map(\.label) + app.collectionViews.buttons.allElementsBoundByIndex.map(\.label))
            .joined(separator: ", ")
    }

    /// The menu's item of that name, a menu item or a button in the edit menu.
    func item(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.menuItems[name].exists ? app.menuItems[name] : app.collectionViews.buttons[name]
    }

    /// A point `dx`, `dy` points into `element`.
    func point(_ element: XCUIElement, _ dx: CGFloat, _ dy: CGFloat) -> XCUICoordinate {
        element.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: dx, dy: dy))
    }

    /// The middle of `element` on the screen, as a coordinate of the app: what is drawn
    /// there, whichever element the accessibility tree says is on top.
    func middle(_ app: XCUIApplication, _ element: XCUIElement) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: element.frame.midX, dy: element.frame.midY))
    }
}

/// With a pointer on an iPad simulator, the nearest stand-in for a Mac that a test can
/// drive without moving the real pointer.
final class SelectionUITests: SelectionUITestCase {
    /// A drag from the paragraph under the heading, across the lists, the code block and
    /// the table, then Copy from the right click's menu: the copy reads as the reply.
    func testDragAcrossBlocksAndCopy() {
        let app = launch()
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        note("[drag] reply frame \(reply.frame)")
        let start = point(reply, 50, 52)
        let code = text(app, "register_hook")
        let end = code.exists ? code.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 0, dy: 60)) : point(reply, 140, 400)
        start.hover()
        Thread.sleep(forTimeInterval: 0.5)
        start.click(forDuration: 0.15, thenDragTo: end)
        Thread.sleep(forTimeInterval: 1)
        shot("ipad-across-dragged")
        point(reply, 150, 52).rightClick()
        Thread.sleep(forTimeInterval: 1.5)
        shot("ipad-across-menu")
        note("[drag] menu: \(menuItems(app))")
        let copy = item(app, "Copy")
        if copy.exists { copy.tap() } else { app.typeKey(XCUIKeyboardKey.escape, modifierFlags: []) }
        Thread.sleep(forTimeInterval: 1)
        note("[drag] copied: \(copied)")
        XCTAssertTrue(copied.contains("def register(ctx):"), "the code block was not copied")
    }

    /// A double click on a word, then Copy Reply from the right click's menu.
    func testDoubleClickAndCopyReply() {
        let app = launch()
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        let word = point(reply, 60, 10)
        word.hover()
        word.doubleClick()
        Thread.sleep(forTimeInterval: 1)
        word.rightClick()
        Thread.sleep(forTimeInterval: 1.5)
        shot("ipad-word-menu")
        note("[word] menu: \(menuItems(app))")
        let reply2 = item(app, "Copy Reply")
        if reply2.exists { reply2.tap() }
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(copied.hasPrefix("## What I found"), "Copy Reply copied \(copied.prefix(40))")
    }

    /// A right click on the code block: the text's menu, the code block taken whole.
    func testRightClickOnCodeBlock() {
        let app = launch()
        let code = text(app, "register_hook")
        XCTAssertTrue(code.waitForExistence(timeout: 30), "no code block")
        Thread.sleep(forTimeInterval: 3)
        code.hover()
        code.rightClick()
        Thread.sleep(forTimeInterval: 1.5)
        shot("ipad-code-menu")
        note("[code] menu: \(menuItems(app))")
        let copy = item(app, "Copy")
        if copy.exists { copy.tap() } else { app.typeKey(XCUIKeyboardKey.escape, modifierFlags: []) }
        Thread.sleep(forTimeInterval: 1)
        note("[code] copied: \(copied)")
    }

    /// A click on a link in the text opens it (the scripted reply's, example.com, in
    /// Safari).
    func testLinkOpens() {
        let app = launch()
        let reply = text(app, "push plugin")
        _ = reply.waitForExistence(timeout: 30)
        Thread.sleep(forTimeInterval: 3)
        note("[link] reply type \(reply.elementType.rawValue) links \(app.links.count) labelled \(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'the plugin docs'")).count)")
        let lines = app.debugDescription.split(separator: "\n")
        if let at = lines.firstIndex(where: { $0.contains("TextView") }) {
            note(lines[at..<min(at + 25, lines.count)].joined(separator: "\n"))
        }
        let link = app.links["the plugin docs"]
        XCTAssertTrue(link.waitForExistence(timeout: 30), "no link")
        Thread.sleep(forTimeInterval: 4)
        link.hover()
        link.click()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let opened = safari.wait(for: .runningForeground, timeout: 10)
        note("[link] Safari in front: \(opened)")
        XCTAssertTrue(opened, "the link did not open")
        safari.terminate()
    }

    /// Scrolling with the pointer over the text scrolls the chat.
    func testScrollOverText() {
        let app = launch("math", more: ["PORTALS_DEBUG_THEN": "Again"])
        Thread.sleep(forTimeInterval: 25)
        let reply = app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS 'Prices stay text' OR label CONTAINS 'Prices stay text'")).allElementsBoundByIndex.last
        XCTAssertNotNil(reply, "no reply")
        guard let reply else { return }
        let before = reply.frame
        reply.hover()
        reply.scroll(byDeltaX: 0, deltaY: -300)
        Thread.sleep(forTimeInterval: 1.5)
        note("[scroll] frame before \(before) after \(reply.frame)")
        XCTAssertNotEqual(before.minY, reply.frame.minY, "the chat did not scroll")
    }

    /// A word selected while the reply is still being written stays selected as the
    /// rest comes in under it, and is what Copy copies.
    func testSelectionWhileStreaming() {
        let app = launch(more: ["PORTALS_FAKE_PACE": "250"])
        let reply = text(app, "What I found")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        let heading = point(reply, 30, 12)
        heading.hover()
        heading.doubleClick()
        Thread.sleep(forTimeInterval: 12)
        shot("ipad-streaming")
        XCTAssertEqual(app.state, .runningForeground, "the app went away")
        heading.rightClick()
        Thread.sleep(forTimeInterval: 1.5)
        let copy = item(app, "Copy")
        if copy.exists { copy.tap() }
        Thread.sleep(forTimeInterval: 1)
        note("[streaming] copied: \(copied)")
        XCTAssertEqual(copied, "What")
    }

    /// A key typed on the keyboard while a word is selected goes to the composer, which
    /// takes the focus.
    func testTypingGoesToTheComposer() {
        let app = launch()
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        let word = point(reply, 60, 52)
        word.hover()
        word.doubleClick()
        Thread.sleep(forTimeInterval: 1)
        app.typeKey("h", modifierFlags: [])
        app.typeKey("i", modifierFlags: [])
        Thread.sleep(forTimeInterval: 1.5)
        let composer = app.descendants(matching: .any)["composer-field"]
        note("[typing] composer value: \(String(describing: composer.value)), focused: \(composer.hasFocus)")
        shot("ipad-typed")
    }
}

extension SelectionUITests {
    /// A word selected with a double click goes with a click elsewhere: another reply,
    /// your message, the room between turns.
    func testClickElsewhereClearsSelection() {
        let app = launchTwoReplies()
        let replies = app.textViews.matching(NSPredicate(format: "value CONTAINS 'push plugin'")).allElementsBoundByIndex
        guard replies.count == 2 else {
            note("replies: \(replies.count); text views: \(app.textViews.allElementsBoundByIndex.map { String(String(describing: $0.value).prefix(30)) })")
            return XCTFail("\(replies.count) replies")
        }
        let first = replies[0].frame, second = replies[1].frame
        let again = app.textViews.matching(NSPredicate(format: "value == 'Again'")).firstMatch.frame
        let word = at(app, second.minX + 14, second.maxY - 10)
        for (name, x, y) in [("another reply", first.minX + 14, first.maxY - 10), ("your message", again.midX, again.midY), ("between turns", second.minX + 20, again.midY)] {
            for round in 1...3 {
                word.hover()
                word.doubleClick()
                Thread.sleep(forTimeInterval: 1)
                let held = selection.hasPrefix("selected")
                let target = at(app, x, y)
                target.hover()
                target.click()
                Thread.sleep(forTimeInterval: 1)
                note("[click \(name) #\(round)] selected \(held), after: \(selection.prefix(30))")
                XCTAssertTrue(held, "\(name) #\(round): the double click did not select")
                XCTAssertEqual(selection, "none", "\(name) #\(round): still selected")
            }
        }
    }
}

/// With touch on an iPhone simulator.
final class TouchSelectionUITests: SelectionUITestCase {
    /// A hold on the reply's text selects a word, with handles and the edit menu.
    func testHoldSelectsAndCopies() {
        let app = launch()
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        point(reply, 60, 60).press(forDuration: 1.0)
        Thread.sleep(forTimeInterval: 1.5)
        shot("iphone-hold")
        XCTAssertTrue(item(app, "Copy").exists, "a hold did not select")
        note("[hold] menu: \(menuItems(app))")
        let copy = item(app, "Copy")
        if copy.exists { copy.tap() }
        Thread.sleep(forTimeInterval: 1)
        note("[hold] copied: \(copied)")
        XCTAssertNotEqual(copied, "(nothing)", "nothing copied")
    }

    /// A hold on the code block takes it whole.
    func testHoldOnCodeBlock() {
        let app = launch()
        let code = text(app, "register_hook")
        XCTAssertTrue(code.waitForExistence(timeout: 30), "no code block")
        Thread.sleep(forTimeInterval: 4)
        middle(app, code).press(forDuration: 1.0)
        Thread.sleep(forTimeInterval: 1.5)
        shot("iphone-hold-code")
        note("[hold code] menu: \(menuItems(app))")
        let copy = item(app, "Copy")
        if copy.exists { copy.tap() }
        Thread.sleep(forTimeInterval: 1)
        note("[hold code] copied: \(copied)")
    }

    /// A hold on your own message, a relayed message and a tool's output selects there
    /// too, each with its menu.
    func testHoldOnMessagesAndToolOutput() {
        let relayed = "[Portals: from Codex · \"Review the bridge\" (thread 7f2e) on mbp16]\n**Done.** The login works again. I ran `npm test`:\n\n- 1,362 passed, **0 failed**\n- the fix is in `src/auth.ts`"
        for (label, script, words) in [("relayed", "greeting", "1,362 passed"), ("own", "greeting", "Thanks for the fix"), ("tool", "tools", "14 passed in")] {
            let app = launch(script, prompt: relayed, more: ["PORTALS_DEBUG_EXPAND": "1", "PORTALS_DEBUG_THEN": "Thanks for the fix"])
            Thread.sleep(forTimeInterval: script == "tools" ? 16 : 8)
            let view = app.textViews.matching(NSPredicate(format: "value CONTAINS %@", words)).firstMatch
            let element = view.waitForExistence(timeout: 10) ? view : text(app, words)
            guard element.exists else { note("[\(label)] not found"); continue }
            note("[\(label)] text view \(element.frame)")
            middle(app, element).press(forDuration: 1.0)
            Thread.sleep(forTimeInterval: 1.5)
            shot("iphone-hold-\(label)")
            note("[\(label)] menu: \(menuItems(app))")
            let copy = item(app, "Copy")
            if copy.exists { copy.tap() } else { app.tap() }
            Thread.sleep(forTimeInterval: 1)
            note("[\(label)] copied: \(copied)")
        }
    }

    /// A swipe sideways starting on the reply's text opens the sidebar.
    func testSidebarSwipeFromText() {
        let app = launch()
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        let before = reply.frame.minX
        point(reply, 20, 60).press(forDuration: 0.05, thenDragTo: point(reply, 300, 60), withVelocity: .fast, thenHoldForDuration: 0)
        Thread.sleep(forTimeInterval: 1.5)
        shot("iphone-swipe")
        // The chat slides aside by an offset its elements' frames do not show: the
        // picture says whether the sidebar is open.
        note("[swipe] see iphone-swipe.png (the chat's text at x \(before))")
    }

    /// Dragging up and down on the text scrolls the chat.
    func testScrollOverText() {
        let app = launch("math", more: ["PORTALS_DEBUG_THEN": "Again"])
        Thread.sleep(forTimeInterval: 25)
        let reply = app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS 'Prices stay text' OR label CONTAINS 'Prices stay text'")).allElementsBoundByIndex.last
        guard let reply else { return XCTFail("no reply") }
        let before = reply.frame
        // From the text in the middle of the screen, downwards: the chat scrolls back.
        let window = app.windows.firstMatch.frame
        let from = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: window.midX, dy: window.midY - 100))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: 300)), withVelocity: .default, thenHoldForDuration: 0)
        Thread.sleep(forTimeInterval: 1.5)
        note("[scroll touch] frame before \(before) after \(reply.frame)")
        XCTAssertNotEqual(before.minY, reply.frame.minY, "the chat did not scroll")
    }

    /// A tap on a link opens it.
    func testLinkTap() {
        let app = launch()
        let link = app.links["the plugin docs"]
        XCTAssertTrue(link.waitForExistence(timeout: 30), "no link")
        Thread.sleep(forTimeInterval: 4)
        link.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let opened = safari.wait(for: .runningForeground, timeout: 10)
        note("[link tap] Safari in front: \(opened)")
        XCTAssertTrue(opened, "the link did not open")
        safari.terminate()
    }

    /// A tap on the reply's words while you type leaves the keyboard up, as before the
    /// text was selected where it is; a hold there still selects (and takes the focus).
    func testTapOnTextWhileTyping() {
        let app = launch(more: ["PORTALS_DEBUG_FOCUS": "1"])
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        XCTAssertTrue(app.keyboards.firstMatch.exists, "no keyboard to begin with")
        // On the paragraph's words, not a block drawn over the text.
        point(reply, 60, 60).tap()
        Thread.sleep(forTimeInterval: 1.5)
        let stays = app.keyboards.firstMatch.exists
        note("[tap while typing] keyboard still up after a tap: \(stays)")
        shot("iphone-tap-typing")
        XCTAssertTrue(stays, "a tap on the text put the keyboard away")
        point(reply, 60, 60).press(forDuration: 1.0)
        Thread.sleep(forTimeInterval: 1.5)
        shot("iphone-tap-typing-hold")
        note("[tap while typing] then a hold: menu \(menuItems(app))")
        let copy = item(app, "Copy")
        XCTAssertTrue(copy.exists, "a hold did not select")
        if copy.exists { copy.tap() }
        Thread.sleep(forTimeInterval: 1)
        note("[tap while typing] hold copied: \(copied)")
    }


    /// Text selected with a hold goes on the first tap outside it, wherever that lands, and
    /// the edit menu with it; three times each.
    func testTapElsewhereClearsSelection() {
        let app = launchTwoReplies()
        // Up a little, so that the first reply's end, your message and the second reply's
        // start are all on the screen.
        let window0 = app.windows.firstMatch.frame
        let from = at(app, window0.midX, window0.midY - 150)
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: 330)), withVelocity: .slow, thenHoldForDuration: 0.3)
        Thread.sleep(forTimeInterval: 2)
        let replies = app.textViews.matching(NSPredicate(format: "value CONTAINS 'push plugin'")).allElementsBoundByIndex
        guard replies.count == 2 else {
            note("replies: \(replies.count); text views: \(app.textViews.allElementsBoundByIndex.map { String(String(describing: $0.value).prefix(30)) })")
            return XCTFail("\(replies.count) replies")
        }
        let first = replies[0].frame, second = replies[1].frame
        let again = app.textViews.matching(NSPredicate(format: "value == 'Again'")).firstMatch.frame
        let code = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'register_hook'")).allElementsBoundByIndex.last?.frame ?? .zero
        let cell = app.staticTexts.matching(NSPredicate(format: "label == 'test_plugin.py'")).allElementsBoundByIndex.last?.frame ?? .zero
        let window = app.windows.firstMatch.frame
        note("[clear] window \(window) first \(first) second \(second) again \(again) code \(code) cell \(cell)")
        // Held on a word of the second reply's first paragraph.
        let word = (second.minX + 60, second.minY + 60)
        let targets: [(String, CGFloat, CGFloat)] = [
            ("a same paragraph", second.minX + 250, second.minY + 60),
            ("b another paragraph", second.minX + 60, code.minY - 30),
            ("c another reply", first.minX + 14, first.maxY - 10),
            ("d your message", again.midX, again.midY),
            ("e between turns", second.minX + 20, again.midY),
            // The code block's card, its header with the language (the code itself sits low).
            ("f code block", code.midX, code.minY - 12),
        ]
        // The bar over the chat, between the sidebar's button and the title.
        let header: (String, CGFloat, CGFloat) = ("g header", window.minX + 78, window.minY + 80)
        shot("clear-0")
        for (name, x, y) in targets + [header] {
            guard name.hasPrefix("g") || (y > window.minY + 110 && y < window.maxY - 110) else { note("[clear \(name)] off screen at y \(y)"); continue }
            for round in 1...3 {
                at(app, word.0, word.1).press(forDuration: 1.0)
                Thread.sleep(forTimeInterval: 1.2)
                let held = item(app, "Copy").exists && selection.hasPrefix("selected")
                at(app, x, y).tap()
                Thread.sleep(forTimeInterval: 1.0)
                let menuGone = !item(app, "Copy").exists
                let state = selection
                note("[clear \(name) #\(round)] held \(held), menu gone \(menuGone), selection: \(state.prefix(30))")
                if round == 1 { shot("clear-\(name.prefix(1))") }
                XCTAssertTrue(held, "\(name) #\(round): the hold did not select")
                XCTAssertTrue(menuGone && state == "none", "\(name) #\(round): still selected (\(state.prefix(30)))")
                if state != "none" {
                    // Cleared by hand for the next round: a tap on the selected text's own view.
                    at(app, word.0 + 190, word.1).tap()
                    Thread.sleep(forTimeInterval: 0.8)
                }
            }
        }
    }


    /// With a word selected: a tap on a link opens it and lets go of the selection; a tap
    /// on the selection itself keeps it (the menu shows or hides, as the text does).
    func testLinkAndSelectionTaps() {
        try? FileManager.default.removeItem(atPath: selectionLog)
        let app = launch(more: ["PORTALS_DEBUG_SELECTION_LOG": selectionLog])
        let reply = text(app, "push plugin")
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        Thread.sleep(forTimeInterval: 4)
        let word = point(reply, 60, 60)
        word.press(forDuration: 1.0)
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertTrue(selection.hasPrefix("selected"), "the hold did not select")
        word.tap()
        Thread.sleep(forTimeInterval: 1.0)
        note("[on selection] after a tap on it: \(selection.prefix(30)), menu \(item(app, "Copy").exists)")
        XCTAssertTrue(selection.hasPrefix("selected"), "a tap on the selection let go of it")
        app.links["the plugin docs"].tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        let opened = safari.wait(for: .runningForeground, timeout: 10)
        note("[link with selection] Safari in front \(opened), selection: \(selection.prefix(30))")
        XCTAssertTrue(opened, "the link did not open")
        XCTAssertEqual(selection, "none", "the link's tap left the selection")
        safari.terminate()
    }

}

/// What the chat's text copies and keeps selected in set cases, checked by the app off
/// screen (`ProseChecks`, `PORTALS_DEBUG_PROSE_CHECKS`): a list item that starts with a
/// display formula, nested items, the break after a block whose next block changed kind
/// while a reply streams, a selection in a block set again. Any device.
final class ProseCheckUITests: SelectionUITestCase {
    func testProseChecks() {
        let path = "\(folder)/prose-checks.txt"
        try? FileManager.default.removeItem(atPath: path)
        _ = launch(more: ["PORTALS_DEBUG_PROSE_CHECKS": path])
        var result = ""
        for _ in 0..<60 where result.isEmpty {
            Thread.sleep(forTimeInterval: 0.5)
            result = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        }
        note("[prose checks]\n\(result)")
        XCTAssertFalse(result.isEmpty, "the app wrote no checks")
        XCTAssertFalse(result.contains("FAIL"), result)
    }
}
