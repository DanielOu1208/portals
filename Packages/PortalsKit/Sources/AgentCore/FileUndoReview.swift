import Foundation

/// Presentation of the native preview's exact file set. A turn diff supplies counts
/// only when its full path identifies the same file; totals are never divided up.
public struct FileUndoFileList: Hashable, Sendable {
    public struct Counts: Hashable, Sendable {
        public let added: Int?
        public let removed: Int?
    }

    public let files: [TurnDiff.File]
    public let aggregate: Counts?
    public var filesLine: String { files.count == 1 ? "1 file" : "\(files.count) files" }

    public init(preview: TurnFileUndoPreview, workingDirectory: String?, turnDiff: TurnDiff?) {
        let root = workingDirectory.flatMap { $0.hasPrefix("/") ? Self.normalize($0) : nil }
        let known = Dictionary(grouping: turnDiff?.files ?? []) { Self.key($0.path, root: root) }
        files = preview.files.map { path in
            let key = Self.key(path, root: root)
            let matches = known[key] ?? []
            let match = matches.count == 1 ? matches.first : nil
            let counted = match.flatMap { file in
                !file.uncounted && file.added >= 0 && file.removed >= 0 ? file : nil
            }
            return TurnDiff.File(path: Self.displayPath(path, root: root), status: match?.status ?? .modified,
                                 added: counted?.added ?? 0, removed: counted?.removed ?? 0,
                                 uncounted: counted == nil)
        }
        if files.allSatisfy(\.uncounted), preview.insertions != nil || preview.deletions != nil {
            aggregate = Counts(added: preview.insertions, removed: preview.deletions)
        } else {
            aggregate = nil
        }
    }

    private static func key(_ path: String, root: String?) -> String {
        if path.hasPrefix("/") { return normalize(path) }
        return normalize(root.map { $0 + "/" + path } ?? path)
    }

    private static func displayPath(_ path: String, root: String?) -> String {
        let full = key(path, root: root)
        if let root, full.hasPrefix(root == "/" ? "/" : root + "/") {
            return String(full.dropFirst(root == "/" ? 1 : root.count + 1))
        }
        if !full.hasPrefix("/") { return full }
        // Without the host folder, do not pretend a basename proves a relative path.
        return "…/" + full.split(separator: "/").suffix(2).joined(separator: "/")
    }

    /// POSIX paths from the host, without consulting this device's filesystem or home.
    private static func normalize(_ path: String) -> String {
        let absolute = path.hasPrefix("/")
        var parts: [Substring] = []
        for part in path.split(separator: "/") {
            if part == "." { continue }
            if part == ".." {
                if let last = parts.last, last != ".." { parts.removeLast() }
                else if !absolute { parts.append(part) }
            } else { parts.append(part) }
        }
        return (absolute ? "/" : "") + parts.joined(separator: "/")
    }
}

/// Keeps refresh of a rejected preview separate from retrying a destructive restore.
public struct FileUndoReviewState: Hashable, Sendable {
    public private(set) var preview: TurnFileUndoPreview?
    public private(set) var shownPreview: TurnFileUndoPreview?
    public private(set) var isLoading = false
    public private(set) var isApplying = false
    public private(set) var message: String?
    public private(set) var requiresFolderReview = false
    public private(set) var refreshedChangedFiles = false
    public private(set) var blocksActions = false

    public init() {}

    public func canConfirm(at now: Date = .now) -> Bool {
        !isLoading && !isApplying && !blocksActions && preview?.canConfirm(at: now) == true
    }

    @discardableResult
    public mutating func beginPreview() -> Bool {
        guard !isLoading, !isApplying, !blocksActions else { return false }
        preview = nil
        isLoading = true
        return true
    }

    public mutating func receivedPreview(_ value: TurnFileUndoPreview) {
        guard isLoading else { return }
        isLoading = false
        preview = value
        shownPreview = value
        if refreshedChangedFiles { message = "Files changed. Review this updated preview." }
    }

    public mutating func previewFailed(_ message: String) {
        isLoading = false
        invalidate(message)
    }

    public mutating func invalidate(_ message: String) {
        preview = nil
        self.message = message
        blocksActions = true
    }

    public mutating func beginRestore(at now: Date = .now) -> TurnFileUndoPreview? {
        guard canConfirm(at: now), let reviewed = preview else { return nil }
        preview = nil
        isApplying = true
        message = nil
        return reviewed
    }

    /// True means fetch a new preview once. It never means send another restore.
    public mutating func restoreFailed(_ error: any Error) -> Bool {
        isApplying = false
        preview = nil
        if error as? TurnFileUndoError == .filesChangedBeforeRestore {
            if !refreshedChangedFiles {
                refreshedChangedFiles = true
                message = "Files changed. Updating the preview…"
                return true
            }
            invalidate("Files changed again. Close this sheet and check the folder before continuing.")
        } else {
            requiresFolderReview = true
            invalidate("The undo could not be confirmed. Some files may have changed; check the folder before continuing.")
        }
        return false
    }

    public mutating func restored(_ result: TurnFileUndoResult) {
        isApplying = false
        preview = nil
        blocksActions = true
        if !result.isComplete {
            requiresFolderReview = true
            message = result.message
        }
    }
}
