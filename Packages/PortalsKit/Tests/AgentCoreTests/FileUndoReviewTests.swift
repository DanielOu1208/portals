import Foundation
import Testing
@testable import AgentCore

@Suite struct FileUndoReviewTests {
    private let now = Date(timeIntervalSince1970: 1_000)
    private func preview(_ files: [String], added: Int? = nil, removed: Int? = nil) -> TurnFileUndoPreview {
        TurnFileUndoPreview(previewID: UUID().uuidString, files: files, insertions: added, deletions: removed,
                            expiresAt: now.addingTimeInterval(60))
    }

    @Test func rowsUseOnlyNativeFilesAndMatchStatusesByTheWholeHostPath() {
        let native = preview(["/project/src/app.swift", "/project/tests/app.swift", "/project/new.txt"], added: 12, removed: 2)
        let diff = TurnDiff(files: [
            .init(path: "src/app.swift", added: 7, removed: 2),
            .init(path: "/project/tests/app.swift", status: .added, added: 3),
            .init(path: "new.txt", added: 2),
            .init(path: "not-in-native.txt", added: 40),
        ])
        let rows = FileUndoFileList(preview: native, workingDirectory: "/project/", turnDiff: diff)
        #expect(rows.files.map(\.path) == ["src/app.swift", "tests/app.swift", "new.txt"])
        #expect(rows.files.map(\.name) == ["app.swift", "app.swift", "new.txt"])
        #expect(rows.files[0].folder == "src")
        #expect(rows.files.allSatisfy { $0.uncounted })
        #expect(rows.files[1].status == .added)
        #expect(rows.aggregate?.added == 12 && rows.aggregate?.removed == 2)
        #expect(rows.filesLine == "3 files")
    }

    @Test func missingOrAmbiguousFileCountsNeverInheritTheAggregate() {
        let native = preview(["/project/src/a.swift", "/project/src/b.swift"], added: 20, removed: 5)
        let unmatched = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: nil)
        #expect(unmatched.files.allSatisfy { $0.uncounted })
        #expect(unmatched.aggregate?.added == 20 && unmatched.aggregate?.removed == 5)
        let ambiguous = TurnDiff(files: [.init(path: "src/a.swift", added: 7), .init(path: "./src/a.swift", added: 8)])
        let rows = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: ambiguous)
        #expect(rows.files.allSatisfy { $0.uncounted })
        #expect(rows.aggregate?.added == 20)
        let onlyRemoved = FileUndoFileList(preview: preview(["a.txt"], removed: 4), workingDirectory: nil, turnDiff: nil)
        #expect(onlyRemoved.aggregate?.added == nil)
        #expect(onlyRemoved.aggregate?.removed == 4)
        #expect(onlyRemoved.filesLine == "1 file")
    }

    @Test func hostPathsNormalizeWithoutReadingTheDevicesFilesystem() {
        let native = preview(["/project/src/../app.swift", "/project-old/src/app.swift"])
        let diff = TurnDiff(files: [.init(path: "./app.swift", added: 2), .init(path: "src/app.swift", added: 99)])
        let rows = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: diff)
        #expect(rows.files[0].path == "app.swift")
        #expect(rows.files[0].folder == nil)
        #expect(rows.files[0].uncounted)
        #expect(rows.files[1].path == "…/src/app.swift")
        #expect(rows.files[1].uncounted)
        let unknownRoot = FileUndoFileList(preview: preview(["/project/src/app.swift"]), workingDirectory: nil, turnDiff: diff)
        #expect(unknownRoot.files[0].path == "…/src/app.swift")
        #expect(unknownRoot.files[0].uncounted)
        let binary = FileUndoFileList(preview: preview(["image.png"]), workingDirectory: "/project", turnDiff: TurnDiff(files: [.init(path: "image.png", uncounted: true)]))
        #expect(binary.files[0].uncounted)
    }

    @Test func oneFileUsesItsExactNativeCountsInsteadOfHistoricalNumbers() {
        let native = preview(["/project/app.swift"], added: 12, removed: 4)
        let old = TurnDiff(files: [.init(path: "app.swift", added: 99, removed: 88)])
        let rows = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: old)
        #expect(rows.files[0].added == 12 && rows.files[0].removed == 4)
        #expect(!rows.files[0].uncounted)
        #expect(rows.aggregate == nil)
        #expect(rows.filesLine == "1 file")
        let zero = FileUndoFileList(preview: preview(["app.swift"], added: 0, removed: 0), workingDirectory: "/project", turnDiff: old)
        #expect(zero.files[0].added == 0 && zero.files[0].removed == 0 && !zero.files[0].uncounted)
    }

    @Test func mismatchedOrIncompleteMultiFileCountsUseOnlyNativeAggregateTotals() {
        let old = TurnDiff(files: [.init(path: "a.swift", added: 3, removed: 1), .init(path: "b.swift", added: 2, removed: 1)])
        for native in [preview(["a.swift", "b.swift"], added: 7, removed: 2),
                       preview(["a.swift", "b.swift"], added: 5, removed: 4),
                       preview(["a.swift", "b.swift"], added: 5)] {
            let rows = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: old)
            #expect(rows.files.allSatisfy { $0.uncounted })
            #expect(rows.aggregate?.added == native.insertions)
            #expect(rows.aggregate?.removed == native.deletions)
        }
        let missing = FileUndoFileList(preview: preview(["a.swift", "b.swift"], added: 5, removed: 2), workingDirectory: "/project",
                                      turnDiff: TurnDiff(files: [old.files[0]]))
        #expect(missing.files.allSatisfy { $0.uncounted })
        #expect(missing.aggregate?.added == 5)
    }

    @Test func matchingAggregateCountsCannotProveTheCurrentPerFileDistribution() {
        let old = TurnDiff(files: [.init(path: "a.swift", added: 8), .init(path: "b.swift", added: 2)])
        let rows = FileUndoFileList(preview: preview(["a.swift", "b.swift"], added: 10, removed: 0),
                                   workingDirectory: "/project", turnDiff: old)
        #expect(rows.files.allSatisfy { $0.uncounted })
        #expect(rows.aggregate?.added == 10 && rows.aggregate?.removed == 0)
    }

    @Test func refreshedReviewsDiscardHistoricalCountsEvenIfTheirTotalsStillAgree() {
        let old = TurnDiff(files: [.init(path: "a.swift", added: 3, removed: 1), .init(path: "b.swift", added: 2, removed: 1)])
        let native = preview(["a.swift", "b.swift"], added: 5, removed: 2)
        var state = FileUndoReviewState()
        #expect(state.beginPreview() == true)
        state.receivedPreview(native)
        #expect(state.fileList(workingDirectory: "/project", turnDiff: old)?.files.allSatisfy { $0.uncounted } == true)
        #expect(state.beginRestore(at: now) != nil)
        #expect(state.restoreFailed(TurnFileUndoError.filesChangedBeforeRestore) == true)
        #expect(state.beginPreview() == true)
        state.receivedPreview(preview(["a.swift", "b.swift"], added: 5, removed: 2))
        let refreshed = state.fileList(workingDirectory: "/project", turnDiff: old)
        #expect(refreshed?.files.allSatisfy { $0.uncounted } == true)
        #expect(refreshed?.aggregate?.added == 5)
        #expect(refreshed?.files.map(\.path) == ["a.swift", "b.swift"])
        // A single refreshed file still has exact per-file native totals.
        #expect(state.beginRestore(at: now) != nil)
        state = FileUndoReviewState()
        #expect(state.beginPreview() == true)
        state.receivedPreview(native)
        #expect(state.beginRestore(at: now) != nil)
        #expect(state.restoreFailed(TurnFileUndoError.filesChangedBeforeRestore) == true)
        #expect(state.beginPreview() == true)
        state.receivedPreview(preview(["a.swift"], added: 20, removed: 4))
        let one = state.fileList(workingDirectory: "/project", turnDiff: old)
        #expect(one?.files[0].added == 20 && one?.files[0].removed == 4)
        #expect(one?.files[0].uncounted == false)
    }

    @Test func changedFilesFetchOneNewPreviewAndAlwaysRequireANewExplicitRestore() throws {
        var state = FileUndoReviewState()
        #expect(state.beginPreview() == true)
        let original = preview(["old.swift"])
        state.receivedPreview(original)
        #expect(state.beginRestore(at: now)?.id == original.id)
        #expect(!state.canConfirm(at: now))
        #expect(state.restoreFailed(TurnFileUndoError.filesChangedBeforeRestore) == true)
        #expect(state.refreshedChangedFiles)
        #expect(!state.isApplying)
        #expect(!state.canConfirm(at: now))
        #expect(state.beginRestore(at: now) == nil)
        #expect(state.beginPreview() == true)
        let updated = preview(["new.swift"])
        state.receivedPreview(updated)
        #expect(state.canConfirm(at: now))
        #expect(!state.isApplying)
        #expect(state.shownPreview?.files == ["new.swift"])
        #expect(state.beginRestore(at: now)?.id == updated.id)
        #expect(state.restoreFailed(TurnFileUndoError.filesChangedBeforeRestore) == false)
        #expect(state.blocksActions)
        #expect(state.beginPreview() == false)
    }

    @Test func ambiguousFailuresAndPartialRestoresKeepTheirWarningAndNeverRefresh() {
        for error in [TurnFileUndoError.stalePreview, .invalidPreview, .busy] {
            var state = FileUndoReviewState()
            #expect(state.beginPreview() == true)
            let reviewed = preview(["app.swift"])
            state.receivedPreview(reviewed)
            #expect(state.beginRestore(at: now) != nil)
            #expect(state.restoreFailed(error) == false)
            #expect(state.requiresFolderReview)
            #expect(state.message?.contains("Some files may have changed") == true)
            #expect(state.shownPreview?.id == reviewed.id)
            #expect(!state.canConfirm(at: now))
            #expect(state.beginPreview() == false)
            state.invalidate("The folder or connection changed.")
            #expect(state.message?.contains("Some files may have changed") == true)
        }
        var partial = FileUndoReviewState()
        #expect(partial.beginPreview() == true)
        partial.receivedPreview(preview(["app.swift"]))
        #expect(partial.beginRestore(at: now) != nil)
        partial.restored(TurnFileUndoResult(restored: false, skippedLinks: 2))
        #expect(partial.requiresFolderReview && partial.blocksActions)
        #expect(partial.message?.contains("incomplete") == true)
        #expect(partial.beginPreview() == false)
        let warning = partial.message
        partial.invalidate("The folder or connection changed.")
        #expect(partial.message == warning)
    }
}
