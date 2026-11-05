import AgentCore
import SwiftUI

/// The measures of the agents' page and its sheets, on every device: one small set, so that
/// the room round everything is the same.
enum AgentSheetMetrics {
    /// From the sheet's edges to what is in it.
    static let edge: CGFloat = 20
    /// Between the sheet's parts, either side of a rule.
    static let part: CGFloat = 16
    /// Between the things of a part.
    static let inner: CGFloat = 12
    /// Between the lines of one thing.
    static let line: CGFloat = 4
    /// Every box's corners.
    static let corner: CGFloat = 12
    /// A row's height.
    static let row: CGFloat = 44
    static let headerOrb: CGFloat = 72
    static let rowOrb: CGFloat = 32
    /// An update's bar on a sheet, and on a row.
    static let updateBar: CGFloat = 240
    static let rowUpdateBar: CGFloat = 64
    /// A Mac's sheet: its width, and how tall it may get before it scrolls.
    static let macWidth: CGFloat = 440
    static let macHeight: CGFloat = 640
}

/// A program on a host, its one sheet: who it is and its version, updating it, how much of its
/// plan is left, and how its agents look. All on one colour, with what matters before updating
/// said in the confirmation and only there. The host's word on it is asked for by the page
/// beneath (`AgentSettings`), which stays on screen under this sheet.
struct AgentProgramDetail: View {
    private typealias Metrics = AgentSheetMetrics

    let fleet: Fleet
    let hostID: HostID
    let programID: AgentProgram.ID
    let onDone: () -> Void

    /// Asking whether to update, with what it would say.
    @State private var confirming: Confirmation?
    /// Why the host would not.
    @State private var refusal: String?
    /// An agent's look being changed: over this sheet, which is still here after.
    @State private var changingLook: Agent?
    /// How tall what it holds is, for a Mac's sheet to ask for.
    @State private var partsHeight: CGFloat = 0

    private struct Confirmation: Identifiable {
        let title: String
        let message: String
        var id: String { title }
    }

    private var host: HostModel? { fleet.model(for: hostID) }
    private var program: AgentProgram? { AgentProgramsMemory.shared.program(programID, on: hostID) }
    private var agents: [Agent] { fleet.arrangedAgents(on: hostID).filter { $0.kind == programID } }
    private var isHermes: Bool { programID == "hermes" }
    private var name: String { program?.name ?? (isHermes ? "Hermes" : agents.first?.displayName ?? programID) }
    private var style: AgentAvatarStyle { agents.first.map { fleet.style(for: $0.id) } ?? AgentIcon.style(ofProgram: programID) }

    var body: some View {
        chrome {
            scrolling.background(SettingsScreen.background)
        }
        .presentationBackground(SettingsScreen.background)
        .sizedOnMac(height: partsHeight)
        .confirmationDialog(confirming?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { _ in
            Button("Update") { startUpdate() }
                .accessibilityIdentifier("confirm-update-program")
            Button("Cancel", role: .cancel) {}
        } message: { confirmation in
            Text(confirmation.message)
        }
        .alert("Can't update this here", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } }), presenting: refusal) { _ in
            Button("OK", role: .cancel) {}
        } message: { refusal in
            Text(refusal)
        }
        .sheet(item: $changingLook) { agent in
            AgentLookEditor(agent: agent, look: fleet.look(for: agent.id), logo: fleet.logo(for: agent.id)) { look in
                fleet.setLook(look, for: agent.id)
            }
        }
    }

    /// Done over the sheet's one colour, with no bar or title: the header says whose it is.
    @ViewBuilder
    private func chrome(@ViewBuilder content: () -> some View) -> some View {
        #if targetEnvironment(macCatalyst)
        ZStack(alignment: .topTrailing) {
            content()
            done.buttonStyle(.borderedCapsule).padding(Metrics.inner)
        }
        #else
        NavigationStack {
            content()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { done }
                }
                .toolbarBackground(.hidden, for: .navigationBar)
                .navigationBarTitleDisplayMode(.inline)
        }
        #endif
    }

    private var done: some View {
        Button("Done", action: onDone)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("panel-done")
    }

    /// What it holds, scrolling where that does not fit: a scroll view alone would ask a Mac's
    /// sheet for no height at all.
    @ViewBuilder
    private var scrolling: some View {
        #if targetEnvironment(macCatalyst)
        ViewThatFits(in: .vertical) {
            parts
            ScrollView { parts }
        }
        #else
        ScrollView { parts }
            .scrollBounceBehavior(.basedOnSize)
        #endif
    }

    private var parts: some View {
        VStack(spacing: Metrics.part) {
            header
            ForEach(limitGroups, id: \.agent.id) { group in
                Divider()
                limits(group)
            }
            if let note = blockingNote {
                Divider()
                Text(note).font(.app.footnote).foregroundStyle(.orange)
            }
            if !agents.isEmpty {
                Divider()
                foot
            }
        }
        .padding(Metrics.edge)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { partsHeight = $0 }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: Metrics.inner) {
            ProgramIcon(programID: programID, style: style, size: Metrics.headerOrb)
            VStack(spacing: Metrics.line) {
                Text(name)
                    .font(.app.title2.weight(.semibold))
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if let program, let line = program.versionLine {
                    Text(line)
                        .font(.app.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(isLoud(program) ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                        .multilineTextAlignment(.center)
                        .accessibilityLabel(program.spokenVersionLine ?? line)
                }
                Text(host?.host.name ?? "")
                    .font(.app.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            if let program {
                updateControl(program)
            } else if let failure = AgentProgramsMemory.shared.failures[hostID] {
                Text(failure).font(.app.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else if host?.isConnected == true {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func isLoud(_ program: AgentProgram) -> Bool {
        switch program.state {
        case .tooOld, .notFound: true
        default: false
        }
    }

    // MARK: Updating

    /// Under the version: the button, or in its place what it has come to.
    @ViewBuilder
    private func updateControl(_ program: AgentProgram) -> some View {
        if let file = program.update?.cannotTellFile {
            VStack(spacing: Metrics.line * 2) {
                Text(AgentProgram.Update.cannotTellWords)
                    .font(.app.footnote)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                CommandBox(command: file, copyIdentifier: "program-update-copy", lines: 3)
                    .accessibilityIdentifier("program-update-cannot-tell")
            }
        } else if program.update?.isUnattended == true {
            Text(program.stateWords ?? "")
                .font(.app.subheadline.weight(.medium))
                .frame(minHeight: UpdateButtonStyle.height)
                .accessibilityIdentifier("program-updating")
        } else if program.isUpdating {
            // Where the button was, with the updater's latest line under it.
            VStack(spacing: Metrics.line * 2) {
                UpdateBar(fraction: program.update?.fraction, tint: isHermes ? nil : style.tint)
                    .frame(maxWidth: Metrics.updateBar)
                Text(program.update?.line ?? "Updating…")
                    .font(.app.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(minHeight: UpdateButtonStyle.height)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("program-updating")
        } else {
            if let update = program.update, update.state == .failed {
                failure(update)
            }
            if program.offersUpdate, host?.isConnected == true {
                Button(program.update?.state == .failed ? "Try Again" : "Update") { confirming = confirmation(for: program) }
                    .buttonStyle(UpdateButtonStyle(tint: isHermes ? nil : style.tint))
                    .accessibilityIdentifier("update-program")
            } else if !program.canUpdate, program.isInstalled {
                if let command = program.command {
                    CommandBox(command: command, copyIdentifier: "program-update-copy")
                        .accessibilityIdentifier("program-update-command")
                } else {
                    Text("Updates with its app").font(.app.footnote).foregroundStyle(.secondary)
                }
            }
            if let update = program.update, update.state == .done {
                Text(doneWords(update, program))
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("program-update-done")
            }
        }
    }

    /// Why it failed, in the end of what it printed, in a box of its own.
    private func failure(_ update: AgentProgram.Update) -> some View {
        VStack(alignment: .leading, spacing: Metrics.line) {
            Text(update.timedOut ? "Took too long and was stopped" : "Update failed")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.orange)
            if let tail = update.tail {
                Text(tail.split(separator: "\n").suffix(4).joined(separator: "\n"))
                    .font(.app.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.inner)
        .background(Theme.insetFill, in: .rect(cornerRadius: Metrics.corner, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("program-update-failed")
    }

    private func doneWords(_ update: AgentProgram.Update, _ program: AgentProgram) -> String {
        if let from = update.from, let to = update.to, from != to { return "Updated from \(from) to \(to)" }
        return "Nothing newer to install"
    }

    /// What matters before updating, in one short sentence, and only here.
    private func confirmation(for program: AgentProgram) -> Confirmation {
        let threads = host?.threadsAtWork(of: Set(agents.map(\.id.name))) ?? []
        let message: String
        switch program.takesEffect {
        case .nextStart:
            message = threads.isEmpty
                ? "Threads at work keep their version until they next start."
                : "\(Self.named(threads)) \(threads.count == 1 ? "keeps its" : "keep their") version until \(threads.count == 1 ? "it next starts" : "they next start")."
        case .serviceRestart:
            message = "\(program.name) threads move to the new version when its background service restarts."
        case .botsRestart:
            let bots = agents.map(\.displayName).formatted(.list(type: .and))
            message = bots.isEmpty ? "Hermes restarts its bots." : "Hermes restarts its bots: \(bots)."
        }
        let to = program.updateAvailable == true ? program.latest.map { " to \($0)" } ?? "" : ""
        return Confirmation(title: "Update \(program.name)\(to) on \(host?.host.name ?? "this host")?", message: message)
    }

    /// "“Fix the login” and “Tidy up”", and how many more past three.
    private static func named(_ threads: [ThreadRecord]) -> String {
        let shown = threads.prefix(3).map { "“\($0.displayTitle)”" }
        let rest = threads.count - shown.count
        return (rest > 0 ? shown + ["\(rest) more"] : shown).formatted(.list(type: .and))
    }

    private func startUpdate() {
        guard let provider = host?.programsProvider else { return }
        Task {
            do {
                try await AgentProgramsMemory.shared.update(programID, on: hostID, from: provider)
            } catch {
                refusal = error.localizedDescription
            }
        }
    }

    // MARK: Limits

    /// How much is left of a plan, just as the panel over a chat shows it.
    private func limits(_ group: (agent: Agent, limits: UsageLimits)) -> some View {
        UsagePart(
            agent: group.agent.displayName, limits: group.limits,
            failure: ThreadPanelMemory.shared.pageUsageFailure(of: group.agent.id),
            asOf: ThreadPanelMemory.shared.pageUsageAsOf(of: group.agent.id, isConnected: host?.isConnected == true),
            tint: fleet.style(for: group.agent.id).tint
        )
        .font(.app.subheadline)
    }

    /// A limit that turns work away, where the host has no window to draw for it.
    private var blockingNote: String? {
        guard limitGroups.isEmpty else { return nil }
        return agents.lazy.compactMap { ThreadPanelMemory.shared.pageUsage(of: $0.id)?.blockingNote }.first
    }

    /// One for each thing said of a plan: a host's bots mostly say the same.
    private var limitGroups: [(agent: Agent, limits: UsageLimits)] {
        var groups: [(agent: Agent, limits: UsageLimits)] = []
        for agent in agents {
            guard let limits = ThreadPanelMemory.shared.pageUsage(of: agent.id), !limits.windows.isEmpty else { continue }
            if !groups.contains(where: { $0.limits.windows == limits.windows }) { groups.append((agent, limits)) }
        }
        return groups
    }

    // MARK: Foot

    /// How it shows: a quiet row for an agent, a row with its avatar for each Hermes bot, each with its own look.
    private var foot: some View {
        VStack(spacing: 0) {
            ForEach(agents) { agent in
                Button { changingLook = agent } label: {
                    HStack(spacing: Metrics.inner) {
                        if isHermes { AgentIcon(style: fleet.style(for: agent.id), size: Metrics.rowOrb) }
                        Text(isHermes ? agent.displayName : "Appearance")
                            .font(.app.body)
                            .foregroundStyle(isHermes ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            .lineLimit(1)
                        Spacer(minLength: Metrics.inner)
                        Image(systemName: "chevron.forward")
                            .font(.app.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(height: Metrics.row)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isHermes ? "\(agent.displayName), change look" : "Appearance")
                .accessibilityIdentifier("change-look-\(agent.id.name)")
            }
        }
    }
}

/// The program's update button: a capsule in the agent's colour, or the app's ink where it has
/// none, the same on every device.
private extension View {
    /// A Mac's sheet: one width, and as tall as what it holds, up to a point.
    @ViewBuilder
    func sizedOnMac(height: CGFloat) -> some View {
        #if targetEnvironment(macCatalyst)
        frame(minWidth: AgentSheetMetrics.macWidth, idealWidth: AgentSheetMetrics.macWidth, maxHeight: AgentSheetMetrics.macHeight, alignment: .top)
            .presentationSizing(.fitted)
            .background(SheetHeight(height: min(height, AgentSheetMetrics.macHeight)))
        #else
        self
        #endif
    }
}

#if targetEnvironment(macCatalyst)
/// A Mac's sheet stays the size it first asks for, and limits can come after it has opened, or
/// an update's failure with what it said: so it asks again whenever what it holds changes.
private struct SheetHeight: UIViewRepresentable {
    let height: CGFloat

    func makeUIView(context: Context) -> UIView { UIView() }

    func updateUIView(_ view: UIView, context: Context) {
        guard height > 0 else { return }
        Task { @MainActor in
            var sheet: UIViewController?
            var next = view.next
            while let responder = next {
                if let controller = responder as? UIViewController { sheet = controller }
                next = responder.next
            }
            guard let sheet, sheet.preferredContentSize.height != height else { return }
            sheet.preferredContentSize = CGSize(width: AgentSheetMetrics.macWidth, height: height)
        }
    }
}
#endif

private struct UpdateButtonStyle: ButtonStyle {
    static let height: CGFloat = 36

    let tint: Color?

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.app.subheadline.weight(.semibold))
            .foregroundStyle(tint == nil ? Theme.plainBackground : .white)
            .padding(.horizontal, AgentSheetMetrics.edge * 1.5)
            .frame(minHeight: Self.height)
            .background(tint ?? Theme.ink, in: .capsule)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(.capsule)
    }
}
