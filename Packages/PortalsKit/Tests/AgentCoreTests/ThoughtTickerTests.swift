import Foundation
import Testing
@testable import AgentCore

/// The newest words of a thought on the status line: the thought as one line, read piece
/// by piece, and the even pace it glides in at.
@Suite struct ThoughtLineTests {
    @Test func boldMarksAndLineBreaksGoAndEachRunOfSpaceIsOne() {
        var line = ThoughtLine()
        #expect(line.read("**Finding the slow test**\n\nThe suite   takes four minutes.\n") == .added(53))
        #expect(line.text == "Finding the slow test · The suite takes four minutes.")
        #expect(line.total == line.text.count)
        // A star alone stays.
        var star = ThoughtLine()
        _ = star.read("  a * b")
        #expect(star.text == "a * b")
    }

    /// With the headline on the status line, the window under it leaves the title out
    /// (2026-10-26; `StatusHeadline`): held while it may be one, written as it came
    /// once it cannot.
    @Test func titlesCanBeLeftOut() {
        var line = ThoughtLine(dropsTitles: true)
        var thought = ""
        for piece in ["**Valid", "ating prime numbers*", "*", "\n\nI need", " to check 40.", "\n\n**Checking n = 40**\n\nIt is 41²."] {
            thought += piece
            let change = line.read(thought)
            // Nothing of the title shows while it streams in.
            if thought.count < 32 { #expect(change == .none) }
        }
        #expect(line.text == "I need to check 40. It is 41².")
        var whole = ThoughtLine(dropsTitles: true)
        _ = whole.read("**Validating prime numbers**\n\nI need to check 40.\n\n**Checking n = 40**\n\nIt is 41².")
        #expect(whole.text == "I need to check 40. It is 41².")
        #expect(whole.total == whole.text.count)
        // Not titles: bold opening prose, a bullet, two bold runs; and a title still coming shows nothing yet.
        var prose = ThoughtLine(dropsTitles: true)
        _ = prose.read("**Note:** the cache is cold\n* one\n**a** and **b**\n**Still com")
        #expect(prose.text == "Note: the cache is cold * one a and b")
        // Off, as before: the title's words and a mark where its paragraph ended.
        var kept = ThoughtLine()
        _ = kept.read("**Validating prime numbers**\n\nI need to check 40.")
        #expect(kept.text == "Validating prime numbers · I need to check 40.")
    }

    @Test func aParagraphsEndIsMarkedUnlessASentenceEndedIt() {
        var title = ThoughtLine()
        _ = title.read("Reading the tests\n\nThe suite is slow.\n\nNext I look at the helpers")
        #expect(title.text == "Reading the tests · The suite is slow. Next I look at the helpers")
        #expect(title.total == title.text.count)
        // One line break is a wrapped line, not a paragraph's end.
        var wrapped = ThoughtLine()
        _ = wrapped.read("Two of\nthe three")
        #expect(wrapped.text == "Two of the three")
    }

    @Test func piecesThatSplitACharacterNeverOvercountTheLine() {
        // Each piece ends inside a character: a consonant, then its virama, then the next
        // consonant; an emoji family split at its joiners; a letter, then its accent. The
        // line once counted each piece's characters as new and cut more than it had.
        let splits: [[String]] = [
            ["\u{915}", "\u{94D}", "\u{937} "],
            ["\u{1F468}", "\u{200D}\u{1F469}", "\u{200D}\u{1F467} "],
            ["\u{1F44B}", "\u{1F3FD} "],
            ["cafe", "\u{301} "],
        ]
        for pieces in splits {
            var line = ThoughtLine(kept: 64)
            var thought = ""
            for _ in 0..<200 {
                for piece in pieces {
                    thought += piece
                    _ = line.read(thought)
                }
            }
            #expect(line.text.count <= line.kept + line.kept / 4)
            let whole = thought.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            #expect(whole.hasSuffix(line.text))
        }
    }

    @Test func eachReadAddsOnlyWhatIsNewAndASpaceWaitsForTheNextWord() {
        var line = ThoughtLine()
        #expect(line.read("Two ") == .added(3))
        #expect(line.text == "Two")
        #expect(line.read("Two ") == .none)
        #expect(line.read("Two of\n") == .added(3))
        #expect(line.read("Two of\nthe three") == .added(10))
        #expect(line.text == "Two of the three")
        #expect(line.total == 16)
    }

    @Test func aBoldMarkSplitAcrossPiecesStillGoes() {
        var line = ThoughtLine()
        _ = line.read("**Fin")
        _ = line.read("**Finding*")
        _ = line.read("**Finding** the")
        #expect(line.text == "Finding the")
        var lone = ThoughtLine()
        _ = lone.read("a *")
        #expect(lone.text == "a")
        _ = lone.read("a *b")
        #expect(lone.text == "a *b")
    }

    @Test func aTextThatDoesNotCarryOnStartsTheLineOver() {
        var line = ThoughtLine()
        _ = line.read("abc def")
        #expect(line.read("xyz") == .startedOver)
        #expect(line.text == "xyz")
        #expect(line.total == 3)
        // Longer, but not what was read before carried on.
        #expect(line.read("xYz and more") == .startedOver)
        #expect(line.text == "xYz and more")
    }

    @Test func onlyTheEndIsKeptAndItIsTheWholeLinesEnd() {
        var line = ThoughtLine(kept: 40)
        var thought = ""
        var whole = ""
        for index in 0..<300 {
            thought += "word\(index) "
            whole += whole.isEmpty ? "word\(index)" : " word\(index)"
            _ = line.read(thought)
            #expect(line.text.count <= 50)
        }
        #expect(line.total == whole.count)
        #expect(whole.hasSuffix(line.text))
        #expect(line.text.count >= 40)
    }
}

@Suite struct ThoughtPaceTests {
    /// Where the line is every `step` from `start` to `end`.
    private func samples(_ pace: ThoughtPace, from start: TimeInterval, to end: TimeInterval, step: TimeInterval = 0.01) -> [Double] {
        stride(from: start, through: end, by: step).map { pace.shown(at: $0) }
    }

    @Test func itNeverGoesBackNorPastItsEnd() {
        var pace = ThoughtPace()
        // Pieces of all sizes at uneven times: words, bursts, a paragraph, pauses.
        var seed: UInt64 = 42
        func next(_ bound: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 33) % UInt64(bound))
        }
        var total = 0
        var now: TimeInterval = 0
        var last = 0.0
        var back = 0
        var past = 0
        for _ in 0..<300 {
            let wait = [0.05, 0.1, 0.1, 0.2, 0.45, 1.5][next(6)]
            for time in stride(from: now, to: now + wait, by: 0.005) {
                let shown = pace.shown(at: time)
                if shown < last - 1e-9 { back += 1 }
                if shown > Double(pace.target) + 1e-9 { past += 1 }
                last = shown
            }
            now += wait
            total += [3, 6, 12, 40, 70, 400, 1_500][next(7)]
            _ = pace.heard(total, at: now)
            if pace.shown(at: now) < last - 1e-9 { back += 1 }
        }
        #expect(back == 0)
        #expect(past == 0)
        #expect(pace.shown(at: now + ThoughtPace.longest) == Double(total))
    }

    @Test func aSteadyStreamMovesAtItsOwnSpeedWithoutStopping() {
        // Ten characters every tenth of a second: a hundred a second.
        var pace = ThoughtPace()
        var speeds: [Double] = []
        for index in 0..<60 {
            let now = Double(index) / 10
            _ = pace.heard(10 * (index + 1), at: now)
            guard now >= 2 else { continue }
            for time in stride(from: now, to: now + 0.1 - 1e-9, by: 0.02) {
                speeds.append((pace.shown(at: time + 0.02) - pace.shown(at: time)) / 0.02)
            }
        }
        #expect(speeds.allSatisfy { $0 > 90 && $0 < 110 })
        // About a third of a second behind.
        #expect(pace.behind(at: 5.9) < 40)
    }

    @Test func aSlowStreamOfWordsGlidesOnBetweenThem() {
        // A word of six characters every 0.44 s, as the fake agent's thoughts come.
        var pace = ThoughtPace()
        var moving: [Bool] = []
        for index in 0..<20 {
            let now = Double(index) * 0.44
            _ = pace.heard(6 * (index + 1), at: now)
            guard index >= 3 else { continue }
            for time in stride(from: now, to: now + 0.44 - 1e-9, by: 0.02) {
                moving.append(pace.shown(at: time + 0.02) > pace.shown(at: time))
            }
        }
        #expect(!moving.contains(false))
    }

    @Test func aBurstTypesInOverAFractionOfASecond() throws {
        var pace = ThoughtPace()
        _ = pace.heard(20, at: 0)
        // Seventy characters at once after a pause.
        let heard = pace.heard(90, at: 3)
        let glide = try #require(heard)
        #expect(!glide.skipped)
        #expect(glide.from == 20)
        #expect(glide.duration > 0.5 && glide.duration < 0.7)
        #expect(pace.shown(at: 3.1) < 20 + 70 * 0.3)
        #expect(pace.shown(at: 3 + glide.duration) == 90)
    }

    @Test func aParagraphAtOnceCatchesUpQuicklyButVisibly() throws {
        var pace = ThoughtPace()
        let heard = pace.heard(400, at: 0)
        let glide = try #require(heard)
        #expect(!glide.skipped)
        #expect(glide.duration >= ThoughtPace.shortest && glide.duration <= 0.6 + 1e-9)
        #expect(pace.shown(at: 0.1) < 100)
        #expect(pace.shown(at: 0.6) == 400)
    }

    @Test func aLongParagraphAtOnceSkipsToItsEnd() throws {
        var pace = ThoughtPace()
        _ = pace.heard(30, at: 0)
        let heard = pace.heard(1_530, at: 2)
        let glide = try #require(heard)
        #expect(glide.skipped)
        #expect(glide.from == 1_530 - 240)
        #expect(glide.duration <= ThoughtPace.longest)
        #expect(pace.shown(at: 2 + ThoughtPace.longest) == 1_530)
    }

    @Test func farBehindItGoesFasterAndStaysWithinBounds() {
        for perSecond in [200, 300, 600, 900] {
            var pace = ThoughtPace()
            var worst = 0.0
            var skipped = false
            for index in 0..<100 {
                let now = Double(index) / 10
                let total = perSecond / 10 * (index + 1)
                skipped = skipped || pace.heard(total, at: now)?.skipped == true
                worst = max(worst, pace.behind(at: now))
            }
            #expect(!skipped, "\(perSecond) a second")
            #expect(worst <= Double(pace.farthest), "\(perSecond) a second")
            // About a second behind at most: what it has to go, at the stream's speed.
            #expect(worst / Double(perSecond) <= ThoughtPace.longest + 0.1, "\(perSecond) a second")
        }
    }

    @Test func aWordAloneStillGlides() throws {
        var pace = ThoughtPace()
        let heard = pace.heard(5, at: 0)
        let glide = try #require(heard)
        #expect(glide.duration >= ThoughtPace.shortest)
        #expect(pace.heard(5, at: 0.1) == nil)
    }

    @Test func aNewThoughtStartsFromNothing() throws {
        var pace = ThoughtPace()
        _ = pace.heard(300, at: 0)
        // Shorter than before: another thought.
        let heard = pace.heard(12, at: 5)
        let glide = try #require(heard)
        #expect(glide.from == 0)
        #expect(pace.shown(at: 5) == 0)
        pace.reset()
        #expect(pace.target == 0)
        #expect(pace.shown(at: 6) == 0)
        let again = pace.heard(8, at: 6)
        #expect(again?.from == 0)
    }

    @Test func aSettledLineShowsWholeAndGlidesOnFromThere() throws {
        var pace = ThoughtPace()
        pace.settle(500, at: 0)
        #expect(pace.shown(at: 0) == 500)
        let heard = pace.heard(510, at: 0.2)
        let glide = try #require(heard)
        #expect(glide.from == 500)
        #expect(!glide.skipped)
    }

    @Test func withReduceMotionTheLineIsPutInPlaceAtACalmRate() {
        #expect(ThoughtPace.calmDelay(since: nil, at: 10) == 0)
        #expect(abs(ThoughtPace.calmDelay(since: 10, at: 10.4) - (ThoughtPace.calm - 0.4)) < 1e-9)
        #expect(ThoughtPace.calmDelay(since: 10, at: 10 + ThoughtPace.calm + 0.5) == 0)
    }
}
