import AgentCore
import Foundation
import UIKit

/// What is typed in a thread's composer and not sent yet: its words, the images and files
/// attached with them, and the files picked from the `@` menu.
struct ComposerDraft: Hashable {
    var text = ""
    var images: [ImageAttachment] = []
    var files: [FileAttachment] = []
    /// The paths picked from the `@` menu, in the order picked: those the text still
    /// mentions go with it (`FileMentionDraft.mentions`). Kept with the images, not on disk:
    /// a draft's words put back after a relaunch name their files in the text alone.
    var mentions: [String] = []

    var isEmpty: Bool { text.isEmpty && images.isEmpty && files.isEmpty }
}

/// The words typed in each thread's composer and not sent, kept on this device alone:
/// never synced, never sent to the host. They come back when the thread is opened again,
/// after a relaunch too (2026-10-21: "just keep it locally in the composer very
/// simple"). A new thread's are kept for its agent and folder, until one is sent there.
/// Images and files stay with the thread while the app runs (`ThreadController.composer`).
@MainActor
final class ComposerDrafts {
    static let shared = ComposerDrafts()

    private struct Saved: Codable {
        var text: String
        var at: Date
    }

    static let defaultsKey = "composer.drafts"
    /// A draft left this long is let go.
    private static let keptFor: TimeInterval = 30 * 24 * 60 * 60

    private var drafts: [String: Saved]
    /// Typing writes once it pauses, not at every key.
    private let saving = CoalescedWork(after: .milliseconds(500))
    private var leaving: NSObjectProtocol?

    private init() {
        let saved = UserDefaults.standard.data(forKey: Self.defaultsKey)
            .flatMap { try? JSONDecoder().decode([String: Saved].self, from: $0) } ?? [:]
        let oldest = Date.now.addingTimeInterval(-Self.keptFor)
        drafts = saved.filter { $0.value.at > oldest }
        leaving = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ComposerDrafts.shared.saving.flush() }
        }
    }

    /// The key of a thread's draft: the thread on its host, or for a new one, its agent
    /// and folder.
    static func key(thread: ThreadRef?, agent: Agent.ID, folder: Folder?) -> String {
        if let thread { return "\(agent.host.rawValue)/\(thread.id.rawValue)" }
        return "new/\(agent.host.rawValue)/\(agent.name)/\(folder?.path ?? "")"
    }

    func text(for key: String) -> String {
        drafts[key]?.text ?? ""
    }

    func set(_ text: String, for key: String) {
        guard drafts[key]?.text ?? "" != text else { return }
        drafts[key] = text.isEmpty ? nil : Saved(text: text, at: .now)
        saving.ask { [weak self] in self?.save() }
    }

    /// Lets go of every draft kept for `host`'s threads: the demo's, as it starts and ends.
    func forget(host: HostID) {
        let kept = drafts.filter { key, _ in !key.hasPrefix("\(host.rawValue)/") && !key.hasPrefix("new/\(host.rawValue)/") }
        guard kept.count != drafts.count else { return }
        drafts = kept
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(drafts) else { return }
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }
}

extension ComposerDrafts: ComposerWordsKeeping {}

extension GivenBackMessages {
    /// The app's: over the words kept on this device (`ComposerDrafts`), to each thread's
    /// controller while it is open.
    static let shared = GivenBackMessages(words: ComposerDrafts.shared)
}
