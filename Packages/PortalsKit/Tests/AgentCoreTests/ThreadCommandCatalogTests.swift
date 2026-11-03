import Foundation
import Testing
@testable import AgentCore

@MainActor
@Suite struct ThreadCommandCatalogTests {
    private actor Host: CommandRunning {
        struct Request: Sendable {
            var thread: ThreadRef.ID
            var answer: CheckedContinuation<CommandCatalog, any Error>
        }

        nonisolated let requests: AsyncStream<Request>
        private let continuation: AsyncStream<Request>.Continuation
        private(set) var callCount = 0

        init() { (requests, continuation) = AsyncStream.makeStream() }

        func commandCatalog(for agent: Agent.ID) async throws -> CommandCatalog { Self.catalog("personal") }
        func commandCatalog(for agent: Agent.ID, in thread: ThreadRef.ID) async throws -> CommandCatalog {
            callCount += 1
            return try await withCheckedThrowingContinuation { answer in
                continuation.yield(Request(thread: thread, answer: answer))
            }
        }
        func runCommand(_ command: SlashInput, in thread: ThreadRef.ID) async throws -> CommandOutcome { .output("") }
        nonisolated static func catalog(_ name: String) -> CommandCatalog {
            CommandCatalog(commands: [SlashCommand(name: name, summary: name, kind: .host)])
        }
    }

    private func thread(_ id: String, folder: String = "/project") -> ThreadRef {
        ThreadRef(id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: HostID(rawValue: "test"), name: "droid"), workingDirectory: folder)
    }

    @Test func lateRepliesCannotCrossThreadsOrReplaceANewerReadOfTheSameThread() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let catalog = ThreadCommandCatalog()
        let old = try #require(catalog.refresh(for: thread("a"), using: host))
        let oldRequest = try #require(await requests.next())
        let other = try #require(catalog.refresh(for: thread("b"), using: host))
        let otherRequest = try #require(await requests.next())
        let current = try #require(catalog.refresh(for: thread("a"), using: host))
        let currentRequest = try #require(await requests.next())
        #expect(catalog.catalog == nil)
        currentRequest.answer.resume(returning: Host.catalog("a-current"))
        await current.value
        oldRequest.answer.resume(returning: Host.catalog("a-obsolete"))
        otherRequest.answer.resume(returning: Host.catalog("b-obsolete"))
        await old.value
        await other.value
        #expect(catalog.catalog == Host.catalog("a-current"))
    }

    @Test func folderChangesHideTheOldProjectAndAnExplicitRefreshReadsAgain() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let catalog = ThreadCommandCatalog()
        let first = try #require(catalog.refresh(for: thread("a", folder: "/one"), using: host))
        let firstRequest = try #require(await requests.next())
        firstRequest.answer.resume(returning: Host.catalog("one"))
        await first.value
        #expect(catalog.refresh(for: thread("a", folder: "/one"), using: host) == nil)
        let moved = try #require(catalog.refresh(for: thread("a", folder: "/two"), using: host))
        #expect(catalog.catalog == nil)
        let movedRequest = try #require(await requests.next())
        #expect(movedRequest.thread == firstRequest.thread)
        movedRequest.answer.resume(returning: Host.catalog("two"))
        await moved.value
        #expect(catalog.catalog == Host.catalog("two"))
        let reopened = try #require(catalog.refresh(for: thread("a", folder: "/two"), using: host, force: true))
        #expect(catalog.catalog == nil)
        let reopenedRequest = try #require(await requests.next())
        reopenedRequest.answer.resume(returning: Host.catalog("two-refreshed"))
        await reopened.value
        #expect(catalog.catalog == Host.catalog("two-refreshed"))
    }

    @Test func oneScopeReusesItsCatalogAndDeduplicatesEvenForcedInFlightReads() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let catalog = ThreadCommandCatalog()
        let scope = thread("created")
        let first = try #require(catalog.refresh(for: scope, using: host))
        let request = try #require(await requests.next())
        #expect(catalog.refresh(for: scope, using: host) == nil)
        let duplicate = catalog.refresh(for: scope, using: host, force: true)
        #expect(duplicate == nil)
        request.answer.resume(returning: Host.catalog("project"))
        await first.value
        if let duplicate {
            let extra = try #require(await requests.next())
            extra.answer.resume(returning: Host.catalog("project"))
            await duplicate.value
        }
        for _ in 0..<3 { #expect(catalog.refresh(for: scope, using: host) == nil) }
        #expect(await host.callCount == 1)
        #expect(catalog.catalog == Host.catalog("project"))

        // A detach explicitly invalidates the cache, even if the folder did not change.
        catalog.cancel()
        let reconnect = try #require(catalog.refresh(for: scope, using: host))
        let reconnected = try #require(await requests.next())
        #expect(catalog.refresh(for: scope, using: host) == nil)
        reconnected.answer.resume(returning: Host.catalog("after-reconnect"))
        await reconnect.value
        #expect(catalog.catalog == Host.catalog("after-reconnect"))
    }

    @Test func separateControllersNeverShareTheirProjectCatalogs() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let a = ThreadCommandCatalog(), b = ThreadCommandCatalog()
        let first = try #require(a.refresh(for: thread("a"), using: host))
        let firstRequest = try #require(await requests.next())
        let second = try #require(b.refresh(for: thread("b"), using: host))
        let secondRequest = try #require(await requests.next())
        secondRequest.answer.resume(returning: Host.catalog("b-only"))
        await second.value
        #expect(a.catalog == nil)
        firstRequest.answer.resume(returning: Host.catalog("a-only"))
        await first.value
        #expect(a.catalog == Host.catalog("a-only"))
        #expect(b.catalog == Host.catalog("b-only"))
    }

    @Test func closingRejectsALateHostReplyEvenIfItIgnoresCancellation() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let catalog = ThreadCommandCatalog()
        let pending = try #require(catalog.refresh(for: thread("a"), using: host))
        let request = try #require(await requests.next())
        catalog.cancel()
        request.answer.resume(returning: Host.catalog("closed"))
        await pending.value
        #expect(catalog.catalog == nil)
    }

    @Test func failureKeepsTheScopeEmptyAndAllowsTheSameScopeToRetry() async throws {
        struct Unavailable: Error {}
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let catalog = ThreadCommandCatalog()
        let first = try #require(catalog.refresh(for: thread("a"), using: host))
        let request = try #require(await requests.next())
        request.answer.resume(throwing: Unavailable())
        await first.value
        #expect(catalog.catalog == nil)
        let retry = try #require(catalog.refresh(for: thread("a"), using: host))
        let retried = try #require(await requests.next())
        retried.answer.resume(returning: Host.catalog("recovered"))
        await retry.value
        #expect(catalog.catalog == Host.catalog("recovered"))
    }

    @Test func providersWithoutThreadCatalogsKeepTheirExistingCatalogMethod() async throws {
        struct Legacy: CommandRunning {
            func commandCatalog(for agent: Agent.ID) async throws -> CommandCatalog { Host.catalog("legacy") }
            func runCommand(_ command: SlashInput, in thread: ThreadRef.ID) async throws -> CommandOutcome { .output("") }
        }
        let catalog = ThreadCommandCatalog()
        let task = try #require(catalog.refresh(for: thread("a"), using: Legacy()))
        await task.value
        #expect(catalog.catalog == Host.catalog("legacy"))
    }
}
