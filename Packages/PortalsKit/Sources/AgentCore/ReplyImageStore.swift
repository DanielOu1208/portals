import CoreGraphics
import CryptoKit
import Foundation
import os

/// The bytes of the images replies showed, kept in a folder (the app's caches) with an index
/// of their etags and pixel sizes, at most `limit` bytes: the least lately used go first.
///
/// Nothing is read or written as it is made, since the first to ask for it may be the main
/// thread (an image's known size, for its place in the reply): the index is read by
/// `prepare()`, on the store's own executor, before anything else it does. That also lets go
/// of every file the index does not name (one written as the app stopped before the index
/// was, or all of them when the index could not be read) and of entries whose file is gone,
/// so what is on disk is what the cap counts.
public actor ReplyImageStore {
    public struct Stored: Sendable {
        public var data: Data
        public var etag: String
    }

    private struct Entry: Codable {
        var etag: String
        var width: Double
        var height: Double
        var bytes: Int
        var used: Date
    }

    public let limit: Int
    private let folder: URL
    private var index: [String: Entry] = [:]
    private var isPrepared = false
    /// The sizes, for any thread to read without waiting: a copy of the index's.
    private nonisolated let sizes = OSAllocatedUnfairLock<[String: CGSize]?>(initialState: nil)

    public init(folder: URL, limit: Int = 64 * 1024 * 1024) {
        self.folder = folder
        self.limit = limit
    }

    /// An image's pixel size, when the index is read and has it; nil before `prepare()`.
    public nonisolated func size(for key: String) -> CGSize? {
        sizes.withLock { $0?[key] }
    }

    /// Whether the index has been read (`prepare()`).
    public nonisolated var isReady: Bool {
        sizes.withLock { $0 != nil }
    }

    /// Reads the index, once, and makes what is in the folder agree with it.
    public func prepare() {
        guard !isPrepared else { return }
        isPrepared = true
        let files = FileManager.default
        try? files.createDirectory(at: folder, withIntermediateDirectories: true)
        var saved = (try? Data(contentsOf: indexFile)).flatMap { try? JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:]
        let names = Set((try? files.contentsOfDirectory(atPath: folder.path)) ?? [])
        let named = Set(saved.keys.map(Self.fileName))
        var changed = false
        for name in names where name != Self.indexName && !named.contains(name) {
            try? files.removeItem(at: folder.appending(path: name))
        }
        // An entry whose file is gone, or is not the size it says (written again as the app
        // stopped, before the index was): let go of, so the cap counts what is there.
        for (key, entry) in saved {
            let name = Self.fileName(key)
            let size = names.contains(name) ? (try? files.attributesOfItem(atPath: folder.appending(path: name).path)[.size] as? Int) ?? nil : nil
            guard size != entry.bytes else { continue }
            if size != nil { try? files.removeItem(at: folder.appending(path: name)) }
            saved[key] = nil
            changed = true
        }
        index = saved
        let known = saved.mapValues { CGSize(width: $0.width, height: $0.height) }
        sizes.withLock { $0 = known }
        if trim(keeping: nil) || changed { saveIndex() }
    }

    /// The bytes kept for `key`, and their etag; nil when none are.
    public func stored(for key: String) -> Stored? {
        prepare()
        guard var entry = index[key], let data = try? Data(contentsOf: file(for: key)) else { return nil }
        entry.used = .now
        index[key] = entry
        return Stored(data: data, etag: entry.etag)
    }

    /// Keeps `data` for `key`, then lets go of the least lately used past the limit.
    public func store(_ data: Data, for key: String, etag: String, size: CGSize) {
        prepare()
        do {
            try data.write(to: file(for: key), options: .atomic)
        } catch {
            return
        }
        index[key] = Entry(etag: etag, width: size.width, height: size.height, bytes: data.count, used: .now)
        sizes.withLock { $0?[key] = size }
        trim(keeping: key)
        saveIndex()
    }

    /// Lets go of the least lately used past the limit, never `keeping`; whether any went.
    @discardableResult
    private func trim(keeping: String?) -> Bool {
        var total = index.values.reduce(0) { $0 + $1.bytes }
        guard total > limit else { return false }
        var removed = false
        for (old, entry) in index.sorted(by: { $0.value.used < $1.value.used }) where total > limit && old != keeping {
            try? FileManager.default.removeItem(at: file(for: old))
            index[old] = nil
            sizes.withLock { $0?[old] = nil }
            total -= entry.bytes
            removed = true
        }
        return removed
    }

    private func saveIndex() {
        if let encoded = try? JSONEncoder().encode(index) {
            try? encoded.write(to: indexFile, options: .atomic)
        }
    }

    private static let indexName = "index.json"

    private var indexFile: URL {
        folder.appending(path: Self.indexName)
    }

    private func file(for key: String) -> URL {
        folder.appending(path: Self.fileName(key))
    }

    /// A key's file: its SHA-256, so a path names no file of its own.
    static func fileName(_ key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
