import Foundation
import Testing
@testable import AgentCore

@Suite struct WidgetRedrawsTests {
    /// What `WidgetWidening.record` answers for each width in turn.
    private func redraws(_ widths: [Double], from start: WidgetWidening = WidgetWidening()) -> [Bool] {
        var widening = start
        return widths.map { widening.record(width: $0) }
    }

    /// What `WidgetEndings.ended` answers for each time in turn.
    private func redraws(endingsAt times: [Date]) -> [Bool] {
        var endings = WidgetEndings()
        return times.map { endings.ended(at: $0) }
    }

    @Test func aPageNarrowedAndWidenedAgainIsDrawnAgain() {
        // A Chart.js chart in a Mac window narrowed and widened again: the chart cannot
        // grow back by itself.
        #expect(redraws([856, 600, 480, 856]) == [false, false, false, true])
    }

    @Test func aPageShownWiderThanItLoadedAtIsDrawnAgain() {
        // An iPad turned, a Mac window widened: never narrower than it loaded at, but a
        // chart drawn at its first width keeps it.
        #expect(redraws([700, 900]) == [false, true])
    }

    @Test func aPageOnlyNarrowedOrBarelyWidenedIsNotDrawnAgain() {
        let widths: [Double] = [856, 856, 700, 700 + WidgetHeights.widthStep - 1, 500, 0, .nan]
        #expect(redraws(widths) == Array(repeating: false, count: widths.count))
    }

    @Test func drawnAgainItStartsFromItsNewWidth() {
        var widening = WidgetWidening()
        let before = [480.0, 856].map { widening.record(width: $0) }
        #expect(before == [false, true])
        widening.reset()
        let after = [856.0, 860].map { widening.record(width: $0) }
        #expect(after == [false, false])
    }

    @Test func aPageTheUserDidSomethingOnIsNotDrawnAgainUntilItLoadsAgain() {
        // The savings calculator's sliders moved, then the Mac window widened: drawn
        // again, the sliders would go back to where they started.
        var widening = WidgetWidening()
        let before = [480.0].map { widening.record(width: $0) }
        widening.used()
        let after = [856.0, 1000].map { widening.record(width: $0) }
        #expect(before + after == [false, false, false])
        widening.reset()
        let reloaded = [480.0, 856].map { widening.record(width: $0) }
        #expect(reloaded == [false, true])
    }

    @Test func aPageWhoseProcessKeepsEndingIsGivenUpOn() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        #expect(redraws(endingsAt: [start, start + 5, start + 10, start + 15]) == [true, true, false, false])
    }

    @Test func endingsFarApartAreEachDrawnAgain() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let times = (0..<10).map { start + Double($0) * (WidgetEndings.window / 2 + 1) }
        #expect(redraws(endingsAt: times) == Array(repeating: true, count: times.count))
    }
}

@Suite struct WidgetWideningBackFromExpandedTests {
    @Test func aChartDrawnNarrowerInTheExpandedViewIsDrawnAgainBackInItsRow() {
        // An iPad: drawn in its row 648 points wide, in the sheet at 540, where Chart.js
        // draws it narrower; back in its row, it cannot grow again by itself.
        var widening = WidgetWidening()
        let first = [648.0, 540].map { widening.record(width: $0) }
        #expect(first == [false, false])
        #expect(widening.redraws(at: 648))
        // Asking takes nothing: the row's own measurement says the same.
        #expect(widening.redraws(at: 648))
        let measured = widening.record(width: 648)
        #expect(measured)
    }

    @Test func aPageNotNarrowerOrUsedIsNotDrawnAgainBackInItsRow() {
        var widening = WidgetWidening()
        #expect(widening.redraws(at: 648) == false)
        _ = widening.record(width: 648)
        // A Mac's panel, wider than the row.
        _ = widening.record(width: 900)
        #expect(widening.redraws(at: 648) == false)
        #expect(widening.redraws(at: 648 + WidgetHeights.widthStep - 1) == false)
        _ = widening.record(width: 540)
        widening.used()
        #expect(widening.redraws(at: 648) == false)
        #expect(widening.redraws(at: .nan) == false)
    }
}

@Suite struct WidgetsLeftTests {
    private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
    private let a = UUID(), b = UUID(), c = UUID()
    private let one = UUID(), two = UUID(), three = UUID()
    private let chatA = "a chat", chatB = "another chat"

    @Test func aLeftChatsPagesAreLetGoOfTwoMinutesOnNotBefore() {
        var left = WidgetsLeft<String>()
        #expect(left.nextDue == nil)
        left.shown([a, b], of: chatA, on: one)
        left.left([a, b], of: chatA, from: one, at: start)
        #expect(left.nextDue == start.addingTimeInterval(120))
        #expect(left.due(at: start.addingTimeInterval(119)).isEmpty)
        #expect(left.due(at: start.addingTimeInterval(120)) == [a, b])
        // Let go of once.
        #expect(left.due(at: start.addingTimeInterval(500)).isEmpty)
        #expect(left.nextDue == nil)
        #expect(left.isEmpty)
    }

    @Test func aChatShownAgainWithinTwoMinutesKeepsItsPages() {
        var left = WidgetsLeft<String>()
        left.shown([a, b], of: chatA, on: one)
        left.left([a, b], of: chatA, from: one, at: start)
        left.shown([a, b], of: chatA, on: two)
        #expect(left.nextDue == nil)
        #expect(left.due(at: start.addingTimeInterval(1_000)).isEmpty)
        // Left again: two minutes from then.
        left.left([a, b], of: chatA, from: two, at: start.addingTimeInterval(60))
        #expect(left.due(at: start.addingTimeInterval(170)).isEmpty)
        #expect(left.due(at: start.addingTimeInterval(180)) == [a, b])
    }

    @Test func aScreenOfTheSameChatMadeAgainKeepsItsPagesWhicheverIsToldFirst() {
        // The new screen first, then the old one leaving.
        var left = WidgetsLeft<String>()
        left.shown([a, b], of: chatA, on: one)
        left.shown([a, b], of: chatA, on: two)
        left.left([a, b], of: chatA, from: one, at: start)
        #expect(left.nextDue == nil)
        // The old one leaving first, then the new one.
        var other = WidgetsLeft<String>()
        other.shown([a, b], of: chatA, on: one)
        other.left([a, b], of: chatA, from: one, at: start)
        other.shown([a, b], of: chatA, on: two)
        #expect(other.nextDue == nil)
    }

    @Test func aTurnThatCameWhileAScreenOfTheSameChatWasMadeAgainIsKept() {
        // The new screen came with a and b; c arrived before the old one left with all three.
        var left = WidgetsLeft<String>()
        left.shown([a, b], of: chatA, on: one)
        left.shown([a, b], of: chatA, on: two)
        left.left([a, b, c], of: chatA, from: one, at: start)
        #expect(left.nextDue == nil)
        // Another chat's screen leaving is not kept by it.
        left.shown([c], of: chatB, on: three)
        left.left([c], of: chatB, from: three, at: start)
        #expect(left.due(at: start.addingTimeInterval(120)) == [c])
    }

    @Test func aChatShownAndLeftAtOnceIsLetGoOf() {
        var left = WidgetsLeft<String>()
        left.shown([a], of: chatA, on: one)
        left.left([a], of: chatA, from: one, at: start)
        left.shown([a], of: chatA, on: two)
        left.left([a], of: chatA, from: two, at: start.addingTimeInterval(1))
        #expect(left.due(at: start.addingTimeInterval(121)) == [a])
    }

    @Test func eachLeftChatHasItsOwnTwoMinutesOnOneClock() {
        var left = WidgetsLeft<String>()
        left.left([a], of: chatA, from: one, at: start)
        left.left([b], of: chatB, from: two, at: start.addingTimeInterval(30))
        // Left a second time without being shown: still due from the first.
        left.left([a], of: chatA, from: three, at: start.addingTimeInterval(45))
        #expect(left.nextDue == start.addingTimeInterval(120))
        #expect(left.due(at: start.addingTimeInterval(120)) == [a])
        #expect(left.nextDue == start.addingTimeInterval(150))
        #expect(left.due(at: start.addingTimeInterval(150)) == [b])
    }

    @Test func turnsWhosePagesWentMeanwhileAreForgotten() {
        // A memory warning let go of every page not on screen at once.
        var left = WidgetsLeft<String>()
        left.left([a, b], of: chatA, from: one, at: start)
        left.left([c], of: chatB, from: two, at: start.addingTimeInterval(10))
        left.keep(only: [c])
        #expect(left.nextDue == start.addingTimeInterval(130))
        left.keep(only: [])
        #expect(left.nextDue == nil)
    }

    @Test func theTimeKeptCanBeShortened() {
        var left = WidgetsLeft<String>(life: 5)
        left.left([a], of: chatA, from: one, at: start)
        #expect(left.due(at: start.addingTimeInterval(5)) == [a])
    }
}
