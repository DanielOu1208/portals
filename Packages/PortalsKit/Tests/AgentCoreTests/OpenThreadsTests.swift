import Foundation
import Testing
@testable import AgentCore

@Suite struct OpenThreadsTests {
    private func letGo(
        open: [String], shown: [String], busy: Set<String> = [], onScreen: String? = nil, keeping kept: Int = 2
    ) -> Set<String> {
        let all = Set(open)
        return OpenThreads.toLetGo(open: all, shown: shown, atRest: all.subtracting(busy), onScreen: onScreen, keeping: kept)
    }

    @Test func aFewThreadsAreAllKept() {
        #expect(letGo(open: ["a", "b"], shown: ["a", "b"]).isEmpty)
        #expect(OpenThreads.toLetGo(open: Set<String>(), shown: [], atRest: [], onScreen: nil).isEmpty)
    }

    /// Past the few kept, the threads at rest looked at longest ago are let go.
    @Test func theOnesLookedAtLongestAgoGo() {
        #expect(letGo(open: ["a", "b", "c", "d"], shown: ["a", "b", "c", "d"]) == ["a", "b"])
        // Looking at one again keeps it.
        #expect(letGo(open: ["a", "b", "c", "d"], shown: ["b", "c", "d", "a"]) == ["b", "c"])
    }

    /// A run, a question waiting for an answer, a message on its way or queued: such a
    /// thread is followed until it is at rest, and takes none of the places kept.
    @Test func aThreadWithSomethingUnderWayStays() {
        #expect(letGo(open: ["a", "b", "c", "d"], shown: ["a", "b", "c", "d"], busy: ["a"]) == ["b"])
        #expect(letGo(open: ["a", "b", "c"], shown: ["a", "b", "c"], busy: ["a", "b", "c"]).isEmpty)
    }

    @Test func theThreadOnScreenStays() {
        #expect(letGo(open: ["a", "b", "c", "d"], shown: ["a", "b", "c", "d"], onScreen: "a") == ["b"])
        #expect(letGo(open: ["a", "b"], shown: ["a", "b"], onScreen: "a", keeping: 0) == ["b"])
    }

    /// One held without having been shown (started elsewhere and saved here) counts as
    /// the oldest.
    @Test func oneNeverShownGoesFirst() {
        #expect(letGo(open: ["a", "b", "x"], shown: ["a", "b"]) == ["x"])
    }

    /// Open tabs are kept before the other threads at rest, the most recently shown of
    /// them first; the others take the places they leave.
    @Test func openTabsAreKeptFirst() {
        let open: Set<String> = ["a", "b", "c", "d"]
        func letGo(preferring tabs: Set<String>) -> Set<String> {
            OpenThreads.toLetGo(open: open, shown: ["a", "b", "c", "d"], atRest: open, onScreen: nil, keeping: 2, preferring: tabs)
        }
        #expect(letGo(preferring: ["a"]) == ["b", "c"])
        #expect(letGo(preferring: ["a", "b"]) == ["c", "d"])
        #expect(letGo(preferring: ["a", "b", "c"]) == ["a", "d"])
        #expect(letGo(preferring: []) == ["a", "b"])
    }
}
