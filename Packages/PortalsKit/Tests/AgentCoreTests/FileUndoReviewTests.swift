import Foundation
import Testing
@testable import AgentCore

@Suite struct FileUndoReviewTests {
    private let now = Date(timeIntervalSince1970: 1_000)
    private func preview(_ files: [String], added: Int? = nil, removed: Int? = nil) -> TurnFileUndoPreview {
        TurnFileUndoPreview(previewID: UUID().uuidString, files: files, insertions: added, deletions: removed,
                            expiresAt: now.addingTimeInterval(60))
    }

    @Test func rowsUseOnlyNativeFilesAndMatchCountsByTheWholeHostPath() {
        let native = preview(["/project/src/app.swift", "/project/tests/app.swift", "/project/new.txt"], added: 99, removed: 88)
        let diff = TurnDiff(files: [
            .init(path: "src/app.swift", added: 7, removed: 2),
            .init(path: "/project/tests/app.swift", status: .added, added: 3),
            .init(path: "not-in-native.txt", added: 40),
        ])
        let rows = FileUndoFileList(preview: native, workingDirectory: "/project/", turnDiff: diff)
        #expect(rows.files.map(\.path) == ["src/app.swift", "tests/app.swift", "new.txt"])
        #expect(rows.files.map(\.name) == ["app.swift", "app.swift", "new.txt"])
        #expect(rows.files[0].folder == "src")
        #expect(rows.files[0].added == 7 && rows.files[0].removed == 2)
        #expect(rows.files[1].added == 3 && rows.files[1].status == .added)
        #expect(rows.files[2].uncounted)
        #expect(rows.aggregate == nil)
        #expect(rows.filesLine == "3 files")
    }

    @Test func missingOrAmbiguousFileCountsNeverInheritTheAggregate() {
        let native = preview(["/project/src/a.swift", "/project/src/b.swift"], added: 20, removed: 5)
        let unmatched = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: nil)
        #expect(unmatched.files.allSatisfy(\.uncounted))
        #expect(unmatched.aggregate?.added == 20 && unmatched.aggregate?.removed == 5)
        let ambiguous = TurnDiff(files: [.init(path: "src/a.swift", added: 7), .init(path: "./src/a.swift", added: 8)])
        let rows = FileUndoFileList(preview: native, workingDirectory: "/project", turnDiff: ambiguous)
        #expect(rows.files.allSatisfy(\.uncounted))
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
        #expect(rows.files[0].added == 2)
        #expect(rows.files[1].path == "…/src/app.swift")
        #expect(rows.files[1].uncounted)
        let unknownRoot = FileUndoFileList(preview: preview(["/project/src/app.swift"]), workingDirectory: nil, turnDiff: diff)
        #expect(unknownRoot.files[0].path == "…/src/app.swift")
        #expect(unknownRoot.files[0].uncounted)
        let binary = FileUndoFileList(preview: preview(["image.png"]), workingDirectory: "/project", turnDiff: TurnDiff(files: [.init(path: "image.png", uncounted: true)]))
        #expect(binary.files[0].uncounted)
    }

    @Test func changedFilesFetchOneNewPreviewAndAlwaysRequireANewExplicitRestore() throws {
        var state = FileUndoReviewState()
        #expect(state.beginPreview())
        let original = preview(["old.swift"])
        state.receivedPreview(original)
        #expect(state.beginRestore(at: now)?.id == original.id)
        #expect(!state.canConfirm(at: now))
        #expect(state.restoreFailed(TurnFileUndoError.filesChangedBeforeRestore))
        #expect(state.refreshedChangedFiles)
        #expect(!state.isApplying)
        #expect(!state.canConfirm(at: now))
        #expect(state.beginRestore(at: now) == nil)
        #expect(state.beginPreview())
        let updated = preview(["new.swift"])
        state.receivedPreview(updated)
        #expect(state.canConfirm(at: now))
        #expect(!state.isApplying)
        #expect(state.shownPreview?.files == ["new.swift"])
        #expect(state.beginRestore(at: now)?.id == updated.id)
        #expect(!state.restoreFailed(TurnFileUndoError.filesChangedBeforeRestore))
        #expect(state.blocksActions)
        #expect(!state.beginPreview())
    }

    @Test func ambiguousFailuresAndPartialRestoresKeepTheirWarningAndNeverRefresh() {
        for error in [TurnFileUndoError.stalePreview, .invalidPreview, .busy] {
            var state = FileUndoReviewState()
            #expect(state.beginPreview())
            let reviewed = preview(["app.swift"])
            state.receivedPreview(reviewed)
            #expect(state.beginRestore(at: now) != nil)
            #expect(!state.restoreFailed(error))
            #expect(state.requiresFolderReview)
            #expect(state.message?.contains("Some files may have changed") == true)
            #expect(state.shownPreview?.id == reviewed.id)
            #expect(!state.canConfirm(at: now))
            #expect(!state.beginPreview())
        }
        var partial = FileUndoReviewState()
        #expect(partial.beginPreview())
        partial.receivedPreview(preview(["app.swift"]))
        #expect(partial.beginRestore(at: now) != nil)
        partial.restored(TurnFileUndoResult(restored: false, skippedLinks: 2))
        #expect(partial.requiresFolderReview && partial.blocksActions)
        #expect(partial.message?.contains("incomplete") == true)
        #expect(!partial.beginPreview())
    }
}
