import AgentCore
import Foundation
import Testing

/// The `@` menu as it is typed in the composer (docs/plans/2026-10-26-file-mentions.md,
/// section 8): when it opens, what a pick writes, going into a folder, the tokens kept
/// through editing, and the mentions sent beside the text.
struct MentionTypingTests {
    /// The query with the caret at `|` in `text` (the bar taken out).
    private func query(_ marked: String) -> MentionQuery? {
        let caret = marked.firstIndex(of: "|")!.utf16Offset(in: marked)
        let text = marked.replacingOccurrences(of: "|", with: "")
        return MentionQuery.at(String.Index(utf16Offset: caret, in: text), in: text)
    }

    private func edited(_ edit: MentionEdit) -> String {
        var text = edit.text
        text.insert("|", at: edit.caret)
        return text
    }

    // MARK: When the menu opens

    @Test func anAtAtTheStartOfAWordOpensTheMenu() {
        #expect(query("@|")?.text == "")
        #expect(query("Look at @|")?.text == "")
        #expect(query("Look at @src/ma|")?.text == "src/ma")
        #expect(query("first line\n@REA|")?.text == "REA")
        // After CJK punctuation, where Claude Code reads one too.
        #expect(query("见。@ma|")?.text == "ma")
    }

    @Test func anAtInsideAWordDoesNot() {
        // An email address, and a mention after punctuation, which Claude Code would not read.
        #expect(query("mail me@exa|") == nil)
        #expect(query("(@src|") == nil)
        #expect(query("no at here|") == nil)
    }

    @Test func aSpaceClosesItAndTheCaretMustBeInTheWord() {
        #expect(query("@src/main.ts |") == nil)
        #expect(query("@src |more") == nil)
        // The caret back in the word opens it again, for the letters before the caret.
        #expect(query("@sr|c more")?.text == "sr")
    }

    @Test func aQuotedQueryMayHoldSpaces() {
        let open = query(#"See @"dir with sp|"#)
        #expect(open?.text == "dir with sp")
        #expect(open?.isQuoted == true)
        // Closed, it is a token, not a query; so is a quote that no `@` opened.
        #expect(query(#"See @"dir with space/note.txt" |"#) == nil)
        #expect(query(#"See @"dir with space/note.txt"|"#) == nil)
        #expect(query(#"say "hel|"#) == nil)
    }

    @Test func eachAtIsToldApart() {
        let first = query("@a and @b|")
        let second = query("@a| and @b")
        #expect(first?.anchor == 7)
        #expect(second?.anchor == 0)
    }

    // MARK: Picking

    @Test func pickingAFileReplacesTheQueryWithItsTokenAndASpace() throws {
        let text = "Look at @src/ma please"
        let typed = try #require(query("Look at @src/ma| please"))
        #expect(edited(typed.writing("src/main.ts", in: text)) == "Look at @src/main.ts |please")
        // At the end, the space is added.
        let atEnd = try #require(query("Look at @ma|"))
        #expect(edited(atEnd.writing("src/main.ts", in: "Look at @ma")) == "Look at @src/main.ts |")
        // A path Claude Code would cut short is quoted.
        #expect(edited(atEnd.writing("dir with space/note.txt", in: "Look at @ma")) == #"Look at @"dir with space/note.txt" |"#)
    }

    @Test func pickingInAQuotedPathReplacesItUpToItsClosingQuote() throws {
        // Codex's review of n14/mentions: the replacement stopped at the space in the path.
        let text = #"See @"my folder with spaces/x.md" and"#
        let typed = try #require(query(#"See @"my fo|lder with spaces/x.md" and"#))
        #expect(edited(typed.writing("my folder/x.md", in: text)) == #"See @"my folder/x.md" |and"#)
        // Unclosed, it goes to the end of the word, as a bare one does.
        let open = try #require(query(#"See @"my fo|lder"#))
        #expect(edited(open.writing("my folder/x.md", in: #"See @"my folder"#)) == #"See @"my folder/x.md" |"#)
    }

    @Test func pickingInTheMiddleOfAWordReplacesAllOfIt() throws {
        let typed = try #require(query("@sr|c/x and"))
        #expect(edited(typed.writing("src/main.ts", in: "@src/x and")) == "@src/main.ts |and")
        let quoted = try #require(query(#"@"my fo|lder/x" and"#))
        #expect(edited(quoted.writing("my folder/x.md", in: #"@"my folder/x" and"#)) == #"@"my folder/x.md" |and"#)
    }

    @Test func pickingAFolderGoesIntoIt() throws {
        let typed = try #require(query("Look at @sr|"))
        let into = typed.descending(into: "src", in: "Look at @sr")
        #expect(edited(into) == "Look at @src/|")
        // The menu is open on the folder's files.
        let next = try #require(MentionQuery.at(into.caret, in: into.text))
        #expect(next.text == "src/")
        // A folder with a space goes on quoted.
        let spaced = typed.descending(into: "my folder", in: "Look at @sr")
        #expect(edited(spaced) == #"Look at @"my folder/|"#)
        #expect(MentionQuery.at(spaced.caret, in: spaced.text)?.text == "my folder/")
    }

    @Test func theFolderGoneIntoIsARowAtTheTop() {
        let hits = [
            FileSearchHit(path: "src/main.ts", name: "main.ts", kind: .file, score: 9, ranges: [0 ..< 4]),
            FileSearchHit(path: "src", name: "src", kind: .folder, score: 8, ranges: [0 ..< 3]),
            FileSearchHit(path: "scripts/rc.sh", name: "rc.sh", kind: .file, score: 1, ranges: []),
        ]
        let rows = MentionRow.rows(for: "src/", hits: hits)
        #expect(rows.map(\.id) == ["folder:src", "hit:src/main.ts", "hit:scripts/rc.sh"])
        // Not before a slash, nor for a folder no hit is in.
        #expect(MentionRow.rows(for: "src", hits: hits).count == 3)
        #expect(MentionRow.rows(for: "docs/", hits: [hits[2]]).map(\.id) == ["hit:scripts/rc.sh"])
    }

    // MARK: What is sent

    @Test func theTokensPickedAreKeptThroughEditing() {
        let picked = ["src/main.ts", "docs", "notes.md"]
        // Words typed around them, one deleted, one edited into another file's name.
        let text = "Compare @src/main.ts with @docs, and also this @notes.mdx"
        #expect(FileMentionDraft.mentions(picked: picked, in: text, hostTakesThem: true) == ["src/main.ts", "docs"])
        let tokens = FileMentionDraft.tokens(picked: picked, in: text).map { String(text[$0]) }
        #expect(tokens == ["@src/main.ts", "@docs"])
        // A token picked twice, or written twice, goes once.
        #expect(FileMentionDraft.mentions(picked: ["a.ts", "a.ts"], in: "@a.ts and @a.ts", hostTakesThem: true) == ["a.ts"])
        // A mention typed but not picked is the text's alone.
        #expect(FileMentionDraft.mentions(picked: [], in: "@a.ts", hostTakesThem: true) == [])
    }

    @Test func anOlderHostGetsTheTextAlone() {
        #expect(FileMentionDraft.mentions(picked: ["src/main.ts"], in: "See @src/main.ts", hostTakesThem: false) == [])
        #expect(FileMentionDraft.mentions(picked: ["src/main.ts"], in: "See @src/main.ts", hostTakesThem: true) == ["src/main.ts"])
    }

    // MARK: Rows and sent messages

    @Test func aHitsNameAndFolderAreApart() {
        let hit = FileSearchHit(path: "bridge/src/gateway/methods.ts", name: "methods.ts", kind: .file, score: 1, ranges: [11 ..< 12, 15 ..< 16, 19 ..< 23])
        #expect(hit.folder == "bridge/src/gateway")
        #expect(hit.nameMatches.map { String(hit.name[$0]) } == ["meth"])
        let top = FileSearchHit(path: "README.md", name: "README.md", kind: .file, score: 1, ranges: [0 ..< 3])
        #expect(top.folder == "")
        #expect(top.nameMatches.map { String(top.name[$0]) } == ["REA"])
        // A range across the folder and the name keeps the name's part.
        let across = FileSearchHit(path: "src/a.ts", name: "a.ts", kind: .file, score: 1, ranges: [2 ..< 5])
        #expect(across.nameMatches.map { String(across.name[$0]) } == ["a"])
    }

    @Test func anAtInsideAQuotedPathIsPartOfItsChipAndToken() {
        // Codex's review of n14/mentions: `@"my @notes.md"` made three chips, the middle one
        // opening notes.md. Claude Code reads the inner one too (`paths(in:)` keeps it), but
        // what is drawn is the token as written, once.
        let text = #"See @"my @notes.md" now"#
        let marked = FileMention.marked(text)
        let runs = marked.runs.compactMap { run in run.fileMention.map { ($0, String(marked[run.range].characters)) } }
        #expect(runs.map(\.0) == ["my @notes.md"])
        #expect(runs.map(\.1) == [#"@"my @notes.md""#])
        #expect(FileMentionDraft.tokens(picked: ["my @notes.md", "notes.md"], in: text).map { String(text[$0]) } == [#"@"my @notes.md""#])
        #expect(FileMention.paths(in: text) == ["my @notes.md", "notes.md"])
    }

    // 2026-10-27: only path-like @ tokens are chips, "ask @claude" stays text; one
    // picked from the menu is a chip whatever its shape.

    @Test func onlyAPathLikeTokenIsAChip() {
        let text = #"Ask @claude about @plan.md, @src/main and @"my folder/note.txt", not @v1.2 or @3.14."#
        let marked = FileMention.marked(text)
        let paths = marked.runs.compactMap(\.fileMention)
        #expect(paths == ["plan.md", "src/main", "my folder/note.txt"])
        // A picked one whatever its shape.
        let picked = FileMention.marked("Run @Makefile and ask @claude", picked: ["Makefile"])
        #expect(picked.runs.compactMap(\.fileMention) == ["Makefile"])
    }

    @Test func aPathIsPathLikeWithASlashOrAnExtension() {
        for path in ["plan.md", "main.c", "src/main", "src/", "my folder/note.txt", "a.tar.gz", "photo.7z", "docs/README"] {
            #expect(FileMention.isPathLike(path), "\(path)")
        }
        // A word, a version or a number, and a name with nothing after its dot.
        for path in ["claude", "Makefile", "v1.2", "3.14", ".env", "end."] {
            #expect(!FileMention.isPathLike(path), "\(path)")
        }
    }

    @Test func aSentMessagesMentionsAreMarkedWithTheirPaths() {
        let marked = FileMention.marked(#"See @src/main.ts and @"my notes.md", or me@example.com."#)
        let runs = marked.runs.compactMap { run in run.fileMention.map { ($0, String(marked[run.range].characters)) } }
        #expect(runs.map(\.0) == ["src/main.ts", "my notes.md"])
        #expect(runs.map(\.1) == ["@src/main.ts", #"@"my notes.md""#])
    }
}

/// What the messages sent from this device mentioned, by message (Codex's review of
/// n14/mentions): "Try again" on a message the host took had lost its mentions, and a
/// note was kept by path, so a later message mentioning the file changed an earlier one's.
struct SentMentionsTests {
    @Test func aMessageKeepsItsMentionsAndItsOwnNotes() {
        var sent = SentMentions()
        let first = UUID(), second = UUID()
        sent.sent(["src/main.ts", "logs/run.log"], as: first)
        sent.answered([LargeFileMention(path: "logs/run.log", size: 300_045, fit: .unread)], for: first)
        sent.sent(["logs/run.log"], as: second)
        sent.answered([], for: second)
        #expect(sent.paths(of: first) == ["src/main.ts", "logs/run.log"])
        #expect(sent.fit(of: "logs/run.log", in: first) == .unread)
        #expect(sent.fit(of: "src/main.ts", in: first) == nil)
        // The file shrank since: the later message has no note, the earlier keeps its own.
        #expect(sent.fit(of: "logs/run.log", in: second) == nil)
        #expect(sent.paths(of: UUID()) == [])
    }

    @Test func onlyTheNewestMessagesAreKept() {
        var sent = SentMentions()
        let oldest = UUID()
        sent.sent(["a.ts"], as: oldest)
        for _ in 0 ..< SentMentions.kept { sent.sent(["b.ts"], as: UUID()) }
        #expect(sent.paths(of: oldest) == [])
        // A message with none is not kept at all.
        let none = UUID()
        sent.sent([], as: none)
        sent.answered([LargeFileMention(path: "c.ts", size: 1, fit: .maybe)], for: none)
        #expect(sent.fit(of: "c.ts", in: none) == nil)
    }
}

/// The host's answers to the `@` menu's queries.
@MainActor
struct FileMentionSearchTests {
    private func results(_ paths: [String], refreshing: Bool = false) -> FileSearchResults {
        FileSearchResults(
            folder: "/w", hits: paths.map { FileSearchHit(path: $0, name: $0, kind: .file, score: 1, ranges: []) },
            total: paths.count, matched: paths.count, source: "git", refreshing: refreshing
        )
    }

    private func settle(_ search: FileMentionSearch, until done: () -> Bool) async {
        for _ in 0 ..< 200 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    @Test func aNewerQueryDropsAnOlderOnesLateAnswer() async {
        let search = FileMentionSearch()
        let scope = FileSearchScope.folder("/w")
        // The first query's answer comes after the second's.
        search.ask(.init(query: "m", scope: scope)) { _ in
            try? await Task.sleep(for: .milliseconds(150))
            return self.results(["old.ts"])
        }
        search.ask(.init(query: "ma", scope: scope)) { _ in self.results(["main.ts"]) }
        await settle(search) { search.answer?.asked.query == "ma" }
        try? await Task.sleep(for: .milliseconds(250))
        #expect(search.answer?.asked.query == "ma")
        #expect(search.answer?.results.hits.map(\.path) == ["main.ts"])
    }

    @Test func aRefreshingAnswerIsAskedForAgain() async {
        let search = FileMentionSearch(refreshAfter: .milliseconds(20))
        var asked = 0
        search.ask(.init(query: "m", scope: .folder("/w"))) { _ in
            asked += 1
            return asked < 3 ? self.results(["old.ts"], refreshing: true) : self.results(["new.ts"])
        }
        await settle(search) { search.answer?.results.refreshing == false }
        #expect(asked == 3)
        #expect(search.answer?.results.hits.map(\.path) == ["new.ts"])
        // Answered: the same query is not asked again.
        search.ask(.init(query: "m", scope: .folder("/w"))) { _ in
            asked += 1
            return self.results([])
        }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(asked == 3)
    }

    @Test func aRefusedQueryShowsItsRefusalNotAnOlderQuerysRows() async {
        // Codex's review of n14/mentions: after @m was answered, @zz refused left m's rows
        // on screen, to be picked into @zz, and hid the refusal.
        let search = FileMentionSearch()
        let scope = FileSearchScope.folder("/w")
        search.ask(.init(query: "m", scope: scope)) { _ in self.results(["main.ts"]) }
        await settle(search) { search.answer != nil }
        // While a newer query is asked, the older answer stands in.
        search.ask(.init(query: "zz", scope: scope)) { _ in
            try await Task.sleep(for: .milliseconds(100))
            throw FileSearchError.refused("The folder is not on the list.")
        }
        #expect(search.shown(for: .init(query: "zz", scope: scope))?.hits.map(\.path) == ["main.ts"])
        await settle(search) { search.problem != nil }
        #expect(search.shown(for: .init(query: "zz", scope: scope)) == nil)
        #expect(search.problem?.message == "The folder is not on the list.")
        // Another folder's answer is never shown.
        #expect(search.shown(for: .init(query: "m", scope: .folder("/other"))) == nil)
    }

    @Test func nothingMatchingStandsInWhileANewerQueryIsAsked() async {
        // 2026-10-28, on a Mac: the menu "doesnt consistently stay on screen". After
        // a query that matched nothing, each key closed it until the next answer came.
        let search = FileMentionSearch()
        let scope = FileSearchScope.folder("/w")
        search.ask(.init(query: "zq", scope: scope)) { _ in self.results([]) }
        await settle(search) { search.answer != nil }
        #expect(search.findsNothing(for: .init(query: "zq", scope: scope)))
        search.ask(.init(query: "zqx", scope: scope)) { _ in
            try await Task.sleep(for: .milliseconds(100))
            return self.results(["zqx.ts"])
        }
        #expect(search.findsNothing(for: .init(query: "zqx", scope: scope)))
        await settle(search) { search.answer?.asked.query == "zqx" }
        #expect(!search.findsNothing(for: .init(query: "zqx", scope: scope)))
        // Not before any answer, nor in another folder.
        #expect(!FileMentionSearch().findsNothing(for: .init(query: "a", scope: scope)))
        #expect(!search.findsNothing(for: .init(query: "zqx", scope: .folder("/other"))))
    }

    @Test func aRefusalIsSaidForItsQuery() async {
        let search = FileMentionSearch()
        search.ask(.init(query: "x", scope: .thread(.init(rawValue: "t")))) { _ in throw FileSearchError.refused("This thread is not on the host any more.") }
        await settle(search) { search.problem != nil }
        #expect(search.problem?.message == "This thread is not on the host any more.")
        #expect(search.problem?.asked.query == "x")
        search.stop()
        #expect(search.problem == nil)
        #expect(search.answer == nil)
    }
}
