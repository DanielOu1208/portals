import Foundation

/// A file of lines, each added at the end, that never grows past `cap` bytes: when the next
/// line would take it past, the oldest lines go, down to half the cap, so it is rewritten
/// once in a while rather than at every line.
public struct CappedLog: Sendable {
    public let url: URL
    public let cap: Int

    public init(url: URL, cap: Int) {
        self.url = url
        self.cap = cap
    }

    /// Adds `line` (a newline is put after it), making the file and its folder if need be.
    public func append(_ line: String) throws {
        let data = Data((line + "\n").utf8)
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return
        }
        let size = (try? manager.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        if size + data.count > cap {
            let kept = Self.newestLines(of: try Data(contentsOf: url), within: max(0, cap / 2 - data.count))
            try (kept + data).write(to: url, options: .atomic)
            return
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    /// The last whole lines of `data` that fit in `bytes`.
    static func newestLines(of data: Data, within bytes: Int) -> Data {
        guard bytes > 0, !data.isEmpty else { return Data() }
        guard data.count > bytes else { return data }
        // Start inside the last `bytes`, after the first line end there.
        let from = data.index(data.endIndex, offsetBy: -bytes)
        guard let newline = data[from...].firstIndex(of: UInt8(ascii: "\n")) else { return Data() }
        return Data(data[data.index(after: newline)...])
    }
}

/// A folder of reports, one file each, named so that newer sorts after older (they begin
/// with the time they are from): only the newest are kept.
public enum ReportFolder {
    /// Deletes the oldest files until at most `count` are left, together at most `bytes`.
    /// Returns the names of the files deleted.
    @discardableResult
    public static func prune(_ folder: URL, keeping count: Int, within bytes: Int) -> [String] {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: folder.path) else { return [] }
        var total = 0
        var kept = 0
        var full = false
        var deleted: [String] = []
        for name in names.filter({ !$0.hasPrefix(".") }).sorted(by: >) {
            let url = folder.appendingPathComponent(name)
            let size = (try? manager.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            // Once one has no room, neither has anything older.
            full = full || kept >= count || total + size > bytes
            if !full {
                kept += 1
                total += size
            } else if (try? manager.removeItem(at: url)) != nil {
                deleted.append(name)
            }
        }
        return deleted
    }
}
