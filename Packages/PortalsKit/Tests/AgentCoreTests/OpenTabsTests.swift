import Foundation
import Testing
@testable import AgentCore

/// The threads open as tabs on this device (`OpenTabs`): opened after the others, closed
/// with the one beside it shown in place, moved, and gone to by ⌘1 to ⌘9 and ⌃Tab.
@Suite struct OpenTabsTests {
    private static let mac = HostID(rawValue: "mac")

    private static func key(_ id: String) -> ThreadKey {
        ThreadKey(host: mac, id: ThreadRef.ID(rawValue: id))
    }

    private static func tabs(_ ids: String..., selected: String? = nil) -> OpenTabs {
        OpenTabs(keys: ids.map(key), lastSelected: selected.map(key))
    }

    private static func ids(_ tabs: OpenTabs) -> [String] {
        tabs.keys.map(\.id.rawValue)
    }

    @Test func aThreadOpenedIsATabAfterTheOthersOnce() {
        var tabs = OpenTabs()
        tabs.open(Self.key("a"))
        tabs.open(Self.key("b"))
        #expect(Self.ids(tabs) == ["a", "b"])
        #expect(tabs.lastSelected == Self.key("b"))
        // Opened again, it stays where it is, and is the one on screen.
        tabs.open(Self.key("a"))
        #expect(Self.ids(tabs) == ["a", "b"])
        #expect(tabs.lastSelected == Self.key("a"))
        // Opened without showing it (a background tab), the one on screen stays.
        tabs.open(Self.key("c"), selecting: false)
        #expect(Self.ids(tabs) == ["a", "b", "c"])
        #expect(tabs.lastSelected == Self.key("a"))
    }

    @Test func closingATabShowsTheOneAfterItOrElseTheOneBefore() {
        var tabs = Self.tabs("a", "b", "c", selected: "b")
        #expect(tabs.close(Self.key("b")) == Self.key("c"))
        #expect(tabs.lastSelected == Self.key("c"))
        // The last one: the one before it.
        #expect(tabs.close(Self.key("c")) == Self.key("a"))
        #expect(tabs.lastSelected == Self.key("a"))
        // The only one: none, and the new-thread screen is shown.
        #expect(tabs.close(Self.key("a")) == nil)
        #expect(tabs.isEmpty)
        #expect(tabs.lastSelected == nil)
        // No tab: nothing changes.
        #expect(tabs.close(Self.key("x")) == nil)
    }

    @Test func closingATabNotOnScreenLeavesTheOneOnScreen() {
        var tabs = Self.tabs("a", "b", "c", selected: "a")
        #expect(tabs.close(Self.key("b")) == Self.key("c"))
        #expect(tabs.lastSelected == Self.key("a"))
        #expect(Self.ids(tabs) == ["a", "c"])
    }

    /// Where a tab that cannot be shown gives way to the next: after it, then before it,
    /// nearest first each way, the first being the one `close` gives.
    @Test func theTabsInPlaceOfOneAreNearestFirst() {
        var tabs = Self.tabs("a", "b", "c", "d", "e", selected: "c")
        #expect(tabs.inPlace(of: Self.key("c")).map(\.id.rawValue) == ["d", "e", "b", "a"])
        #expect(tabs.inPlace(of: Self.key("e")).map(\.id.rawValue) == ["d", "c", "b", "a"])
        #expect(tabs.inPlace(of: Self.key("x")).isEmpty)
        let first = tabs.inPlace(of: Self.key("c")).first
        #expect(tabs.close(Self.key("c")) == first)
    }

    @Test func aTabMovesToAPlaceOrBeforeAnother() {
        var tabs = Self.tabs("a", "b", "c", "d")
        tabs.move(Self.key("a"), to: 2)
        #expect(Self.ids(tabs) == ["b", "c", "a", "d"])
        tabs.move(Self.key("d"), to: 0)
        #expect(Self.ids(tabs) == ["d", "b", "c", "a"])
        // Past the end, at the end; before the start, at the start.
        tabs.move(Self.key("d"), to: 99)
        #expect(Self.ids(tabs) == ["b", "c", "a", "d"])
        tabs.move(Self.key("a"), to: -3)
        #expect(Self.ids(tabs) == ["a", "b", "c", "d"])

        tabs.move(Self.key("d"), before: Self.key("b"))
        #expect(Self.ids(tabs) == ["a", "d", "b", "c"])
        tabs.move(Self.key("a"), before: Self.key("c"))
        #expect(Self.ids(tabs) == ["d", "b", "a", "c"])
        // No target, or one that is no tab: at the end.
        tabs.move(Self.key("d"), before: nil)
        #expect(Self.ids(tabs) == ["b", "a", "c", "d"])
        tabs.move(Self.key("b"), before: Self.key("x"))
        #expect(Self.ids(tabs) == ["a", "c", "d", "b"])
        // Before itself, or a thread that is no tab: nothing moves.
        tabs.move(Self.key("a"), before: Self.key("a"))
        tabs.move(Self.key("x"), to: 0)
        #expect(Self.ids(tabs) == ["a", "c", "d", "b"])
    }

    /// ⌘1 to ⌘8 go to that tab, ⌘9 to the last, however many there are.
    @Test func theNinthIsTheLast() {
        let few = Self.tabs("a", "b", "c")
        #expect(few.key(at: 0) == Self.key("a"))
        #expect(few.key(at: 2) == Self.key("c"))
        #expect(few.key(at: 3) == nil)
        #expect(few.key(at: 8) == Self.key("c"))
        #expect(few.key(at: -1) == nil)
        let many = OpenTabs(keys: (0..<12).map { Self.key("t\($0)") })
        #expect(many.key(at: 7) == Self.key("t7"))
        #expect(many.key(at: 8) == Self.key("t11"))
        #expect(OpenTabs().key(at: 8) == nil)
    }

    /// What each tab shows while ⌘ is held: the key that goes to it, if one does.
    @Test func eachTabKnowsItsKey() {
        let few = Self.tabs("a", "b", "c")
        #expect(few.shortcut(of: Self.key("a")) == 1)
        #expect(few.shortcut(of: Self.key("c")) == 3)
        #expect(few.shortcut(of: Self.key("x")) == nil)
        let many = OpenTabs(keys: (0..<12).map { Self.key("t\($0)") })
        #expect(many.shortcut(of: Self.key("t7")) == 8)
        #expect(many.shortcut(of: Self.key("t8")) == nil)
        #expect(many.shortcut(of: Self.key("t11")) == 9)
        for number in 1...9 {
            #expect(many.key(at: number - 1).flatMap(many.shortcut(of:)) == number)
        }
    }

    @Test func cyclingGoesRoundFromOneEndToTheOther() {
        let tabs = Self.tabs("a", "b", "c")
        #expect(tabs.cycled(from: Self.key("a"), by: 1) == Self.key("b"))
        #expect(tabs.cycled(from: Self.key("c"), by: 1) == Self.key("a"))
        #expect(tabs.cycled(from: Self.key("a"), by: -1) == Self.key("c"))
        #expect(tabs.cycled(from: Self.key("b"), by: -4) == Self.key("a"))
        // From no tab: the first.
        #expect(tabs.cycled(from: nil, by: 1) == Self.key("a"))
        #expect(tabs.cycled(from: Self.key("x"), by: -1) == Self.key("a"))
        #expect(OpenTabs().cycled(from: nil, by: 1) == nil)
    }

    @Test func tabsWhoseThreadIsGoneAreClosed() {
        var tabs = Self.tabs("a", "b", "c", selected: "b")
        tabs.remove { $0.id.rawValue == "a" }
        #expect(Self.ids(tabs) == ["b", "c"])
        #expect(tabs.lastSelected == Self.key("b"))
        tabs.remove { $0.id.rawValue == "b" }
        #expect(Self.ids(tabs) == ["c"])
        #expect(tabs.lastSelected == nil)
    }

    /// A tab opened from the foot of its starter's chat is marked, for the back button,
    /// until it is closed or its thread is gone; a key that is no tab is not marked.
    @Test func aTabOpenedFromItsStartersFootIsMarkedUntilClosed() throws {
        var tabs = Self.tabs("a", "b", "c", selected: "c")
        tabs.markOpenedFromStarter(Self.key("c"))
        tabs.markOpenedFromStarter(Self.key("x"))
        #expect(tabs.wasOpenedFromStarter(Self.key("c")))
        #expect(!tabs.wasOpenedFromStarter(Self.key("a")))
        #expect(!tabs.wasOpenedFromStarter(Self.key("x")))
        // Shown again from a tab or the sidebar, it keeps its mark.
        tabs.open(Self.key("c"))
        #expect(tabs.wasOpenedFromStarter(Self.key("c")))
        // Kept between launches; one saved before the mark existed reads with none.
        let data = try JSONEncoder().encode(tabs)
        #expect(try JSONDecoder().decode(OpenTabs.self, from: data).wasOpenedFromStarter(Self.key("c")))
        let before = #"{"keys":[{"host":"mac","id":"c"}],"lastSelected":{"host":"mac","id":"c"}}"#
        #expect(!(try JSONDecoder().decode(OpenTabs.self, from: Data(before.utf8))).wasOpenedFromStarter(Self.key("c")))
        // Closed, and opened again from elsewhere, it has no mark.
        tabs.close(Self.key("c"))
        tabs.open(Self.key("c"))
        #expect(!tabs.wasOpenedFromStarter(Self.key("c")))
        tabs.markOpenedFromStarter(Self.key("b"))
        tabs.remove { $0.id.rawValue == "b" }
        tabs.open(Self.key("b"))
        #expect(!tabs.wasOpenedFromStarter(Self.key("b")))
    }

    /// Kept as JSON on the device, and a list with a tab twice or a selection that is no
    /// tab reads as one with each tab once and no selection.
    @Test func savedAndReadBack() throws {
        let tabs = Self.tabs("a", "b", selected: "b")
        let data = try JSONEncoder().encode(tabs)
        #expect(try JSONDecoder().decode(OpenTabs.self, from: data) == tabs)

        let odd = OpenTabs(keys: [Self.key("a"), Self.key("b"), Self.key("a")], lastSelected: Self.key("x"))
        #expect(Self.ids(odd) == ["a", "b"])
        #expect(odd.lastSelected == nil)
        let written = #"{"keys":[{"host":"mac","id":"a"},{"host":"mac","id":"a"}],"lastSelected":{"host":"mac","id":"z"}}"#
        let read = try JSONDecoder().decode(OpenTabs.self, from: Data(written.utf8))
        #expect(Self.ids(read) == ["a"])
        #expect(read.lastSelected == nil)
        #expect(try JSONDecoder().decode(OpenTabs.self, from: Data("{}".utf8)) == OpenTabs())
    }
}
