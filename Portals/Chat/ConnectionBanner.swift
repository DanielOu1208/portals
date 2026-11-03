import SwiftUI

/// Under the header while the host is out of reach. Usually the app keeps trying by
/// itself, so this only says so, and why the last try failed. When trying again cannot
/// help (the host rejects the password), it says that instead and leads to the host's
/// settings.
struct ConnectionBanner: View {
    /// Why the last attempt failed, when that is known.
    let problem: String?
    /// The app is not trying any more.
    var isStopped = false
    var onEditHost: () -> Void = {}

    var body: some View {
        HStack(spacing: Theme.grid) {
            if isStopped {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(isStopped ? "Not connected" : "Reconnecting…")
                    .font(.app.footnote.weight(.medium))
                if let problem {
                    Text(problem)
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            if isStopped {
                Button("Settings", action: onEditHost)
                    .font(.app.footnote.weight(.medium))
                    .buttonStyle(.borderedCapsule)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, Theme.grid * 1.75)
        .padding(.vertical, Theme.grid * 0.75)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.grid * 2.25))
        .pageMargins()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connection-banner")
    }
}

#Preview {
    VStack(spacing: Theme.grid * 2) {
        ConnectionBanner(problem: nil)
        ConnectionBanner(problem: "Could not connect to the server.")
        ConnectionBanner(problem: "The host did not accept the user name or password.", isStopped: true)
    }
}
