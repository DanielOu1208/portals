import Foundation
#if targetEnvironment(macCatalyst)
import UIKit
#endif

/// Measuring and checking a Mac sidebar's thread rows (`RowHover`).
/// Only a development build on a Mac reads the switches; elsewhere every call does nothing.
///
/// - `PORTALS_DEBUG_ROW_PROBE=<file>`: appends a line to the file on each of these Darwin
///   notifications (`notifyutil -p com.danielou.portals.rowprobe.<name>`):
///   `views`, the UIKit views in the app's windows, those of SwiftUI's platform views and
///   buttons and the rows' own, the thread rows laid out (in sight or about to be), and the
///   times a row's body and a Mac's space's list were worked out so far; `walk`, the row
///   under the pointer moved, as the pointer would move it, from each row of every list to
///   the next (`RowHover`), with the row and list bodies that made; `ax`, the thread rows'
///   accessibility elements, and what a click in the middle of each, and of the folders'
///   rows and buttons, lands on; `menu`, an assistive app's show-menu on a thread row
///   (`PORTALS_DEBUG_ROW_AX_INDEX`, 3 when not given), with the menu made; `dismiss`, the
///   menu closed; `press`, an assistive app's press on that row; `hits`, for every thread
///   row drawn, what a click on it lands on, asked of UIKit's own hit test of the window as
///   a click would be (the thread whose row is drawn there, another, or something else), and
///   for each list, the same down its middle from top to bottom, with each stretch where a
///   click lands on other than the row drawn there.
/// - `PORTALS_DEBUG_ROW_HOVER=<thread id>`: that thread's rows are under the pointer while
///   the pointer is not on the list, for comparing captures.
@MainActor
enum RowProbe {
    #if DEBUG && targetEnvironment(macCatalyst)
    private static let environment = ProcessInfo.processInfo.environment
    private static let file: FileHandle? = {
        guard let path = environment["PORTALS_DEBUG_ROW_PROBE"], !path.isEmpty else { return nil }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        let handle = FileHandle(forWritingAtPath: path)
        _ = handle?.seekToEndOfFile()
        return handle
    }()
    /// The thread whose rows are under the pointer, as a capture wants them.
    static let forcedHover = environment["PORTALS_DEBUG_ROW_HOVER"]
    /// Thread rows laid out now, and row bodies worked out since launch.
    private(set) static var rowsLaidOut = 0
    private(set) static var rowBodies = 0
    /// A Mac's space's list worked out again (`SpacePage`).
    private(set) static var listBodies = 0
    /// What walks the pointer over the rows (`RowHover.walk`), where there is one.
    static var walker: (@MainActor () async -> Int)?
    private static var listening = false

    static func countBody() {
        guard file != nil else { return }
        rowBodies += 1
    }

    static func countList() {
        guard file != nil else { return }
        listBodies += 1
    }

    static func laidOut(_ change: Int) {
        guard file != nil else { return }
        rowsLaidOut += change
    }

    static func isForced(_ thread: String) -> Bool {
        forcedHover == thread
    }

    static func write(_ line: String) {
        file?.write(Data((line + "\n").utf8))
    }

    static func listen() {
        guard file != nil, !listening else { return }
        listening = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.countViews() } } },
            "com.danielou.portals.rowprobe.views" as CFString, nil, .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.walk() } } },
            "com.danielou.portals.rowprobe.walk" as CFString, nil, .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.accessibility() } } },
            "com.danielou.portals.rowprobe.ax" as CFString, nil, .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.showMenu() } } },
            "com.danielou.portals.rowprobe.menu" as CFString, nil, .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.dismissMenu() } } },
            "com.danielou.portals.rowprobe.dismiss" as CFString, nil, .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.press() } } },
            "com.danielou.portals.rowprobe.press" as CFString, nil, .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center, nil,
            { _, _, _, _, _ in DispatchQueue.main.async { MainActor.assumeIsolated { RowProbe.hits() } } },
            "com.danielou.portals.rowprobe.hits" as CFString, nil, .deliverImmediately
        )
    }

    /// A row's menu was made, for this thread, with so many items.
    static func menuMade(_ title: String, items: Int) {
        write("menu-made '\(title)' items=\(items)")
    }

    private static var windows: [UIWindow] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    }

    /// Every accessibility element of the app's windows, in the order assistive apps have them.
    private static func elements() -> [NSObject] {
        var found: [NSObject] = []
        func search(_ object: NSObject, _ depth: Int) {
            guard depth < 60 else { return }
            if object.isAccessibilityElement { found.append(object) }
            var kids: [NSObject] = []
            if let elements = object.accessibilityElements as? [NSObject], !elements.isEmpty {
                kids = elements
            } else if object.accessibilityElementCount() > 0, object.accessibilityElementCount() != NSNotFound {
                kids = (0..<object.accessibilityElementCount()).compactMap { object.accessibilityElement(at: $0) as? NSObject }
            } else if let view = object as? UIView, !object.isAccessibilityElement, !view.accessibilityElementsHidden {
                kids = view.subviews
            }
            for kid in kids { search(kid, depth + 1) }
        }
        windows.forEach { search($0, 0) }
        return found
    }

    private static func identifier(of element: NSObject) -> String {
        if let identified = element as? UIAccessibilityIdentification { return identified.accessibilityIdentifier ?? "" }
        let selector = NSSelectorFromString("accessibilityIdentifier")
        guard element.responds(to: selector) else { return "" }
        return element.perform(selector)?.takeUnretainedValue() as? String ?? ""
    }

    private static var rowIndex: Int { Int(environment["PORTALS_DEBUG_ROW_AX_INDEX"] ?? "") ?? 3 }

    /// The thread rows as assistive apps have them, and where a click at each, and at each
    /// folder's row, lands.
    private static func accessibility() {
        let all = elements()
        let rows = all.filter { identifier(of: $0) == "thread-row" }
        let controls = all.filter { identifier(of: $0) == "thread-row-control" }
        write("ax elements=\(all.count) thread_rows=\(rows.count) controls_reached=\(controls.count)")
        for element in all.prefix(60) {
            write("ax element \(type(of: element)) id='\(identifier(of: element))' '\(element.accessibilityLabel ?? "")' traits=\(element.accessibilityTraits.rawValue)")
        }
        for (index, row) in rows.enumerated() {
            let frame = row.accessibilityFrame
            write("ax row \(index) '\(row.accessibilityLabel ?? "")' traits=\(row.accessibilityTraits.rawValue) actions=\(row.accessibilityCustomActions?.map(\.name) ?? []) frame=\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width))x\(Int(frame.height))")
        }
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        func landing(_ element: NSObject) -> String {
            let frame = window.convert(element.accessibilityFrame, from: nil)
            let hit = window.hitTest(CGPoint(x: frame.midX, y: frame.midY), with: nil)
            return hit.map { NSStringFromClass(type(of: $0)) } ?? "nil"
        }
        let rowHits = rows.map(landing)
        for (row, hit) in zip(rows, rowHits) where !hit.contains("RowMenuUIButton") {
            let frame = window.convert(row.accessibilityFrame, from: nil)
            write("hit off control '\(row.accessibilityLabel ?? "")' at \(Int(frame.midX)),\(Int(frame.midY)) window \(Int(window.bounds.width))x\(Int(window.bounds.height)) -> \(hit.suffix(40))")
        }
        write("hits rows=\(rows.count) on_control=\(rowHits.filter { $0.contains("RowMenuUIButton") }.count) others=\(Set(rowHits.filter { !$0.contains("RowMenuUIButton") }).sorted())")
        let others = all.filter { let id = identifier(of: $0); return id.hasPrefix("project-row") || id.hasPrefix("show-more") || id == "sidebar-archived" || id.hasPrefix("new-thread-in") || id == "recent-close" }
        let otherHits = others.map(landing)
        write("hits others=\(others.count) on_control=\(otherHits.filter { $0.contains("RowMenuUIButton") }.count) kinds=\(Set(otherHits).sorted())")
    }

    /// An assistive app's show-menu on a thread row (`PORTALS_DEBUG_ROW_AX_INDEX`, 3 when not
    /// given): what UIKit's accessibility calls for it.
    private static func showMenu() {
        let rows = elements().filter { identifier(of: $0) == "thread-row" }
        guard rowIndex < rows.count else {
            write("show-menu no row \(rowIndex) of \(rows.count)")
            return
        }
        let row = rows[rowIndex]
        let selector = NSSelectorFromString("_accessibilityShowContextMenuWithTargetPointValue:")
        write("show-menu row \(rowIndex) '\(row.accessibilityLabel ?? "")' \(type(of: row)) responds=\(row.responds(to: selector))")
        guard row.responds(to: selector) else { return }
        typealias Show = @convention(c) (AnyObject, Selector, AnyObject?) -> Bool
        let result = unsafeBitCast(row.method(for: selector), to: Show.self)(row, selector, nil)
        write("show-menu result=\(result)")
    }

    private static func dismissMenu() {
        func visit(_ view: UIView) {
            if let button = view as? RowMenuUIButton { button.contextMenuInteraction?.dismissMenu() }
            view.subviews.forEach(visit)
        }
        windows.forEach(visit)
        write("dismissed")
    }

    /// An assistive app's press on a thread row: it opens the thread.
    private static func press() {
        let rows = elements().filter { identifier(of: $0) == "thread-row" }
        guard rowIndex < rows.count else { return }
        let result = rows[rowIndex].accessibilityActivate()
        write("press row \(rowIndex) '\(rows[rowIndex].accessibilityLabel ?? "")' result=\(result)")
    }

    /// What a click lands on, for every thread row drawn and down the middle of every list:
    /// UIKit's hit test of the window, as a click's, against the rows as drawn (their
    /// accessibility elements) and as their list noted them (`RowHover`).
    private static func hits() {
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        // The thread rows as assistive apps have them, each with the part of the window its
        // list shows (its Mac's space, or the groups on top): a row scrolled out of sight
        // that SwiftUI still lists is drawn nowhere.
        var drawn: [(label: String, frame: CGRect)] = []
        var folderRows: [CGRect] = []
        func search(_ object: NSObject, _ shows: CGRect?, _ depth: Int) {
            guard depth < 60 else { return }
            let id = identifier(of: object)
            let frame = window.convert(object.accessibilityFrame, from: nil)
            var shows = shows
            if id == "sidebar-groups" || (id.hasPrefix("space-") && !id.hasPrefix("space-connection-")) { shows = frame }
            if id == "thread-row", shows.map({ $0.contains(CGPoint(x: frame.midX, y: frame.midY)) }) ?? true {
                drawn.append((object.accessibilityLabel ?? "", frame))
            }
            if id.hasPrefix("project-row-") { folderRows.append(frame) }
            if object.isAccessibilityElement { return }
            var kids: [NSObject] = []
            if let elements = object.accessibilityElements as? [NSObject], !elements.isEmpty {
                kids = elements
            } else if object.accessibilityElementCount() > 0, object.accessibilityElementCount() != NSNotFound {
                kids = (0..<object.accessibilityElementCount()).compactMap { object.accessibilityElement(at: $0) as? NSObject }
            } else if let view = object as? UIView, !view.accessibilityElementsHidden {
                kids = view.subviews
            }
            for kid in kids { search(kid, shows, depth + 1) }
        }
        search(window, nil, 0)
        /// A folder's row is there, over any thread's row under it as it is pinned: a click
        /// there is the folder's.
        func onFolderRow(_ point: CGPoint) -> Bool {
            folderRows.contains { $0.contains(point) }
        }
        var layers: [RowHoverView] = []
        func visit(_ view: UIView) {
            if let layer = view as? RowHoverView { layers.append(layer) }
            view.subviews.forEach(visit)
        }
        visit(window)
        /// What a click at a point of the window lands on: the thread a list's control would
        /// open, or the kind of view that takes it.
        func landing(_ point: CGPoint) -> (title: RowHover.Named?, view: String) {
            guard let hit = window.hitTest(point, with: nil) else { return (nil, "nil") }
            if hit is RowMenuUIButton, let layer = hit.superview as? RowHoverView {
                return (layer.hover.name(at: layer.convert(point, from: window)), "control")
            }
            return (nil, String(NSStringFromClass(type(of: hit)).suffix(40)))
        }
        let hostNames = Set(layers.flatMap { $0.hover.notedRows.map(\.name.host) })
        /// Whether a row's accessibility label is that thread's: its title, and its Mac's
        /// name where the label says one (the groups on top, of several Macs).
        func says(_ label: String, _ name: RowHover.Named?) -> Bool {
            guard let name, !name.title.isEmpty, label.hasPrefix(name.title) || label.contains(", \(name.title)") else { return false }
            return label.contains(name.host) || !hostNames.contains { label.contains($0) }
        }
        func rect(_ frame: CGRect) -> String {
            "\(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height))"
        }
        // The lists: where each is in the window, the part of it in sight, and its rows as
        // noted, in the window's terms.
        let lists = layers.map { layer in
            var seen = layer.convert(layer.bounds, to: window)
            var above = layer.superview
            while let view = above {
                if view.clipsToBounds || view is UIScrollView { seen = seen.intersection(view.convert(view.bounds, to: window)) }
                above = view.superview
            }
            let noted = layer.hover.notedRows.map { (name: $0.name, frame: layer.convert($0.frame, to: window)) }
            return (layer: layer, seen: seen.isNull || seen.height <= 0 ? nil : seen, noted: noted)
        }
        // The rows drawn in sight: each in the list that shows it and noted its thread (where
        // it noted it nearest). One drawn in sight that no list showing it noted is one a
        // click cannot open: it is kept, with no list. Only the lists that show the row are
        // asked, so a thread noted in another list too (Running or Recent, over a folder's
        // row of it) does not take the row there and drop it as out of that list's sight.
        var shown: [(label: String, frame: CGRect, list: Int?)] = []
        for row in drawn {
            let center = CGPoint(x: row.frame.midX, y: row.frame.midY)
            let owners = lists.indices.compactMap { index -> (index: Int, off: CGFloat)? in
                guard lists[index].seen?.contains(center) == true else { return nil }
                let offs = lists[index].noted.filter { says(row.label, $0.name) }.map { abs($0.frame.minY - row.frame.minY) }
                return offs.min().map { (index, $0) }
            }
            if let owner = owners.min(by: { $0.off < $1.off }) {
                shown.append((row.label, row.frame, owner.index))
            } else if lists.contains(where: { $0.seen?.contains(center) == true }) {
                shown.append((row.label, row.frame, nil))
            }
        }
        for (index, list) in lists.enumerated() {
            write("hits list \(index) frame=\(rect(list.layer.convert(list.layer.bounds, to: window))) seen=\(list.seen.map(rect) ?? "none") noted=\(list.noted.count) hidden=\(list.layer.isHidden || list.layer.window == nil)")
            guard let seen = list.seen else { continue }
            // The rows drawn in sight in it, each against where its list noted it.
            for row in shown where row.list == index || (row.list == nil && seen.contains(CGPoint(x: row.frame.midX, y: row.frame.midY))) {
                let place = list.noted.filter { says(row.label, $0.name) }.min { abs($0.frame.minY - row.frame.minY) < abs($1.frame.minY - row.frame.minY) }?.frame
                if place.map({ abs($0.minY - row.frame.minY) > 1 || abs($0.height - row.frame.height) > 1 }) ?? true {
                    write("hits list \(index) row '\(row.label.prefix(40))' drawn=\(rect(row.frame)) noted=\(place.map(rect) ?? "none")")
                }
            }
            // Down the middle of its part in sight, 2 points at a time: each stretch where a
            // click lands on other than the row drawn there.
            let x = seen.midX
            var stretch: (from: CGFloat, to: CGFloat, drawn: String, landed: String)?
            func close() {
                if let open = stretch {
                    write("hits list \(index) y=\(Int(open.from))...\(Int(open.to)) drawn '\(open.drawn.prefix(40))' landed \(open.landed.prefix(60))")
                }
                stretch = nil
            }
            var y = seen.minY + 1
            var points = 0, mismatched = 0
            while y < seen.maxY {
                if onFolderRow(CGPoint(x: x, y: y)) {
                    y += 2
                    continue
                }
                points += 1
                let row = shown.first { $0.frame.contains(CGPoint(x: x, y: y)) }
                let hit = landing(CGPoint(x: x, y: y))
                let fine = if let row { says(row.label, hit.title) } else { hit.title == nil }
                if fine {
                    close()
                } else {
                    mismatched += 1
                    let drawnName = row.map { String($0.label.prefix(40)) } ?? "-"
                    let landed = hit.title.map { "control '\($0.title.prefix(30))' \($0.host)" } ?? hit.view
                    if let open = stretch, open.drawn == drawnName, open.landed == landed {
                        stretch?.to = y
                    } else {
                        close()
                        stretch = (y, y, drawnName, landed)
                    }
                }
                y += 2
            }
            close()
            write("hits list \(index) scan points=\(points) mismatched=\(mismatched)")
        }
        // Every row drawn in sight, at a quarter, half and three quarters of its width.
        var fine = 0, other = 0, missed = 0
        var missedKinds: [String: Int] = [:]
        for row in shown {
            for share in [0.25, 0.5, 0.75] {
                let point = CGPoint(x: row.frame.minX + row.frame.width * share, y: row.frame.midY)
                guard !onFolderRow(point) else { continue }
                let hit = landing(point)
                if says(row.label, hit.title) {
                    fine += 1
                } else if let title = hit.title {
                    other += 1
                    write("hits row '\(row.label.prefix(40))' at \(Int(point.x)),\(Int(point.y)) opens '\(title.title.prefix(40))' \(title.host)")
                } else {
                    missed += 1
                    missedKinds[hit.view, default: 0] += 1
                    write("hits row '\(row.label.prefix(40))' at \(Int(point.x)),\(Int(point.y)) lands on \(hit.view)\(row.list == nil ? " (noted by no list)" : "")")
                }
            }
        }
        write("hits rows=\(shown.count) unnoted=\(shown.filter { $0.list == nil }.count) lists=\(layers.count) opens_it=\(fine) opens_another=\(other) opens_none=\(missed) on=\(missedKinds.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" })")
    }

    /// Every UIKit view of the app's windows, by kind.
    private static func countViews() {
        var total = 0, platformHosts = 0, swiftUIButtons = 0, buttonHosts = 0, rowButtons = 0, rowLayers = 0
        func visit(_ view: UIView) {
            total += 1
            let name = NSStringFromClass(type(of: view))
            if name.contains("PlatformViewHost") { platformHosts += 1 }
            if name.contains("ViewBasedUIButton") { swiftUIButtons += 1 }
            if name.contains("UIKitButtonContentHost") { buttonHosts += 1 }
            if name.contains("RowMenuUIButton") { rowButtons += 1 }
            if name.contains("RowHoverView") { rowLayers += 1 }
            view.subviews.forEach(visit)
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.windows.forEach(visit)
        }
        write("views total=\(total) platform_hosts=\(platformHosts) swiftui_buttons=\(swiftUIButtons) button_hosts=\(buttonHosts) row_buttons=\(rowButtons) row_layers=\(rowLayers) rows=\(rowsLaidOut) row_bodies=\(rowBodies) list_bodies=\(listBodies)")
    }

    private static func walk() {
        guard let walker else {
            write("walk none")
            return
        }
        let before = (rows: rowBodies, lists: listBodies)
        Task {
            let steps = await walker()
            write("walk steps=\(steps) row_bodies=\(rowBodies - before.rows) list_bodies=\(listBodies - before.lists) rows=\(rowsLaidOut)")
        }
    }
    #else
    static let forcedHover: String? = nil
    static func countBody() {}
    static func countList() {}
    static func laidOut(_ change: Int) {}
    static func isForced(_ thread: String) -> Bool { false }
    static func listen() {}
    static func menuMade(_ title: String, items: Int) {}
    static func write(_ line: String) {}
    #endif
}
