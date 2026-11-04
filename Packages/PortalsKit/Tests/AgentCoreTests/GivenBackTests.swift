import AgentCore
import Foundation
import Testing

/// A steer a Stop took back goes back to the composer once its attachments are read from
/// disk: the controller that asked may be closed by then, and nothing of it is lost.
@MainActor
struct GivenBackTests {
    final class Kept: ComposerWordsKeeping {
        var texts: [String: String] = [:]
        func text(for key: String) -> String { texts[key] ?? "" }
        func set(_ text: String, for key: String) { texts[key] = text }
    }

    final class Composer: GivenBackTaking {
        let draftKey: String
        var taken: [GivenBack] = []
        init(_ key: String) { draftKey = key }
        func take(_ message: GivenBack) { taken.append(message) }
    }

    let image = ImageAttachment(id: UUID(), data: Data([1, 2, 3]), filename: "screen.jpg")

    func message() -> GivenBack {
        GivenBack(words: "look at this", mentions: ["notes.md"], images: [image], files: [], whole: true)
    }

    @Test func theComposerOpenOnTheThreadTakesItWhole() {
        let kept = Kept(), messages = GivenBackMessages(words: kept)
        let composer = Composer("host/thread")
        messages.opened(composer)
        messages.give(message(), to: "host/thread")
        #expect(composer.taken == [message()])
        #expect(kept.texts.isEmpty)
        #expect(messages.waiting(for: "host/thread").isEmpty)
    }

    @Test func closedBeforeTheReadEndsItsWordsAreKeptAndItsAttachmentsWait() {
        let kept = Kept(), messages = GivenBackMessages(words: kept)
        kept.texts["host/thread"] = "typed since"
        let asking = Composer("host/thread")
        messages.opened(asking)
        // Its host edited, or let go out of sight, before the image was read.
        messages.closed(asking)
        messages.give(message(), to: "host/thread")
        #expect(asking.taken.isEmpty)
        #expect(kept.text(for: "host/thread") == "look at this\n\ntyped since")
        // The next composer opened on the thread takes its attachments, once.
        #expect(messages.waiting(for: "host/thread") == [message()])
        #expect(messages.waiting(for: "host/thread").isEmpty)
    }

    @Test func replacedBeforeTheReadEndsTheNewComposerTakesIt() {
        let kept = Kept(), messages = GivenBackMessages(words: kept)
        let asking = Composer("host/thread"), other = Composer("host/other")
        messages.opened(asking)
        messages.opened(other)
        messages.closed(asking)
        let replacing = Composer("host/thread")
        messages.opened(replacing)
        messages.give(message(), to: "host/thread")
        #expect(replacing.taken == [message()])
        #expect(asking.taken.isEmpty && other.taken.isEmpty)
        #expect(kept.texts.isEmpty)
    }

    @Test func aComposerLetGoWithoutClosingIsNotGivenIt() {
        let kept = Kept(), messages = GivenBackMessages(words: kept)
        var asking: Composer? = Composer("host/thread")
        messages.opened(asking!)
        asking = nil
        messages.give(message(), to: "host/thread")
        #expect(kept.text(for: "host/thread") == "look at this")
        #expect(messages.waiting(for: "host/thread").count == 1)
    }
}
