import CoreGraphics
import Foundation
import Testing
@testable import AgentCore

/// The images replies showed, kept on disk: nothing read as the store is made (the main
/// thread may make it), and what is on disk agrees with the index the cap counts.
@Suite struct ReplyImageStoreTests {
    private func folder() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "reply-image-store-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    @Test func makingTheStoreReadsAndWritesNothing() async {
        let folder = folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = ReplyImageStore(folder: folder)
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(!store.isReady)
        #expect(store.size(for: "a") == nil)
        await store.prepare()
        #expect(store.isReady)
        #expect(FileManager.default.fileExists(atPath: folder.path))
    }

    @Test func storedImagesComeBackWithTheirSizesAfterARelaunch() async {
        let folder = folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = ReplyImageStore(folder: folder)
        await first.store(Data([1, 2, 3]), for: "scope\n/tmp/a.png", etag: "3-1-1", size: CGSize(width: 40, height: 20))
        let again = ReplyImageStore(folder: folder)
        await again.prepare()
        #expect(again.size(for: "scope\n/tmp/a.png") == CGSize(width: 40, height: 20))
        let stored = await again.stored(for: "scope\n/tmp/a.png")
        #expect(stored?.data == Data([1, 2, 3]))
        #expect(stored?.etag == "3-1-1")
    }

    @Test func filesTheIndexDoesNotNameAreLetGoOfAndEntriesWithoutAFileDropped() async throws {
        let folder = folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = ReplyImageStore(folder: folder)
        await first.store(Data(repeating: 7, count: 10), for: "kept", etag: "k", size: CGSize(width: 1, height: 1))
        await first.store(Data(repeating: 8, count: 10), for: "lost", etag: "l", size: CGSize(width: 2, height: 2))
        // The app stopped after an image's bytes were written and before the index was: a
        // file the index does not name. And one entry's file is gone.
        let orphan = folder.appending(path: ReplyImageStore.fileName("orphan"))
        try Data(repeating: 9, count: 50).write(to: orphan)
        try FileManager.default.removeItem(at: folder.appending(path: ReplyImageStore.fileName("lost")))

        let again = ReplyImageStore(folder: folder)
        await again.prepare()
        #expect(!FileManager.default.fileExists(atPath: orphan.path))
        #expect(again.size(for: "lost") == nil)
        #expect(again.size(for: "kept") == CGSize(width: 1, height: 1))
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
        #expect(names == [ReplyImageStore.fileName("kept"), "index.json"].sorted())
    }

    @Test func aFileWrittenAgainWithoutItsIndexIsLetGoOf() async throws {
        let folder = folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = ReplyImageStore(folder: folder)
        await first.store(Data(repeating: 1, count: 10), for: "a", etag: "a", size: CGSize(width: 1, height: 1))
        // Overwritten larger, and the app stopped before the index said so.
        let file = folder.appending(path: ReplyImageStore.fileName("a"))
        try Data(repeating: 2, count: 500).write(to: file)
        let again = ReplyImageStore(folder: folder)
        await again.prepare()
        #expect(again.size(for: "a") == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func anUnreadableIndexLetsGoOfEveryFile() async throws {
        let folder = folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = ReplyImageStore(folder: folder)
        await first.store(Data(repeating: 1, count: 10), for: "a", etag: "a", size: CGSize(width: 1, height: 1))
        try Data("{ not json".utf8).write(to: folder.appending(path: "index.json"))
        let again = ReplyImageStore(folder: folder)
        await again.prepare()
        #expect(again.size(for: "a") == nil)
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: ReplyImageStore.fileName("a")).path))
    }

    @Test func pastTheLimitTheLeastLatelyUsedGoFirst() async {
        let folder = folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = ReplyImageStore(folder: folder, limit: 25)
        await store.store(Data(repeating: 1, count: 10), for: "old", etag: "o", size: CGSize(width: 1, height: 1))
        await store.store(Data(repeating: 2, count: 10), for: "new", etag: "n", size: CGSize(width: 1, height: 1))
        await store.store(Data(repeating: 3, count: 10), for: "newest", etag: "w", size: CGSize(width: 1, height: 1))
        #expect(store.size(for: "old") == nil)
        #expect(await store.stored(for: "old") == nil)
        #expect(await store.stored(for: "newest")?.etag == "w")
    }
}
