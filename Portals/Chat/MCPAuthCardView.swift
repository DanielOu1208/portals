import AgentCore
import SwiftUI

struct MCPAuthCards: View {
    let state: MCPAuthState
    let onAction: (MCPAuthAction, String) -> Void
    let onRetry: () -> Void
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.grid) {
                if state.listFailed {
                    VStack(alignment: .leading, spacing: Theme.grid) {
                        Text("Sign-in status could not be loaded.")
                            .font(.app.footnote)
                        Button("Try again") { swipeGuard(onRetry) }
                            .buttonStyle(.borderedCapsule)
                            .disabled(state.isRefreshing)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.grid * 2)
                    .glassEffect(.regular, in: .rect(cornerRadius: 26))
                    .accessibilityIdentifier("mcp-auth-list-error")
                }
                ForEach(state.shownCards, id: \.serverName) { card in
                    MCPAuthCardView(
                        card: card, isBusy: state.busyServers.contains(card.serverName),
                        isSettling: state.settlingServers.contains(card.serverName),
                        hasActionError: state.hasActionError(for: card),
                        pasteWasRejected: state.pasteWasRejected(for: card),
                        onDismiss: { state.dismiss(card) }
                    ) { action in
                        onAction(action, card.serverName)
                    }
                    .id(card.id)
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 340)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct MCPAuthCardView: View {
    let card: MCPAuthCard
    let isBusy: Bool
    let isSettling: Bool
    let hasActionError: Bool
    /// The last paste was not taken, and the attempt still waits for one.
    let pasteWasRejected: Bool
    /// Puts a finished sign-in's card away: the host keeps listing it.
    let onDismiss: () -> Void
    let onAction: (MCPAuthAction) -> Void

    @State private var code = ""
    @FocusState private var isPasting: Bool
    @Environment(\.isOutOfSight) private var isOutOfSight
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            Label("MCP sign-in", systemImage: "lock.shield")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            Text(verbatim: card.serverName)
                .font(.app.callout.weight(.medium))
            if isSettling {
                Text("One moment…")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
            if pasteWasRejected {
                Text("That code or address was not accepted for this attempt. Paste it again.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            } else if hasActionError, card.status != .failed {
                Text("Sign-in did not finish. Try again.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.grid * 2)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp-auth-card")
        .onChange(of: card) { _, _ in clearCode() }
        .onChange(of: isOutOfSight) { _, hidden in if hidden { clearCode() } }
        .onDisappear { clearCode() }
    }

    @ViewBuilder private var content: some View {
        switch card.status {
        case .required:
            Text("This server needs you to sign in.")
                .font(.app.footnote)
            startButton("Sign in")
        case .starting:
            Text("Starting sign-in…")
                .font(.app.footnote)
            cancelButton
        case .waiting:
            if let url = card.url, let host = url.host {
                Text("Sign in at \(host)")
                    .font(.app.footnote)
                Button("Open sign-in") {
                    // Only a person's tap opens a remote sign-in URL, in the system browser.
                    swipeGuard { UIApplication.shared.open(url, options: [.universalLinksOnly: false]) }
                }
                .buttonStyle(.borderedCapsule)
                Text("If the browser cannot return to this host, copy its final address or code and paste it here.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                SecureField("Code or redirect URL", text: $code)
                    .textContentType(nil)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .focused($isPasting)
                    .losesFocusOutOfSight($isPasting)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isBusy)
                    .accessibilityIdentifier("mcp-auth-code")
                HStack(spacing: Theme.grid) {
                    Button("Submit") {
                        swipeGuard {
                            let pasted = code.trimmingCharacters(in: .whitespacesAndNewlines)
                            clearCode()
                            onAction(.submit(server: card.serverName, authID: card.id, code: pasted))
                        }
                    }
                    .buttonStyle(.monochromeProminent)
                    .buttonBorderShape(.capsule)
                    .disabled(isBusy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    cancelButton
                }
            }
        case .completed:
            Text("Signed in.")
                .font(.app.footnote)
            Button("Done") { swipeGuard(onDismiss) }
                .buttonStyle(.borderedCapsule)
                .accessibilityIdentifier("mcp-auth-done")
        case .cancelled:
            Text("Sign-in cancelled.")
                .font(.app.footnote)
            startButton("Try again")
        case .failed:
            Text("Sign-in did not finish. Try again.")
                .font(.app.footnote)
            startButton("Try again")
        }
    }

    private func startButton(_ title: String) -> some View {
        Button(title) {
            swipeGuard {
                clearCode()
                onAction(.start(server: card.serverName))
            }
        }
        .buttonStyle(.monochromeProminent)
        .buttonBorderShape(.capsule)
        .disabled(isBusy)
    }

    private var cancelButton: some View {
        Button("Cancel") {
            swipeGuard {
                clearCode()
                onAction(.cancel(server: card.serverName, authID: card.id))
            }
        }
        .buttonStyle(.borderedCapsule)
        .disabled(isBusy)
    }

    private func clearCode() {
        code = ""
        isPasting = false
    }
}
