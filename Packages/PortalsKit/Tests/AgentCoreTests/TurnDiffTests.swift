import Foundation
import Testing
@testable import AgentCore

/// What a turn changed (`Turn.diff`): kept with the turn that ended, and by a copy whose
/// host no longer says it.
@Suite struct TurnDiffTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let changed = TurnDiff(files: [
        TurnDiff.File(path: "src/app.ts", added: 3, removed: 2, diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n"),
        TurnDiff.File(path: "notes.md", status: .added, added: 2),
    ])

    private func ended(diff: TurnDiff? = nil) -> Turn {
        Turn(startedAt: t0, endedAt: t0.addingTimeInterval(9), outcome: .completed, items: [TurnItem(.user(UserMessage(text: "Go.", sentAt: t0))), TurnItem(.text("Done."))], diff: diff)
    }

    /// A turn's diff says what it always said; a repository's, where a file can be left out
    /// for a reason that is not its length, says nothing of length or a turn.
    @Test func whatIsMissingIsSaidAsTheDiffsOriginSaysIt() {
        let turn = TurnDiff.Origin.turn
        #expect(turn.leftOutLine == "Too long to keep: the turn's diffs passed what is kept of one.")
        #expect(turn.cutShortLine == "Cut short: the rest of this file's diff was too long to keep.")
        #expect(turn.someCutLine == "Some diffs were too long to keep whole: they are cut short.")
        let repository = TurnDiff.Origin.uncommitted(total: 2)
        #expect(repository.leftOutLine == "Not shown: this file's diff was left out.")
        #expect(repository.cutShortLine == "Cut short: the rest of this file's diff was left out.")
        #expect(repository.someCutLine == "Some of these diffs were left out or cut short.")
    }

    @Test func theListSaysHowManyOfHowManyTheHostListed() {
        #expect(changed.listLine(.turn) == "2 files changed")
        #expect(changed.listLine(.uncommitted(total: 2)) == "2 files changed")
        #expect(changed.listLine(.uncommitted(total: 350)) == "Showing 2 of 350 files")
    }

    @Test func aFileWithNoCountsLeavesNoCountWhereItIsAlone() {
        let binary = TurnDiff.File(path: "pic.png", uncounted: true)
        #expect(!TurnDiff(files: [binary]).hasCounts)
        // Beside ones that have them, what those say.
        #expect(TurnDiff(files: [binary, changed.files[0]]).hasCounts)
        // Counted and none: a file only renamed, or empty.
        #expect(TurnDiff(files: [TurnDiff.File(path: "renamed")]).hasCounts)
        // No more than the wire's own fields are kept with a turn.
        let kept = try? JSONDecoder().decode(TurnDiff.File.self, from: JSONEncoder().encode(binary))
        #expect(kept?.uncounted == false)
    }

    @Test func aRepositorysLineHasNoCountWhereNoFileHasOne() {
        func status(_ files: [GitFileChange], total: Int? = nil, added: Int? = nil) -> GitStatus {
            GitStatus(branch: "main", commit: "abc", files: files, total: total, added: added)
        }
        let binary = GitFileChange(path: "pic.png", added: nil, removed: nil)
        let half = GitFileChange(path: "big.log", added: nil, removed: 0)
        let empty = GitFileChange(path: "empty", added: 0, removed: 0)
        let lines = GitFileChange(path: "a", added: 3, removed: 1)
        #expect(!status([binary]).hasCounts)
        #expect(!status([half]).hasCounts)
        #expect(status([binary, lines]).hasCounts)
        #expect(status([empty]).hasCounts)
        // None counted of those listed, and others past them.
        #expect(!status([empty], total: 350).hasCounts)
        #expect(status([lines], total: 350).hasCounts)
        #expect(status([empty], total: 350).isListCut)
        #expect(!status([empty]).isListCut)
    }

    @Test func totalsAndCountsReadAsTheFooterSaysThem() {
        #expect(changed.added == 5)
        #expect(changed.removed == 2)
        #expect(changed.filesLine == "2 files")
        #expect(TurnDiff(files: [TurnDiff.File(path: "a")]).filesLine == "1 file")
        #expect(TurnDiff.counts(added: 40, removed: 12) == "+40 \u{2212}12")
        #expect(TurnDiff.counts(added: 0, removed: 3) == "\u{2212}3")
        #expect(TurnDiff.counts(added: 0, removed: 0) == "+0")
        #expect(changed.files[0].name == "app.ts")
        #expect(changed.files[0].folder == "src")
        #expect(changed.files[1].folder == nil)
    }

    @Test func whatTheHostSaysAfterTheEndGoesWithTheTurnThatEndedNeverARunningOne() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("Go.", at: t0), outcome: .started, at: t0)
        state.apply(.turnChanged(changed), at: t0)
        #expect(state.transcript.turns.last?.diff == nil)
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(5))
        state.apply(.turnChanged(changed), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns.last?.diff == changed)
        // An inline command answer does not turn the agent's turn into a local turn.
        state.messageDelivered(state.messageSent("More.", at: t0), outcome: .started, at: t0)
        state.commandAnswered("/usage", output: "1,200 tokens", at: t0.addingTimeInterval(6))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(7))
        state.apply(.turnChanged(changed), at: t0.addingTimeInterval(7))
        #expect(state.transcript.turns.last?.diff == changed)
        #expect(state.transcript.turns.count == 2)
    }

    @Test func aCopyKeepsWhatItChangedWhenTheHostNoLongerSays() {
        let mine = Transcript(turns: [ended(diff: changed)])
        var theirs = ended()
        theirs.id = UUID()
        #expect(mine.merged(withHost: Transcript(turns: [theirs])).turns.first?.diff == changed)
        let newer = TurnDiff(files: [TurnDiff.File(path: "other.txt", added: 1)])
        theirs.diff = newer
        #expect(mine.merged(withHost: Transcript(turns: [theirs])).turns.first?.diff == newer)
    }

    /// A turn saved before the app kept the file a tool row names gets it from the host's
    /// same row, when the host's history agrees with it: Open File is offered on it again.
    @Test func aSavedTurnTakesItsToolRowsFilesFromTheHost() {
        func turn(path: String?) -> Turn {
            Turn(startedAt: t0, endedAt: t0.addingTimeInterval(9), outcome: .completed, items: [
                TurnItem(.user(UserMessage(text: "Go.", sentAt: t0))),
                TurnItem(.tool(ToolRun(id: "call-1", name: "patch", state: .succeeded, path: path))),
                TurnItem(.text("Done.")),
            ])
        }
        let merged = Transcript(turns: [turn(path: nil)]).merged(withHost: Transcript(turns: [turn(path: "src/main.swift")]))
        let paths = merged.turns.first?.items.compactMap { item -> String? in
            if case let .tool(run) = item.content { run.path } else { nil }
        }
        #expect(paths == ["src/main.swift"])
    }

    @Test func aTurnSavedBeforeTheDiffStillOpens() throws {
        let saved = try JSONEncoder().encode(ended())
        var object = try #require(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        object["diff"] = nil
        let turn = try JSONDecoder().decode(Turn.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(turn.diff == nil)
        // And one saved with it keeps it.
        let kept = try JSONDecoder().decode(Turn.self, from: JSONEncoder().encode(ended(diff: changed)))
        #expect(kept.diff == changed)
    }
}

@Suite struct NumberedDiffTests {
    @Test func numberingStopsAtTheLargestLineRatherThanOverflowing() {
        let diff = "@@ -1,3 +\(Int.max),3 @@\n first\n+second\n third\n@@ -1 +7 @@\n+next hunk\n"
        #expect(NumberedDiff(diff).lines.map(\.number) == [nil, Int.max, nil, nil, nil, 7])
        #expect(NumberedDiff.newStart("@@ -1 +\(Int.max)0 @@") == nil)
    }

    @Test func aChangedLineBeyondTheLargestLineHasNoNumber() {
        #expect(TurnDiff.File(path: "a", diff: "@@ -1 +\(Int.max) @@\n context\n+changed\n").firstChangedLine == nil)
        #expect(TurnDiff.File(path: "a", diff: "@@ -1 +\(Int.max) @@\n context\n+changed\n@@ -1 +7 @@\n+later\n").firstChangedLine == 7)
    }

    @Test func negativeHunkCountsAreNotDecrementedPastTheSmallestInteger() {
        for (old, new) in [(Int.min, 1), (1, Int.min), (Int.min, Int.min)] {
            let header = "@@ -1,\(old) +1,\(new) @@"
            let counts = DiffText.hunkCounts(header)
            #expect(counts.0 == 0 && counts.1 == 0)
            let diff = DiffText(header + "\n-old\n+new\n")
            #expect(diff.removed == 1)
            #expect(diff.added == 1)
        }
        let counts = DiffText.hunkCounts("@@ -1,\(Int.max) +1,\(Int.max) @@")
        #expect(counts.0 == Int.max && counts.1 == Int.max)
        #expect(DiffText("@@ -1,\(Int.max) +1,\(Int.max) @@\n-old\n+new\n").lines.count == 3)
    }

    @Test func linesAreNumberedInTheNewFileFromEachHunksHeader() {
        let numbered = NumberedDiff("--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -98,2 +99,2 @@\n-x\n+y\n z\n")
        #expect(numbered.lines.map(\.number) == [nil, 1, nil, 2, 3, 4, nil, nil, 99, 100])
        #expect(numbered.lines.map(\.kind) == [.hunk, .context, .removed, .added, .added, .context, .hunk, .removed, .added, .context])
        #expect(numbered.gutter == 3)
        // Without line numbers (an edit's old and new text alone), none.
        let bare = NumberedDiff("--- a/f\n+++ b/f\n-hi\n+hello\n@@\n-x\n+y\n")
        #expect(bare.lines.allSatisfy { $0.number == nil })
        #expect(bare.gutter == 2)
        #expect(NumberedDiff.newStart("@@ -0,0 +1 @@") == 1)
    }

    @Test func aVeryLongLineIsCutForShowing() {
        let long = String(repeating: "é", count: NumberedDiff.shownLineLimit + 500)
        let numbered = NumberedDiff("--- a/min.js\n+++ b/min.js\n@@ -1 +1 @@\n-\(long)\n+\(long)x\n")
        #expect(numbered.lines.count == 3)
        for line in numbered.lines.dropFirst() {
            #expect(line.text.count == NumberedDiff.shownLineLimit + 1)
            #expect(line.text.hasSuffix("\u{2026}"))
        }
        // A line at the limit is whole.
        let edge = String(repeating: "a", count: NumberedDiff.shownLineLimit)
        #expect(NumberedDiff("@@ -1 +1 @@\n+\(edge)\n").lines.last?.text == edge)
    }

    @Test func aDiffAsLongAsTheHostKeepsIsReadQuickly() {
        // About 512 KB: what the host keeps of a turn at most.
        let lines = (0..<20_000).map { "+line \($0) " + String(repeating: "x", count: 20) }
        let diff = "--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,20000 @@\n" + lines.joined(separator: "\n") + "\n"
        let clock = ContinuousClock()
        var numbered: NumberedDiff?
        let took = clock.measure { numbered = NumberedDiff(diff) }
        #expect(numbered?.lines.count == 20_001)
        #expect(numbered?.lines.last?.number == 20_000)
        // Generous, for a loaded Mac; it is read off the main thread in the app anyway.
        #expect(took < .seconds(2))
    }

    /// "Open File" on a file's diff: the viewer opens it where the host can find it, at
    /// the first line the turn changed.
    @Test func aChangedFileOpensAtItsFirstChangedLine() {
        let modified = TurnDiff.File(path: "src/app.ts", diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,4 +3,5 @@\n a\n b\n+c\n d\n@@ -40 +41 @@\n-x\n+y\n")
        #expect(modified.location == FileLocation(path: "src/app.ts", line: 5))
        let added = TurnDiff.File(path: "notes/todo.md", status: .added, diff: "--- /dev/null\n+++ b/notes/todo.md\n@@ -0,0 +1,2 @@\n+# To do\n+\n")
        #expect(added.location.line == 1)
        // A removal is opened where it was; joined edits without numbers open at the top.
        #expect(TurnDiff.File(path: "a", diff: "@@ -7,2 +7,1 @@\n k\n-gone\n").firstChangedLine == 8)
        #expect(TurnDiff.File(path: "a", diff: "--- a/a\n+++ b/a\n@@\n-old\n+new\n").firstChangedLine == nil)
        #expect(TurnDiff.File(path: "a").firstChangedLine == nil)
    }

    /// The host names a file outside the thread's folder by its absolute path, with its
    /// "/", and one inside relative to the folder, whatever its first folder is called.
    @Test func aFileOutsideTheFolderOpensByItsAbsolutePath() {
        #expect(TurnDiff.File(path: "/Users/dev/other/x.ts").location.path == "/Users/dev/other/x.ts")
        #expect(TurnDiff.File(path: "src/x.ts").location.path == "src/x.ts")
        // A folder inside the project named as one at the Mac's top stays inside.
        #expect(TurnDiff.File(path: "Users/fixture.txt").location.path == "Users/fixture.txt")
    }

    /// A removed line that starts with "-- " or an added one with "++ " is a line of the
    /// hunk, not a file's header: it is shown and counted, and the numbers after it hold.
    @Test func linesThatReadLikeHeadersInsideAHunkAreShown() {
        let diff = DiffText("--- a/opts\n+++ b/opts\n@@ -1,2 +1,2 @@\n--- old option\n++++ new option\n keep\n")
        #expect(diff.lines.map(\.kind) == [.hunk, .removed, .added, .context])
        #expect(diff.lines.map(\.text) == ["@@ -1,2 +1,2 @@", "-- old option", "+++ new option", "keep"])
        #expect(diff.added == 1)
        #expect(diff.removed == 1)
        #expect(diff.fileName == "opts")
        let numbered = NumberedDiff("--- a/opts\n+++ b/opts\n@@ -1,2 +1,2 @@\n--- old option\n++++ new option\n keep\n")
        #expect(numbered.lines.map(\.number) == [nil, nil, 1, 2])
        // Two files in one diff: the second's header after the first's hunk is a header.
        let two = DiffText("--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-p\n+q\n")
        #expect(two.added == 2)
        #expect(two.removed == 2)
        #expect(two.fileName == "b")
        // A chunk without numbers (a Droid patch's): such lines are changes unless a hunk's
        // header follows them.
        let chunk = DiffText("diff --git a/a.sql b/a.sql\n--- a/a.sql\n+++ b/a.sql\n@@\n--- old comment\n+++ new comment\n@@ later\n select 1;\ndiff --git a/b.sql b/b.sql\n--- a/b.sql\n+++ b/b.sql\n@@\n-x\n+y\n")
        #expect(chunk.lines.map(\.kind) == [.hunk, .removed, .added, .hunk, .context, .hunk, .removed, .added])
        #expect(chunk.added == 2)
        #expect(chunk.fileName == "b.sql")
        // An edit's old and new text alone (Claude Code's history): no hunk's header at all.
        let bare = DiffText("--- a/opts\n+++ b/opts\n--- old option\n+replacement\n keep\n")
        #expect(bare.lines.map(\.kind) == [.removed, .added, .context])
        #expect(bare.lines.first?.text == "-- old option")
        let grown = DiffText("--- a/opts\n+++ b/opts\n-x\n+++ new option\n keep\n")
        #expect(grown.lines.map(\.kind) == [.removed, .added, .context])
        // Both at once, one after the other.
        let both = DiffText("--- a/opts\n+++ b/opts\n--- old option\n+++ new option\n keep\n")
        #expect(both.lines.map(\.kind) == [.removed, .added, .context])
        #expect(both.lines.map(\.text) == ["-- old option", "++ new option", "keep"])
        #expect(both.fileName == "opts")
        // A file ending without a newline, then the next file's header.
        let ends = DiffText("--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-p\n+q\n")
        #expect(ends.added == 2)
        #expect(ends.fileName == "b")
        // A file with no hunk (a rename alone), then the next file.
        let renamed = DiffText("--- a/old.ts\n+++ b/new.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n")
        #expect(renamed.lines.map(\.kind) == [.hunk, .removed, .added])
        #expect(renamed.fileName == "b.ts")
    }
}
