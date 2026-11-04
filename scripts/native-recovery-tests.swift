// Compiled with the actual ThreadController, AgentOfferings and ChatFeature,
// against AgentCore. No application, network or model is launched.
import AgentCore
import Foundation
import Observation

enum OpenProbe {
    static func step(_ id: String, _ stage: String, took: Duration) {}
}
final class ReturnProbe {
    static let shared: ReturnProbe? = nil
    func note(_ kind: String, _ detail: String) {}
}
@Observable final class WindowVisibility {
    static let shared = WindowVisibility()
    var isHidden = false
}

// UI-only collaborators are in memory here: controller tests do not load UIKit or
// read/write the application's drafts and layout measurements.
struct ComposerDraft: Hashable {
    var text = ""
    var images: [ImageAttachment] = []
    var files: [FileAttachment] = []
    var mentions: [String] = []
    var isEmpty: Bool { text.isEmpty && images.isEmpty && files.isEmpty }
}
final class ComposerDrafts {
    static let shared = ComposerDrafts()
    private var drafts: [String: String] = [:]
    static func key(thread: ThreadRef?, agent: Agent.ID, folder: Folder?) -> String {
        if let thread { return "\(agent.host.rawValue)/\(thread.id.rawValue)" }
        return "new/\(agent.host.rawValue)/\(agent.name)/\(folder?.path ?? "")"
    }
    func text(for key: String) -> String { drafts[key] ?? "" }
    func set(_ text: String, for key: String) { drafts[key] = text }
}
extension ComposerDrafts: ComposerWordsKeeping {}
// As the app wires it (Portals/Chat/ComposerDrafts.swift), over the in-memory drafts.
extension GivenBackMessages {
    static let shared = GivenBackMessages(words: ComposerDrafts.shared)
}
final class TranscriptHeights {}
final class CommandAnswerCloser {}
extension ThreadController {
    func closesCommandAnswers(with answers: CommandAnswerCloser) {}
}
enum DebugLaunch {
    static let statusHeadlineBefore = false
}

actor RecoveryBackend: AgentBackend {
    nonisolated let host = HostID(rawValue: "recovery-test")
    nonisolated let connectionStates = AsyncStream<ConnectionState> { _ in }
    var createWorks = false
    var openWorks = true
    var creates = 0
    var sendFails = false
    var promotionBlock: URL?
    var holdsCreate = false
    var createRelease: CheckedContinuation<Void, Never>?
    var holdsNextSend = false
    var sendRelease: CheckedContinuation<Void, Never>?
    var follows = 0
    var commandRuns = 0
    var holdsNextCommand = false
    var commandRelease: CheckedContinuation<Void, Never>?
    var eventContinuations: [ThreadRef.ID: AsyncStream<ThreadEvent>.Continuation] = [:]
    var sent: [(String, [ImageAttachment], [FileAttachment])] = []
    var snapshot = ThreadSnapshot()
    var modeWorks = false
    var selectedModes: [ThreadMode] = []
    var modesAtSend: [ThreadMode] = []
    var currentMode = ThreadMode.full
    var modeReply: ThreadMode?
    var holdsMode = false
    var modeRelease: CheckedContinuation<Void, Never>?
    var queuedActionModes: [ThreadMode] = []
    var holdsQueueCheck = false
    var queueChecks = 0
    var queueCheckRelease: CheckedContinuation<Void, Never>?
    var holdsResponse = false
    var responses = 0
    var modesAtResponse: [ThreadMode] = []
    var responseRelease: CheckedContinuation<Void, Never>?
    func holdQueueCheck() { holdsQueueCheck = true }
    func releaseQueueCheck() {
        holdsQueueCheck = false
        queueCheckRelease?.resume()
        queueCheckRelease = nil
    }
    func holdResponse() { holdsResponse = true }
    func releaseResponse() {
        holdsResponse = false
        responseRelease?.resume()
        responseRelease = nil
    }
    func allowModeChanges() { modeWorks = true }
    func reportMode(_ mode: ThreadMode?) { modeReply = mode }
    func refuseModeChanges() { modeWorks = false }
    func holdMode() { holdsMode = true }
    func releaseMode() {
        holdsMode = false
        modeRelease?.resume()
        modeRelease = nil
    }
    func configure(create: Bool? = nil, open: Bool? = nil, snapshot: ThreadSnapshot? = nil, sendFails: Bool? = nil) {
        if let create { createWorks = create }
        if let open { openWorks = open }
        if let snapshot { self.snapshot = snapshot }
        if let sendFails { self.sendFails = sendFails }
    }
    func connect() async throws {}
    func disconnect() async {}
    func suspend() async {}
    func resume() async {}
    func listAgents() async throws -> [Agent] { [] }
    func blockPromotion(at directory: URL) { promotionBlock = directory }
    func holdCreate() { holdsCreate = true }
    func releaseCreate() {
        holdsCreate = false
        createRelease?.resume()
        createRelease = nil
    }
    func holdNextSend() { holdsNextSend = true }
    func releaseSend() {
        sendRelease?.resume()
        sendRelease = nil
    }
    func holdNextCommand() { holdsNextCommand = true }
    func releaseCommand() {
        commandRelease?.resume()
        commandRelease = nil
    }
    func createThread(with agent: Agent.ID, options: ThreadOptions) async throws -> ThreadRef {
        creates += 1
        guard createWorks else { throw AgentBackendError.notConnected }
        if holdsCreate { await withCheckedContinuation { createRelease = $0 } }
        if let directory = promotionBlock {
            promotionBlock = nil
            try FileManager.default.moveItem(at: directory, to: directory.appendingPathExtension("backup"))
            try Data([0]).write(to: directory)
        }
        return ThreadRef(id: .init(rawValue: "real-thread"), agent: agent)
    }
    func openThread(_ thread: ThreadRef) async throws -> ThreadSnapshot {
        guard openWorks else { throw AgentBackendError.notConnected }
        return snapshot
    }
    func events(for thread: ThreadRef.ID) async -> AsyncStream<ThreadEvent> {
        follows += 1
        let (stream, continuation) = AsyncStream<ThreadEvent>.makeStream()
        eventContinuations[thread] = continuation
        return stream
    }
    func emit(_ event: ThreadEvent, to thread: ThreadRef.ID) { eventContinuations[thread]?.yield(event) }
    func send(_ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, to thread: ThreadRef.ID) async throws -> SendReceipt {
        sent.append((text, images, files))
        modesAtSend.append(currentMode)
        if holdsNextSend {
            holdsNextSend = false
            await withCheckedContinuation { sendRelease = $0 }
        }
        if sendFails { throw AgentBackendError.notConnected }
        return SendReceipt(.started)
    }
    func interrupt(_ thread: ThreadRef.ID) async throws -> Bool { false }
    func respond(to request: PendingRequest.ID, in thread: ThreadRef.ID, with answer: RequestAnswer) async throws {
        responses += 1
        modesAtResponse.append(currentMode)
        if holdsResponse { await withCheckedContinuation { responseRelease = $0 } }
    }
}

extension RecoveryBackend: ModeSelecting {
    var offersModes: Bool? { true }
    func setMode(_ mode: ThreadMode, in thread: ThreadRef.ID) async throws -> ModeState {
        selectedModes.append(mode)
        if holdsMode { await withCheckedContinuation { modeRelease = $0 } }
        guard modeWorks else { throw AgentBackendError.notConnected }
        currentMode = modeReply ?? mode
        return ModeState(mode: currentMode, defaultsTo: .ask)
    }
}

/// Its commands are Hermes skills: each stands for instructions sent to the agent, shown
/// as the command that asked for them.
extension RecoveryBackend: CommandRunning {
    func commandCatalog(for agent: Agent.ID) async throws -> CommandCatalog { CommandCatalog() }
    func runCommand(_ command: SlashInput, in thread: ThreadRef.ID) async throws -> CommandOutcome {
        commandRuns += 1
        if holdsNextCommand {
            holdsNextCommand = false
            await withCheckedContinuation { commandRelease = $0 }
        }
        return .message("skill instructions for \(command.argument)", shownAs: "/\(command.name) \(command.argument)", note: nil)
    }
}

extension RecoveryBackend: QueueControlling {
    var listsQueue: Bool? {
        get async {
            queueChecks += 1
            if holdsQueueCheck { await withCheckedContinuation { queueCheckRelease = $0 } }
            return nil
        }
    }
    func removeQueued(_ id: String, in thread: ThreadRef.ID) async throws -> Bool { false }
    func steerQueued(_ id: String, in thread: ThreadRef.ID) async throws -> QueueSteerOutcome {
        queuedActionModes.append(currentMode)
        return .steered
    }
    func placeQueued(_ id: String, at placement: WhenBusy, in thread: ThreadRef.ID) async throws -> QueuePlaceOutcome {
        queuedActionModes.append(currentMode)
        return .moved
    }
}

@main struct NativeRecoveryTests {
    static func existingModeFixture(root: URL, agent: Agent, name: String) async throws -> (ThreadController, RecoveryBackend, ThreadStore) {
        let store = ThreadStore(directory: root.appendingPathComponent(name))
        let backend = RecoveryBackend()
        var snapshot = ThreadSnapshot()
        snapshot.mode = ModeState(mode: .full)
        await backend.configure(snapshot: snapshot)
        await backend.allowModeChanges()
        let offerings = AgentOfferings()
        offerings.models = ModelCatalog(providers: [], agentDefault: ModelSetting(model: "test"), defaultMode: ModeState(mode: .full))
        let ref = ThreadRef(id: .init(rawValue: "existing-\(name)"), agent: agent.id)
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, offerings: offerings, existing: ref)
        chat.prepare()
        try await eventually { await backend.follows == 1 && !chat.isLoadingHistory }
        await backend.holdMode()
        return (chat, backend, store)
    }

    static func anExistingModeMustPrecedeSend(root: URL, agent: Agent, file: FileAttachment, command: Bool) async throws {
        let (chat, backend, _) = try await existingModeFixture(root: root, agent: agent, name: command ? "mode-command" : "mode-send")
        chat.pickMode(.ask)
        try await eventually { await backend.selectedModes == [.ask] }
        if command { chat.send("/review the diff") } else { chat.send("Ask before acting", files: [file]) }
        try await Task.sleep(for: .milliseconds(100))
        let before = await backend.sent.count
        let commandsBefore = await backend.commandRuns
        precondition(before == 0 && commandsBefore == 0, "an existing-thread send overtook its pending mode change and ran under Full access")
        await backend.releaseMode()
        try await eventually { chat.savedConversation?.submissions.last?.accepted == true }
        let modes = await backend.modesAtSend
        precondition(modes == [.ask])
        if !command {
            let files = await backend.sent.first?.2
            precondition(files == [file], "waiting for the mode discarded the attachment")
        }
        chat.close()
        print("PASS an existing-thread \(command ? "command" : "attachment send") waits for its mode acknowledgement")
    }

    static func aModePickedDuringSendPreparationMustPrecedeSend(root: URL, agent: Agent, file: FileAttachment, responding: Bool) async throws {
        let (chat, backend, _) = try await existingModeFixture(root: root, agent: agent, name: responding ? "mode-during-response" : "mode-during-queue-check")
        if responding {
            let approval = PendingRequest(id: "mode-preparation-approval", kind: .approval(ApprovalRequest(command: "test command")))
            await backend.emit(.requestOpened(approval), to: chat.thread!.id)
            try await eventually { chat.pendingRequest?.id == approval.id }
            await backend.holdResponse()
        } else {
            await backend.holdQueueCheck()
        }
        chat.send("Use the mode I picked while preparing", files: [file])
        try await eventually {
            if responding { return await backend.responses == 1 }
            return await backend.queueChecks == 1
        }
        chat.pickMode(.ask)
        try await eventually { await backend.selectedModes == [.ask] }
        if responding { await backend.releaseResponse() } else { await backend.releaseQueueCheck() }
        try await Task.sleep(for: .milliseconds(100))
        let before = await backend.sent.count
        precondition(before == 0, "a mode picked during send preparation was overtaken by native input under Full access")
        await backend.releaseMode()
        try await eventually { chat.savedConversation?.submissions.last?.accepted == true }
        let modes = await backend.modesAtSend
        let files = await backend.sent.first?.2
        precondition(modes == [.ask] && files == [file])
        chat.close()
        print("PASS a mode picked during \(responding ? "request cancellation" : "queue capability lookup") is confirmed before send")
    }

    static func aJournalOnlyModeChoiceNotifiesItsOwner(root: URL, agent: Agent) async throws {
        let (chat, backend, _) = try await existingModeFixture(root: root, agent: agent, name: "mode-owner")
        var owned: SavedConversation?
        chat.onPersist = { owned = $0.savedConversation }
        chat.pickMode(.ask)
        precondition(owned?.pendingInitialMode == .ask && owned?.thread == chat.thread,
                     "a journal-only mode choice was not retained by its owner's in-memory recovery map")
        try await eventually { await backend.selectedModes == [.ask] }
        await backend.releaseMode()
        try await eventually { chat.savedConversation?.pendingInitialMode == nil && owned?.pendingInitialMode == nil }
        chat.close()
        print("PASS the owner retains a journal-only mode choice until its acknowledgement")
    }

    static func anAnswerWaitsForMode(root: URL, agent: Agent, refusal: Bool) async throws {
        let (chat, backend, _) = try await existingModeFixture(root: root, agent: agent, name: refusal ? "mode-answer-refused" : "mode-answer")
        let request = PendingRequest(id: "mode-answer", kind: .clarify([ClarifyQuestion(id: "next", text: "What next?")]), askedAhead: true)
        await backend.emit(.requestOpened(request), to: chat.thread!.id)
        try await eventually { chat.pendingRequest?.id == request.id }
        chat.pickMode(.ask)
        try await eventually { await backend.selectedModes == [.ask] }
        chat.answer(request, with: .clarify(["next": "Continue with my chosen mode"]))
        try await Task.sleep(for: .milliseconds(100))
        let before = await backend.responses
        precondition(before == 0, "an answer that resumes work overtook its pending mode choice")
        if refusal { await backend.refuseModeChanges() }
        await backend.releaseMode()
        if refusal {
            try await eventually { chat.pendingRequest?.id == request.id }
            let after = await backend.responses
            precondition(after == 0 && chat.savedConversation?.pendingInitialMode == .ask)
        } else {
            try await eventually { await backend.responses == 1 }
            let modes = await backend.modesAtResponse
            precondition(modes == [.ask])
        }
        chat.close()
        print("PASS an answer \(refusal ? "reopens its card when mode confirmation fails" : "waits for mode confirmation")")
    }

    static func anExistingModeFailureSurvivesRelaunch(root: URL, agent: Agent, file: FileAttachment) async throws {
        let (chat, backend, store) = try await existingModeFixture(root: root, agent: agent, name: "existing-mode-recovery")
        chat.pickMode(.ask)
        try await eventually { await backend.selectedModes == [.ask] }
        chat.send("Retain my Ask intent", files: [file])
        await backend.refuseModeChanges()
        await backend.releaseMode()
        try await eventually { !chat.isSending && chat.savedConversation?.submissions.last?.failure != nil }
        let before = await backend.sent.count
        precondition(before == 0 && chat.mode?.mode == .ask, "a failed existing-thread mode change lost intent or sent under Full")
        let journal = SubmissionStore(threads: store)
        let saved = journal.load().first!
        precondition(saved.pendingInitialMode == .ask && saved.thread == chat.thread)
        precondition(journal.file(file.reference, in: saved.id)?.data == file.data)
        chat.close()
        let restoredBackend = RecoveryBackend()
        await restoredBackend.allowModeChanges()
        let restored = ThreadController(agent: agent, backend: restoredBackend, imageStore: store, recovery: saved)
        restored.prepare()
        try await eventually { await restoredBackend.follows == 1 && restored.savedConversation?.pendingInitialMode == nil }
        let automatic = await restoredBackend.sent.count
        precondition(automatic == 0, "relaunch automatically retried an unconfirmed message")
        restored.retry(restored.turns.last!.id)
        try await eventually { restored.savedConversation?.submissions.last?.accepted == true }
        let modes = await restoredBackend.modesAtSend
        let files = await restoredBackend.sent.first?.2
        precondition(modes == [.ask] && files == [file])
        restored.close()
        print("PASS a failed existing-thread mode retains its intent and attachment for manual retry after relaunch")
    }

    static func aNewerExistingModePrecedesSend(root: URL, agent: Agent) async throws {
        let (chat, backend, _) = try await existingModeFixture(root: root, agent: agent, name: "existing-mode-latest")
        chat.pickMode(.ask)
        try await eventually { await backend.selectedModes == [.ask] }
        chat.send("Use my latest choice")
        chat.pickMode(.plan)
        precondition(chat.mode?.mode == .plan)
        try await Task.sleep(for: .milliseconds(100))
        let before = await backend.selectedModes
        let sentBefore = await backend.sent.count
        precondition(before == [.ask] && sentBefore == 0, "existing-thread mode changes overlapped or were overtaken by send")
        await backend.releaseMode()
        try await eventually { chat.savedConversation?.submissions.last?.accepted == true }
        let applied = await backend.selectedModes
        let modes = await backend.modesAtSend
        precondition(applied == [.ask, .plan] && modes == [.plan], "a late acknowledgement erased a newer existing-thread choice")
        chat.close()
        print("PASS a newer existing-thread mode choice is applied in order before send")
    }

    static func queuedSendWaitsForMode(root: URL, agent: Agent, placement: Bool) async throws {
        let (chat, backend, _) = try await existingModeFixture(root: root, agent: agent, name: placement ? "mode-placement" : "mode-steer")
        await backend.emit(.queueChanged([QueuedMessage(id: "waiting", text: "queued", placement: .queue)], canSteer: true, steered: nil), to: chat.thread!.id)
        try await eventually { chat.state.queued.count == 1 }
        chat.pickMode(.ask)
        try await eventually { await backend.selectedModes == [.ask] }
        if placement { chat.placeQueued("waiting", at: .steer) } else { chat.steerQueued("waiting") }
        try await Task.sleep(for: .milliseconds(100))
        let before = await backend.queuedActionModes
        precondition(before.isEmpty, "a queued-message action overtook its pending mode change")
        await backend.releaseMode()
        try await eventually { await backend.queuedActionModes == [.ask] }
        chat.close()
        print("PASS queued-message \(placement ? "placement" : "steering") waits for its mode acknowledgement")
    }

    static func aDifferentModeReplyNeverSends(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("different-mode-reply"))
        let backend = RecoveryBackend()
        await backend.configure(create: true)
        await backend.allowModeChanges()
        await backend.reportMode(.full)
        let offerings = AgentOfferings()
        offerings.models = ModelCatalog(providers: [], agentDefault: ModelSetting(model: "test"), defaultMode: ModeState(mode: .full))
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, offerings: offerings)
        chat.pickMode(.ask)
        chat.send("Wait for the mode I chose")
        try await eventually { !chat.isSending }
        let sent = await backend.sent.count
        precondition(sent == 0, "a mismatched mode acknowledgement sent under Full access")
        precondition(chat.savedConversation?.pendingInitialMode == .ask && chat.mode?.mode == .ask)
        precondition(SubmissionStore(threads: store).load().first?.pendingInitialMode == .ask)
        await backend.reportMode(nil)
        chat.retry(chat.turns.first!.id)
        try await eventually { chat.savedConversation?.submissions.last?.accepted == true }
        let modes = await backend.modesAtSend
        precondition(modes == [.ask] && chat.savedConversation?.pendingInitialMode == nil)
        chat.close()
        print("PASS a different acknowledged mode retains intent and blocks send until manual retry confirms it")
    }

    static func aFailedInitialModeNeverSends(root: URL, agent: Agent, file: FileAttachment) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("initial-mode-failure"))
        let journal = SubmissionStore(threads: store)
        let backend = RecoveryBackend()
        await backend.configure(create: true)
        let offerings = AgentOfferings()
        offerings.models = ModelCatalog(providers: [], agentDefault: ModelSetting(model: "test"), defaultMode: ModeState(mode: .full))
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, offerings: offerings)
        chat.pickMode(.ask)
        chat.send("Ask before changing files", files: [file])
        try await eventually { !chat.isSending }
        let sentBefore = await backend.sent.count
        precondition(sentBefore == 0, "a failed initial mode change still sent the message under Full access")
        precondition(chat.savedConversation?.submissions.last?.failure != nil)
        let saved = journal.load().first!
        precondition(saved.pendingInitialMode == .ask && chat.mode?.mode == .ask)
        precondition(journal.file(file.reference, in: saved.id)?.data == file.data)
        chat.retry(chat.turns.first!.id)
        try await eventually { await backend.selectedModes.count >= 2 }
        try await eventually { !chat.isSending && chat.canRetry }
        let sentAfterRetry = await backend.sent.count
        precondition(sentAfterRetry == 0, "retry bypassed the failed initial mode change")
        chat.close()

        let recovered = journal.load().first!
        precondition(recovered.pendingInitialMode == .ask)
        let next = RecoveryBackend()
        var snapshot = ThreadSnapshot()
        snapshot.mode = ModeState(mode: .full)
        await next.configure(create: true, snapshot: snapshot)
        await next.allowModeChanges()
        let restored = ThreadController(agent: agent, backend: next, imageStore: store, offerings: offerings, recovery: recovered)
        restored.prepare()
        try await eventually { restored.followsHost && !restored.isLoadingHistory }
        restored.retry(restored.turns.last!.id)
        try await eventually { restored.savedConversation?.submissions.last?.accepted == true }
        let sentModes = await next.modesAtSend
        let creates = await next.creates
        precondition(sentModes == [.ask] && creates == 0, "relaunch lost the chosen mode or created a new thread")
        let sentFile = await next.sent.first?.2.first
        precondition(sentFile == file)
        precondition(restored.savedConversation?.pendingInitialMode == nil)
        restored.close()
        print("PASS an initial mode failure blocks send and retry; relaunch restores mode and payload")
    }

    static func modeSurvivesAnUncreatedRecovery(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("uncreated-mode"))
        let journal = SubmissionStore(threads: store)
        let offerings = AgentOfferings()
        offerings.models = ModelCatalog(providers: [], agentDefault: ModelSetting(model: "test"), defaultMode: ModeState(mode: .full))
        let chat = ThreadController(agent: agent, backend: RecoveryBackend(), imageStore: store, offerings: offerings)
        chat.pickMode(.ask)
        chat.send("Keep my pending mode")
        try await eventually { !chat.isSending }
        let recovery = journal.load().first!
        precondition(recovery.thread == nil && recovery.pendingInitialMode == .ask)
        chat.close()
        let backend = RecoveryBackend()
        await backend.configure(create: true)
        await backend.allowModeChanges()
        let restored = ThreadController(agent: agent, backend: backend, imageStore: store, offerings: offerings, recovery: recovery)
        restored.retry(restored.turns.first!.id)
        try await eventually { restored.savedConversation?.submissions.last?.accepted == true }
        let sentModes = await backend.modesAtSend
        precondition(sentModes == [.ask], "retry overwrote a recovered mode before creation")
        restored.close()
        print("PASS a pending mode survives relaunch before the host thread was created")
    }

    static func aNewerModeChoicePrecedesTheFirstSend(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("changed-initial-mode"))
        let backend = RecoveryBackend()
        await backend.configure(create: true)
        await backend.allowModeChanges()
        await backend.holdMode()
        let offerings = AgentOfferings()
        offerings.models = ModelCatalog(providers: [], agentDefault: ModelSetting(model: "test"), defaultMode: ModeState(mode: .full))
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, offerings: offerings)
        chat.pickMode(.ask)
        chat.send("Use my latest choice")
        try await eventually { await backend.selectedModes == [.ask] }
        chat.pickMode(.plan)
        precondition(chat.mode?.mode == .plan)
        await backend.releaseMode()
        try await eventually { chat.savedConversation?.submissions.last?.accepted == true }
        let applied = await backend.selectedModes
        let sentModes = await backend.modesAtSend
        precondition(applied == [.ask, .plan] && sentModes == [.plan], "a late mode acknowledgement erased a newer choice")
        chat.close()
        print("PASS changing the initial mode while its acknowledgement waits takes effect before send")
    }

    static func texts(_ transcript: Transcript) -> [String] {
        transcript.turns.flatMap(\.items).compactMap {
            if case let .user(message) = $0.content { message.text } else { nil }
        }
    }
    static func finished(_ text: String) -> Turn {
        Turn(outcome: .completed, items: [TurnItem(.user(UserMessage(text: text, delivery: .started))), TurnItem(.text("answer"))])
    }
    static func eventually(_ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await condition()) {
            precondition(ContinuousClock.now < deadline, "recovery test timed out")
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    static func failedStagingKeepsNetworkOrder(root: URL, agent: Agent, file: FileAttachment) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("staging-order"))
        let journal = SubmissionStore(threads: store)
        let backend = RecoveryBackend()
        await backend.configure(create: true)
        await backend.holdNextSend()
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store)
        chat.onPersist = { _ = $0.persistRecovery() }
        chat.send("A held at send")
        try await eventually { await backend.sent.count == 1 }
        let blockedFile = journal.directory.appendingPathComponent(chat.localID.uuidString).appendingPathComponent(file.id.uuidString)
        try FileManager.default.createDirectory(at: blockedFile, withIntermediateDirectories: true)
        chat.send("B cannot stage", files: [file])
        chat.send("C follows both")
        // Let the independent, local disk tasks finish while A remains held.
        try await Task.sleep(for: .milliseconds(100))
        let beforeRelease = await backend.sent.map(\.0)
        precondition(beforeRelease == ["A held at send"], "a staging failure let a later send overtake the held predecessor")
        await backend.releaseSend()
        try await eventually { await backend.sent.count == 2 }
        let afterRelease = await backend.sent.map(\.0)
        precondition(afterRelease == ["A held at send", "C follows both"])
        try await eventually { chat.savedConversation?.submissions.first(where: { $0.text == "B cannot stage" })?.failure != nil }
        chat.close()
        print("PASS a failed staging attempt cannot let a later send overtake its predecessor")
    }

    static func unstagedFilesRemainRetryable(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("unstaged-retention"))
        let journal = SubmissionStore(threads: store)
        let backend = RecoveryBackend()
        let ref = ThreadRef(id: .init(rawValue: "existing-unstaged"), agent: agent.id)
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, existing: ref)
        chat.onPersist = { _ = $0.persistRecovery() }
        chat.prepare()
        try await eventually { chat.followsHost && !chat.isLoadingHistory }
        var failed: [(turn: UUID, file: FileAttachment, blocked: URL)] = []
        for number in 1...3 {
            let file = FileAttachment(data: Data(repeating: UInt8(number), count: 25 * 1024 * 1024), filename: "large-\(number).bin")
            let blocked = journal.directory.appendingPathComponent(chat.localID.uuidString).appendingPathComponent(file.id.uuidString)
            try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
            let text = "unstaged large file \(number)"
            chat.send(text, files: [file])
            try await eventually { chat.savedConversation?.submissions.last?.failure != nil }
            let turn = chat.turns.last!.id
            failed.append((turn, file, blocked))
            precondition(!chat.isAtRest, "the owner must not evict the only copy of unstaged file bytes")
            precondition(journal.load().allSatisfy { $0.submissions.allSatisfy { $0.message.files.isEmpty } })
        }
        // Three 25 MiB attempts evict the first file from the 64 MiB sent-file cache.
        // Only the unstaged payload owner can supply the first manual retry now.
        for (index, attempt) in failed.enumerated() {
            try FileManager.default.removeItem(at: attempt.blocked)
            chat.retry(attempt.turn)
            try await eventually { await backend.sent.count == index + 1 }
            let sent = await backend.sent[index]
            precondition(sent.2 == [attempt.file] && chat.screenRequest == nil)
            await backend.emit(.turnFinished(.completed, finalText: nil), to: ref.id)
            try await eventually { !chat.isRunning }
        }
        precondition(chat.isAtRest, "successfully restaged attempts must stop retaining the controller")
        chat.close()
        print("PASS unstaged files survive idle eviction and file-cache eviction, then release after manual restaging")
    }
    /// A new thread's first message is not an unsent draft (nor one to discard) while
    /// it is being created and sent; it is once that has failed.
    static func aMessageOnItsWayIsNoDraft(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("on-its-way"))
        let backend = RecoveryBackend()
        await backend.configure(create: true, sendFails: true)
        await backend.holdCreate()
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store)
        chat.onPersist = { _ = $0.persistRecovery() }
        chat.send("first message, being created")
        try await eventually { await backend.creates == 1 }
        precondition(chat.isSending, "a first message being created is on its way")
        precondition(chat.savedConversation?.isRecoverableDraft(listed: [], sending: chat.isSending) == false,
                     "a conversation whose first message is being created is listed as an unsent draft")
        await backend.releaseCreate()
        try await eventually { !chat.isSending }
        precondition(chat.savedConversation?.submissions.first?.failure != nil)
        precondition(chat.savedConversation?.isRecoverableDraft(listed: [], sending: chat.isSending) == true)
        chat.close()
        print("PASS a first message on its way is not an unsent draft until it fails")
    }

    /// A thread made again from its saved copy and its journal (after it was let go, or a
    /// relaunch): what never reached the host goes at the end, where it was sent; what
    /// the host queued is not relabelled as not confirmed, and leaves the journal once
    /// the host's list no longer has it.
    static func recoveredMessagesGoWhereTheyWereSent(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("placement"))
        let backend = RecoveryBackend()
        let ref = ThreadRef(id: .init(rawValue: "placed"), agent: agent.id)
        var journal = SavedConversation(agent: agent.id)
        journal.thread = ref
        var queued = SavedSubmission(id: UUID(), text: "do X next", message: UserMessage(text: "do X next"))
        queued.accepted = true
        queued.queueID = "q1"
        let lost = SavedSubmission(id: UUID(), text: "sent as the app was ended", message: UserMessage(text: "sent as the app was ended"))
        journal.submissions = [queued, lost]
        let saved = Transcript(turns: [finished("one"), finished("two")])
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, existing: ref, cached: saved, recovery: journal)
        precondition(texts(chat.state.transcript) == ["one", "two", "sent as the app was ended"],
                     "recovered messages must follow the saved thread, got \(texts(chat.state.transcript))")
        guard case .failed = chat.turns.last?.outcome else { preconditionFailure("an unconfirmed message must be retryable") }
        precondition(chat.state.pending.map(\.queueID) == ["q1"], "a message the host queued waits as queued, not as a failed turn")
        // Reopened: the host ran it meanwhile, under its own id, and lists nothing waiting.
        await backend.configure(open: true, snapshot: ThreadSnapshot(
            transcript: Transcript(turns: [finished("one"), finished("two"), finished("do X next")]), queued: []))
        chat.onPersist = { _ = $0.persistRecovery() }
        chat.prepare()
        try await eventually { chat.state.pending.isEmpty }
        chat.finishRecoveryAfterSaving()
        precondition(chat.savedConversation?.submissions.map(\.id) == [lost.id], "a message the host ran must leave the journal")
        precondition(texts(chat.state.transcript).filter { $0 == "do X next" }.count == 1, "the queued message must show once, as the host ran it")
        chat.close()
        print("PASS recovered messages go where they were sent; queued ones wait, then leave the journal")
    }

    /// The host took a skill's instructions (so the journal let them go), then the run
    /// failed. Try again runs the skill again, never sending the command's name as a
    /// plain message.
    static func retryingASkillRunsItAgain(root: URL, agent: Agent) async throws {
        let store = ThreadStore(directory: root.appendingPathComponent("skill"))
        let backend = RecoveryBackend()
        let ref = ThreadRef(id: .init(rawValue: "skill-thread"), agent: agent.id)
        let oldActivity = Date(timeIntervalSince1970: 1)
        let chat = ThreadController(agent: agent, backend: backend, imageStore: store, existing: ref, lastActivity: oldActivity)
        var history = RecentThreads()
        var submissions = 0
        chat.onSend = { controller in
            precondition(controller.lastActivity > oldActivity, "remember deferred sends after their activity advances")
            submissions += 1
            if let key = controller.thread?.key { history.open(key) }
        }
        // As the host's model does: the journal is settled once the thread is saved.
        chat.onPersist = { chat in
            precondition(chat.persistRecovery())
            chat.finishRecoveryAfterSaving()
        }
        chat.prepare()
        try await eventually { await backend.follows == 1 && chat.followsHost }
        precondition(history.keys.isEmpty, "restoring a tab must not restore dismissed Recent history")
        chat.send("   ")
        precondition(submissions == 0)
        await backend.holdNextCommand()
        chat.send("/review the diff")
        try await eventually { await backend.commandRuns == 1 }
        precondition(history.keys.isEmpty && submissions == 0, "a deferred command must not remember a stale activity time")
        await backend.releaseCommand()
        try await eventually { await backend.sent.count == 1 && chat.savedConversation == nil }
        precondition(history.keys.contains(ref.key) && submissions == 1 && chat.sentHere == 1)
        history.dismiss(ref.key)
        await backend.emit(.turnFinished(.failed(TurnFailure(message: "provider error")), finalText: nil), to: ref.id)
        try await eventually { !chat.isRunning }
        precondition(history.keys.isEmpty, "a passive save must not restore a dismissed entry")
        precondition(texts(chat.state.transcript) == ["/review the diff"])
        chat.retry(chat.turns.last!.id)
        try await eventually { await backend.sent.count == 2 }
        let sent = await backend.sent.map(\.0)
        precondition(sent == ["skill instructions for the diff", "skill instructions for the diff"],
                     "retrying a skill must run it again, not send its name: \(sent)")
        let runs = await backend.commandRuns
        precondition(runs == 2, "the skill must have run twice, ran \(runs)")
        precondition(history.keys.contains(ref.key) && submissions == 2 && chat.sentHere == 2, "retry must remember the conversation once")
        chat.close()
        print("PASS retrying a skill whose journal entry was settled runs the skill again")
    }

    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ThreadStore(directory: root)
        let journal = SubmissionStore(threads: store)
        let backend = RecoveryBackend()
        let agent = Agent(id: .init(host: backend.host, name: "agent"))
        let image = ImageAttachment(data: Data([1, 2]), filename: "photo.jpg")
        let file = FileAttachment(data: Data([3, 4]), filename: "notes.txt")
        try await aModePickedDuringSendPreparationMustPrecedeSend(root: root, agent: agent, file: file, responding: false)
        try await aModePickedDuringSendPreparationMustPrecedeSend(root: root, agent: agent, file: file, responding: true)
        try await aJournalOnlyModeChoiceNotifiesItsOwner(root: root, agent: agent)
        try await anAnswerWaitsForMode(root: root, agent: agent, refusal: false)
        try await anAnswerWaitsForMode(root: root, agent: agent, refusal: true)
        try await anExistingModeMustPrecedeSend(root: root, agent: agent, file: file, command: false)
        try await anExistingModeMustPrecedeSend(root: root, agent: agent, file: file, command: true)
        try await anExistingModeFailureSurvivesRelaunch(root: root, agent: agent, file: file)
        try await aNewerExistingModePrecedesSend(root: root, agent: agent)
        try await queuedSendWaitsForMode(root: root, agent: agent, placement: false)
        try await queuedSendWaitsForMode(root: root, agent: agent, placement: true)
        var controller: ThreadController? = ThreadController(agent: agent, backend: backend, imageStore: store)
        var saves = 0
        controller?.onPersist = { chat in
            saves += 1
            precondition(chat.persistRecovery())
        }
        controller?.send("offline first message", images: [image], files: [file])
        try await eventually { controller?.state.transcript.turns.first?.outcome != nil }
        precondition(controller?.thread == nil && saves >= 2)
        let saved = journal.load().first!
        precondition(saved.submissions.first?.failure != nil)
        precondition(journal.image(image.reference, in: saved.id)?.data == image.data)
        precondition(journal.file(file.reference, in: saved.id)?.data == file.data)
        controller?.close()
        let isReleased = { [weak controller] in controller == nil }
        controller = nil
        try await eventually(isReleased)
        print("PASS pre-create failure survives navigation and controller release")

        await backend.configure(create: true)
        let restored = ThreadController(agent: agent, backend: backend, options: saved.options, imageStore: store, recovery: saved)
        precondition(texts(restored.state.transcript) == ["offline first message"])
        restored.onPersist = { chat in
            precondition(chat.persistRecovery())
            if let ref = chat.thread { precondition(store.saveTranscript(chat.state.transcript, for: ref.key)) }
        }
        let turnsBeforeRetry = restored.turns.count
        restored.retry(restored.turns.first!.id)
        // The bytes are only on disk now: they are read off the main actor, so the retry
        // is not under way yet, and cannot be tapped twice meanwhile.
        precondition(restored.turns.count == turnsBeforeRetry && !restored.canRetry,
                     "Try again must not read attachment bytes on the main actor")
        try await eventually { restored.savedConversation?.submissions.last?.accepted == true }
        let sent = await backend.sent[0]
        precondition(sent.0 == "offline first message" && sent.1 == [image] && sent.2 == [file])
        precondition(journal.load().first?.thread?.id.rawValue == "real-thread")
        restored.finishRecoveryAfterSaving()
        // The retry was accepted: the failed original is settled, and neither attempt's
        // bytes are kept any more.
        precondition(!journal.load().contains { $0.id == saved.id }, "a failed original must leave the journal once its retry is accepted")
        precondition(journal.file(file.reference, in: saved.id) == nil, "attachment bytes of a settled retry must not pile up")
        precondition(restored.savedConversation == nil)
        restored.close()
        print("PASS relaunch and manual retry preserve full payload and real thread binding, then release the journal")

        let ref = ThreadRef(id: .init(rawValue: "existing"), agent: agent.id)
        await backend.configure(open: false)
        let held = ThreadController(agent: agent, backend: backend, imageStore: store, existing: ref, cached: Transcript(turns: [finished("shared")]))
        held.onPersist = { chat in
            precondition(chat.persistRecovery())
            precondition(store.saveTranscript(chat.state.transcript, for: ref.key))
        }
        held.send("held message", files: [file])
        try await eventually { held.state.pending.isEmpty && held.state.transcript.turns.count == 2 }
        precondition(texts(store.loadTranscript(for: ref.key)!).contains("held message"))
        held.close()
        print("PASS failed reopen keeps and persists the pending submission")

        var local = ThreadState(transcript: Transcript(turns: [finished("shared")]))
        let id = local.messageSent("phone failure")
        local.messageFailed(id, TurnFailure(message: "offline"))
        await backend.configure(open: true, snapshot: ThreadSnapshot(transcript: Transcript(turns: [finished("shared"), finished("Mac success")])))
        let merged = ThreadController(agent: agent, backend: backend, imageStore: store, existing: ref, cached: local.transcript)
        var didSave = false
        merged.onPersist = { chat in
            precondition(store.saveTranscript(chat.state.transcript, for: ref.key))
            didSave = true
        }
        merged.prepare()
        try await eventually { didSave }
        let kept = texts(store.loadTranscript(for: ref.key)!)
        precondition(kept.contains("phone failure") && kept.contains("Mac success"))
        merged.close()
        print("PASS actual controller adoption persists both local failure and remote success")

        await backend.configure(sendFails: true)
        let staged = ThreadController(agent: agent, backend: backend, imageStore: store)
        staged.onPersist = { chat in precondition(chat.persistRecovery()) }
        staged.send("upload interrupted", files: [file])
        try await eventually { staged.savedConversation?.submissions.last?.failure != nil }
        let stagedRecord = journal.load().first { $0.id == staged.localID }!
        precondition(stagedRecord.thread != nil)
        precondition(journal.file(file.reference, in: stagedRecord.id)?.data == file.data)
        precondition(texts(stagedRecord.recoveredTranscript) == ["upload interrupted"])
        staged.close()
        print("PASS send-boundary failure remains a manual full-payload recovery")

        let promotionRoot = root.appendingPathComponent("promotion")
        let promotionDirectory = promotionRoot.appendingPathComponent("submissions")
        let promotionBackend = RecoveryBackend()
        await promotionBackend.configure(create: true)
        await promotionBackend.blockPromotion(at: promotionDirectory)
        let promotion = ThreadController(agent: agent, backend: promotionBackend, imageStore: ThreadStore(directory: promotionRoot))
        promotion.onPersist = { chat in _ = chat.persistRecovery() }
        promotion.send("retry after promotion write failure")
        try await eventually { promotion.savedConversation?.submissions.first?.failure != nil }
        precondition(promotion.thread != nil)
        try FileManager.default.removeItem(at: promotionDirectory)
        try FileManager.default.moveItem(at: promotionDirectory.appendingPathExtension("backup"), to: promotionDirectory)
        promotion.retry(promotion.turns.first!.id)
        try await eventually { promotion.savedConversation?.submissions.last?.accepted == true }
        try await eventually { await promotionBackend.follows == 1 }
        let promotionCreates = await promotionBackend.creates
        precondition(promotionCreates == 1, "retry must reopen the created thread, not create another")
        await promotionBackend.emit(.textDelta("streamed reply"), to: promotion.thread!.id)
        try await eventually {
            promotion.turns.last?.items.contains {
                if case let .text(text) = $0.content { text == "streamed reply" } else { false }
            } == true
        }
        let approval = PendingRequest(id: "promotion-approval", kind: .approval(ApprovalRequest(command: "test command")))
        await promotionBackend.emit(.requestOpened(approval), to: promotion.thread!.id)
        try await eventually { promotion.pendingRequest?.id == approval.id }
        await promotionBackend.emit(.requestClosed(id: approval.id, reason: "answered elsewhere"), to: promotion.thread!.id)
        await promotionBackend.emit(.turnFinished(.completed, finalText: "streamed reply"), to: promotion.thread!.id)
        try await eventually { !promotion.isRunning && promotion.pendingRequest == nil }
        promotion.close()
        print("PASS retry after promotion write failure follows reply, approval, and completion without recreating")

        let heldRoot = root.appendingPathComponent("held-payloads")
        let heldStore = ThreadStore(directory: heldRoot)
        let heldJournal = SubmissionStore(threads: heldStore)
        let heldBackend = RecoveryBackend()
        await heldBackend.configure(create: true)
        await heldBackend.holdCreate()
        let heldPayloads = ThreadController(agent: agent, backend: heldBackend, imageStore: heldStore)
        heldPayloads.onPersist = { chat in
            precondition(chat.persistRecovery())
            for conversation in heldJournal.load() {
                for submission in conversation.submissions {
                    for ref in submission.message.files {
                        precondition(heldJournal.file(ref, in: conversation.id) != nil, "journal published a file before its bytes")
                    }
                }
            }
        }
        heldPayloads.send("first network request is held")
        try await eventually { await heldBackend.creates == 1 }
        heldPayloads.send("second message is durable independently", files: [file])
        try await eventually { heldJournal.load().first?.submissions.count == 2 }
        let whileHeld = heldJournal.load().first!
        precondition(heldJournal.file(file.reference, in: whileHeld.id)?.data == file.data)
        let relaunched = ThreadController(agent: agent, backend: heldBackend, imageStore: heldStore, recovery: whileHeld)
        precondition(texts(relaunched.state.transcript).contains("second message is durable independently"))
        relaunched.close()
        heldPayloads.close()
        await heldBackend.releaseCreate()
        print("PASS later attachment payload is durable and recoverable while the earlier create is held")

        try await failedStagingKeepsNetworkOrder(root: root, agent: agent, file: file)
        try await unstagedFilesRemainRetryable(root: root, agent: agent)
        try await aMessageOnItsWayIsNoDraft(root: root, agent: agent)
        try await recoveredMessagesGoWhereTheyWereSent(root: root, agent: agent)
        try await retryingASkillRunsItAgain(root: root, agent: agent)
        try await aFailedInitialModeNeverSends(root: root, agent: agent, file: file)
        try await aDifferentModeReplyNeverSends(root: root, agent: agent)
        try await modeSurvivesAnUncreatedRecovery(root: root, agent: agent)
        try await aNewerModeChoicePrecedesTheFirstSend(root: root, agent: agent)

        let blocked = root.appendingPathComponent("blocked")
        try Data([0]).write(to: blocked)
        let unavailable = ThreadStore(directory: blocked)
        let before = await backend.creates
        let noDisk = ThreadController(agent: agent, backend: backend, imageStore: unavailable)
        noDisk.send("must not reach network")
        precondition(noDisk.state.transcript.turns.first?.outcome != nil)
        let after = await backend.creates
        precondition(after == before)
        noDisk.close()
        print("PASS journal write failure blocks network and keeps a visible failure")
    }
}
