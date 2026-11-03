import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// `files.search` (feature `file_search`) and how a message names the files it mentions
/// (feature `file_mentions`). The answers are what the bridge's `FileSearch` gave on
/// 2026-10-26 for a folder with a name past ASCII in it and one with an emoji, the folder's
/// path replaced.
@Suite struct FileSearchWireTests {
    private func answer(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    @Test func anAnswerIsReadWithItsRangesAsUTF16Offsets() throws {
        let results = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/Users/dev/work","files":[{"path":"notes/🚀launch.md","name":"🚀launch.md","kind":"file","score":150,"ranges":[[8,14]]}],"total":5,"matched":1,"source":"walk"}"#
        ))
        #expect(results.folder == "/Users/dev/work")
        #expect(results.total == 5)
        #expect(results.matched == 1)
        #expect(results.source == "walk")
        #expect(results.truncated == false)
        #expect(results.refreshing == false)
        let hit = try #require(results.hits.first)
        #expect(hit == FileSearchHit(path: "notes/🚀launch.md", name: "🚀launch.md", kind: .file, score: 150, ranges: [8 ..< 14]))
        // The emoji is two UTF-16 units: the matched letters are "launch", not "aunch.".
        #expect(hit.matchedRanges.map { String(hit.path[$0]) } == ["launch"])
    }

    @Test func aRangeOffTheCharactersOfThePathIsLeftOut() {
        // Into the middle of the emoji (offset 7), and past the end.
        let hit = FileSearchHit(path: "notes/🚀launch.md", name: "🚀launch.md", kind: .file, score: 1, ranges: [7 ..< 9, 8 ..< 10, 15 ..< 99])
        #expect(hit.matchedRanges.map { String(hit.path[$0]) } == ["la"])
    }

    @Test func refreshingTruncatedAndFoldersAreRead() throws {
        let results = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[{"path":"docs","name":"docs","kind":"folder","score":0,"ranges":[]},{"path":"x","kind":"socket","score":1,"ranges":[]},{"path":"docs/plan with space.md","name":"plan with space.md","kind":"file","score":198,"ranges":[[5,9],[9,"x"],[4,2]]}],"total":200000,"matched":3,"source":"git","truncated":true,"refreshing":true}"#
        ))
        #expect(results.truncated)
        #expect(results.refreshing)
        #expect(results.source == "git")
        // An unknown kind is left out; ranges that are not pairs of offsets too.
        #expect(results.hits.map(\.path) == ["docs", "docs/plan with space.md"])
        #expect(results.hits.map(\.kind) == [.folder, .file])
        #expect(results.hits[1].ranges == [5 ..< 9])
        #expect(results.hits[1].token == #"@"docs/plan with space.md""#)
    }

    @Test func anAnswerWithoutItsFolderOrFilesIsRefused() {
        #expect(throws: FileSearchError.self) { try BridgeWire.fileSearchResults(from: answer(#"{"files":[]}"#)) }
        #expect(throws: FileSearchError.self) { try BridgeWire.fileSearchResults(from: answer(#"{"folder":"/w"}"#)) }
    }

    @Test func theParamsNameAThreadOrAFolderAndNeverBoth() throws {
        let thread = try JSONValue(encoding: BridgeWire.FilesSearchParams(scope: .thread(ThreadRef.ID(rawValue: "s1")), query: "main", limit: 20)).serialized()
        #expect(thread == #"{"limit":20,"query":"main","session_id":"s1"}"#)
        let folder = try JSONValue(encoding: BridgeWire.FilesSearchParams(scope: .folder("/Users/dev/work"), query: "")).serialized()
        #expect(folder == #"{"folder":"\/Users\/dev\/work","query":""}"# || folder == #"{"folder":"/Users/dev/work","query":""}"#)
    }

    @Test func mentionsAreSentOnlyWhenThereAreAny() throws {
        let without = try JSONValue(encoding: BridgeWire.PromptSubmitParams(sessionID: "s", text: "hi", profile: nil, whenBusy: .queue)).objectValue
        #expect(without?["mentions"] == nil)
        let with = try JSONValue(encoding: BridgeWire.PromptSubmitParams(sessionID: "s", text: "hi @src", profile: nil, whenBusy: .queue, mentions: ["src"])).objectValue
        #expect(with?["mentions"] == .array([.string("src")]))
    }

    @Test func aMentionIsWrittenAsTheBridgeAndClaudeCodeWriteIt() {
        #expect(FileMention.token(for: "src/main.ts") == "@src/main.ts")
        #expect(FileMention.token(for: "dir with space/note.txt") == #"@"dir with space/note.txt""#)
        // Claude Code drops what follows a bare mention's last ASCII letter, digit or _.
        #expect(FileMention.token(for: "report.md,") == #"@"report.md,""#)
        #expect(FileMention.token(for: "café") == #"@"café""#)
        #expect(FileMention.token(for: "src/main_2") == "@src/main_2")
    }

    @Test func aWrittenMentionIsFoundAsItWasWritten() {
        for path in ["src/main.ts", "report.md,", "note?", "café", "dir with space/note.txt", "a\\b.txt"] {
            #expect(FileMention.paths(in: "See \(FileMention.token(for: path)) please") == [path])
        }
        // A longer name is another file, not the shorter one.
        #expect(FileMention.paths(in: "@note?copy") == ["note?copy"])
    }

    @Test func theMentionsOfATextAreFoundInOrderEachOnce() {
        // Claude Code reads no @ inside a word: (@docs/plan.md) mentions nothing.
        #expect(FileMention.paths(in: #"Compare @src/main.ts with @"dir with space/note.txt", then (@docs/plan.md) and @README.md. Mail me@example.com; @src/main.ts again."#)
            == ["src/main.ts", "dir with space/note.txt", "README.md"])
        #expect(FileMention.paths(in: "@") == [])
        #expect(FileMention.paths(in: #"@"unclosed"#) == [])
        #expect(FileMention.paths(in: "Look at @src.") == ["src"])
    }

    // 2026-10-26: "Yes, a small note" when a mentioned file is too large for the
    // agent to read in (Claude Code 2.1.299: 262,144 bytes and 25,000 tokens).

    @Test func sizesAndTheAgentsLimitAreRead() throws {
        let results = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[{"path":"docs","name":"docs","kind":"folder","score":9,"ranges":[]},{"path":"big.txt","name":"big.txt","kind":"file","score":8,"ranges":[],"size":70000},{"path":"huge.log","name":"huge.log","kind":"file","score":7,"ranges":[],"size":300000},{"path":"small.ts","name":"small.ts","kind":"file","score":6,"ranges":[],"size":12},{"path":"link.txt","name":"link.txt","kind":"file","score":5,"ranges":[]},{"path":"odd.txt","name":"odd.txt","kind":"file","score":4,"ranges":[],"size":-1}],"total":6,"matched":6,"source":"walk","mention_limit":{"max_bytes":262144,"max_tokens":25000,"note_bytes":60000}}"#
        ))
        #expect(results.hits.map(\.size) == [nil, 70000, 300_000, 12, nil, nil])
        let limit = try #require(results.mentionLimit)
        #expect(limit == FileMentionLimit(maxBytes: 262_144, maxTokens: 25000, noteBytes: 60000))
        #expect(results.hits.map { results.fit(of: $0) } == [.whole, .maybe, .unread, .whole, .whole, .whole])
        #expect(results.hits.map { results.fit(of: $0).note != nil } == [false, true, true, false, false, false])
    }

    @Test func withoutTheAgentsLimitNoFileHasANote() throws {
        // Codex, Cursor and the rest: their model reads a mentioned file with its tools.
        let results = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[{"path":"huge.log","name":"huge.log","kind":"file","score":7,"ranges":[],"size":300000}],"total":1,"matched":1,"source":"git"}"#
        ))
        #expect(results.mentionLimit == nil)
        #expect(results.fit(of: results.hits[0]) == .whole)
        // A limit missing a part says nothing rather than a wrong note.
        let partial = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[],"total":0,"matched":0,"source":"git","mention_limit":{"max_bytes":262144,"note_bytes":"60000"}}"#
        ))
        #expect(partial.mentionLimit == nil)
        // A token limit past an Int (an environment's 1e100) keeps the rest (from Codex's review).
        let huge = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[{"path":"huge.log","name":"huge.log","kind":"file","score":7,"ranges":[],"size":300000}],"total":1,"matched":1,"source":"git","mention_limit":{"max_bytes":262144,"max_tokens":1e100,"note_bytes":262144}}"#
        ))
        #expect(huge.mentionLimit == FileMentionLimit(maxBytes: 262_144, maxTokens: .max, noteBytes: 262_144))
        #expect(huge.fit(of: huge.hits[0]) == .unread)
    }

    @Test func aPDFHasNoNote() throws {
        // Claude Code reads a PDF its own way, whatever its size (from Codex's review).
        let results = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[{"path":"papers/big.PDF","name":"big.PDF","kind":"file","score":7,"ranges":[],"size":900000}],"total":1,"matched":1,"source":"git","mention_limit":{"max_bytes":262144,"max_tokens":25000,"note_bytes":60000}}"#
        ))
        #expect(results.fit(of: results.hits[0]) == .whole)
        // A file named .pdf has no extension to Claude Code: the usual limit (from Codex's re-check).
        let named = try BridgeWire.fileSearchResults(from: answer(
            #"{"folder":"/w","files":[{"path":"docs/.PDF","name":".PDF","kind":"file","score":7,"ranges":[],"size":900000}],"total":1,"matched":1,"source":"git","mention_limit":{"max_bytes":262144,"max_tokens":25000,"note_bytes":60000}}"#
        ))
        #expect(named.fit(of: named.hits[0]) == .unread)
    }

    @Test func aLimitSaysWhatBecomesOfAFileOfEachSize() {
        let limit = FileMentionLimit(maxBytes: 262_144, maxTokens: 25000, noteBytes: 60000)
        #expect(limit.fit(size: nil) == .whole)
        #expect(limit.fit(size: 60000) == .whole)
        #expect(limit.fit(size: 60001) == .maybe)
        #expect(limit.fit(size: 262_144) == .maybe)
        #expect(limit.fit(size: 262_145) == .unread)
        #expect(FileMentionFit.whole.note == nil)
    }

    @Test func theNewThreadScreenSearchesItsFolderNamingTheAgentToCome() throws {
        let folder = try JSONValue(encoding: BridgeWire.FilesSearchParams(scope: .folder("/w"), query: "big", profile: "claude")).objectValue
        #expect(folder?["folder"] == .string("/w"))
        #expect(folder?["profile"] == .string("claude"))
    }

    @Test func theMentionsASentMessagesAgentMayNotReadInAreRead() throws {
        let decoded = try JSONDecoder().decode(
            HermesWire.PromptSubmitResult.self,
            from: Data(#"{"status":"streaming","large_mentions":[{"path":"big.txt","size":70000,"fit":"maybe"},{"path":"huge.log","size":300000,"fit":"unread"},{"path":"x","size":1,"fit":"whole"},{"path":"y","fit":"maybe"},{"path":"z","size":5,"fit":"sideways"}]}"#.utf8)
        )
        #expect(decoded.largeMentions?.mentions == [
            LargeFileMention(path: "big.txt", size: 70000, fit: .maybe),
            LargeFileMention(path: "huge.log", size: 300_000, fit: .unread),
        ])
        // The message is sent by then: a list the app cannot read fails nothing.
        let odd = try JSONDecoder().decode(HermesWire.PromptSubmitResult.self, from: Data(#"{"status":"queued","queue_id":"q1","large_mentions":"big.txt"}"#.utf8))
        #expect(odd.status == "queued")
        #expect(odd.queueID == "q1")
        #expect(odd.largeMentions?.mentions == [])
        let none = try JSONDecoder().decode(HermesWire.PromptSubmitResult.self, from: Data(#"{"status":"streaming"}"#.utf8))
        #expect(none.largeMentions == nil)
        #expect(SendReceipt(.started).largeMentions == [])
    }
}
