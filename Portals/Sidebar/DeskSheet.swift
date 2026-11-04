import AgentCore
import SwiftUI

/// A coding agent's sessions started on its host, in a terminal at the desk, most
/// recent first, to take up from the phone. Tapping one continues it as a thread; one a
/// terminal still has open is offered as a fork or to read only, since continuing it
/// here would write behind that terminal's back. So is one the host would not continue
/// after all (open elsewhere, unfinished tool calls, its folder moved), with its reason.
/// One the host only forks (a chat of Cursor's terminal) is offered as a fork alone.
struct DeskSheet: View {
    let agent: Agent
    let host: HostModel
    /// A session was taken up and its thread is on screen.
    var onOpened: () -> Void

    /// Asking the host for the list, which may be on screen already from the last time.
    @State private var isLoading = false
    /// The session being taken up, while the host does it.
    @State private var adopting: DeskSession.ID?
    /// A session open in a terminal, one the host would not continue, or one it only
    /// forks, while the user picks fork or read.
    @State private var choosing: DeskSession?
    /// The host's sentence on why it would not continue the session being chosen for;
    /// nil when the list said a terminal has it open.
    @State private var refusal: String?
    /// Why the last session could not be taken up.
    @State private var problem: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        // On a Mac the panel's own bar: in the window's, the sheet's Cancel was cut to "C…".
        PanelChrome(title: "Sessions on \(host.host.name)", doneIdentifier: "desk-sheet-cancel", cancels: true, onDone: { dismiss() }) {
            Group {
                if let sessions = host.deskSessions[agent.id] {
                    if sessions.isEmpty {
                        ContentUnavailableView {
                            Label("No sessions", systemImage: "terminal")
                        } description: {
                            Text("\(agent.displayName) sessions started in a terminal on \(host.host.name) show here.")
                        } actions: {
                            Button("Look again") { Task { await load() } }
                                .buttonStyle(.borderedCapsule)
                        }
                    } else {
                        list(sessions)
                    }
                } else if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView {
                        Label("No sessions", systemImage: "terminal")
                    } description: {
                        Text(host.deskSessionsProblem[agent.id] ?? "\(host.host.name) did not list its sessions.")
                    } actions: {
                        Button("Try again") { Task { await load() } }
                            .buttonStyle(.borderedCapsule)
                    }
                }
            }
            .task { await load() }
            .confirmationDialog(
                dialogTitle,
                isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil; refusal = nil } }),
                titleVisibility: .visible,
                presenting: choosing
            ) { session in
                if session.allows(.fork) {
                    Button("Fork into a new thread") { take(session, as: .fork) }
                }
                if session.allows(.read) {
                    Button("View only") { take(session, as: .read) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { session in
                Text(dialogMessage(for: session))
            }
            .alert(
                "Could not open the session",
                isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }),
                presenting: problem
            ) { _ in
                Button("OK", role: .cancel) {}
            } message: { problem in
                Text(problem)
            }
        }
        .presentationDetents([.medium, .large])
        .sheetOnMac()
        .accessibilityIdentifier("desk-sheet")
    }

    private func list(_ sessions: [DeskSession]) -> some View {
        List {
            ForEach(sessions) { session in
                row(session)
            }
        }
        .refreshable { await load() }
    }

    private func row(_ session: DeskSession) -> some View {
        Button {
            if let mode = session.defaultMode {
                take(session, as: mode)
            } else {
                refusal = nil
                choosing = session
            }
        } label: {
            HStack(spacing: Theme.grid * 1.5) {
                Image(systemName: "terminal")
                    .font(.app.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .lineLimit(2)
                    HStack(spacing: 0) {
                        let folder = session.folderName(general: host.host.generalFolder)
                        Text("\(Image(systemName: session.folder == host.host.generalFolder ? Folder.generalSymbol : "folder")) \(folder)")
                            .lineLimit(1)
                        if let updated = session.updated {
                            Text(" · \(FolderSheet.lastUsed(updated))")
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    if let badge = Self.badge(for: session.state) {
                        StateBadge(text: badge, isUrgent: session.state == .waiting)
                            .padding(.top, 2)
                    }
                }
                Spacer(minLength: 0)
                if adopting == session.id {
                    ProgressView()
                }
            }
            .listRowOnMac()
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(adopting != nil)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("desk-row")
    }

    private var dialogTitle: String {
        if refusal != nil { return "Could not continue the session" }
        return choosing?.isForkOnly == true ? "Fork this session" : "Open in a terminal"
    }

    private func dialogMessage(for session: DeskSession) -> String {
        if let refusal { return refusal }
        if session.isForkOnly {
            return "\(agent.displayName) opens it here as a new thread with what was said so far. The session in the terminal stays as it is."
        }
        return "This session is open in a terminal on \(host.host.name). Continuing it here would write behind that terminal's back."
    }

    /// What the session is doing, when it is worth saying.
    static func badge(for state: DeskSession.State) -> String? {
        switch state {
        case .open: "Open in a terminal"
        case .running: "Working"
        case .waiting: "Needs you"
        case .closed, .idle: nil
        }
    }

    /// Each way out lets go of `adopting` before anything else is awaited: the list
    /// reloaded after a refusal can take long, a fork or read picked meanwhile must be
    /// taken, and this task's end must not let go of that newer one.
    private func take(_ session: DeskSession, as mode: AdoptMode) {
        guard adopting == nil else { return }
        adopting = session.id
        Task {
            do {
                try await host.adopt(session, as: mode)
                adopting = nil
                dismiss()
                onOpened()
            } catch let DeskSessionError.continueRefused(sentence) {
                // The list called it closed, but the host will not continue it: a fork or a
                // read may still be had, so they are offered with the host's reason.
                adopting = nil
                refusal = sentence
                choosing = session
                _ = try? await host.loadDeskSessions(for: agent.id)
            } catch {
                adopting = nil
                problem = error.localizedDescription
                // The session may have changed (opened in a terminal meanwhile).
                _ = try? await host.loadDeskSessions(for: agent.id)
            }
        }
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        _ = try? await host.loadDeskSessions(for: agent.id)
    }
}

/// A few words on what a session is doing, in a capsule.
private struct StateBadge: View {
    let text: String
    /// It waits for an answer: in the colour that means "needs you".
    let isUrgent: Bool

    var body: some View {
        Text(text)
            .font(.app.caption.weight(.medium))
            .foregroundStyle(isUrgent ? Color.orange : Color.secondary)
            .padding(.horizontal, Theme.grid)
            .padding(.vertical, 2)
            .background(isUrgent ? Color.orange.opacity(0.15) : Color(uiColor: .tertiarySystemFill), in: .capsule)
    }
}
