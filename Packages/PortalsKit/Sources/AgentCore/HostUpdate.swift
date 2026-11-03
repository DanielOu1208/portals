import Foundation

/// A later version of a host's Portals bridge that is out, as the bridge says it (feature
/// `update_notice`, `latest`): TestFlight and the App Store update the app, and nothing
/// updates a bridge by itself, so the app says so for the host, with what to run on its
/// computer (Settings, on the host's row and in its page, and the sidebar's footer).
public struct HostUpdate: Hashable, Sendable {
    /// What to run in a terminal on the host's computer, a Mac or a Linux computer alike:
    /// it installs the latest version and restarts it.
    public static let command = "npx portals-host@latest update"

    /// The version that is out.
    public var latest: String
    /// The version the host runs, when it said.
    public var running: String?

    public init(latest: String, running: String? = nil) {
        self.latest = latest
        self.running = running
    }

    /// What a host whose bridge says `latest` has out, with the version it runs; nil for
    /// none.
    public init?(latest: String?, running: String?) {
        guard let latest else { return nil }
        self.init(latest: latest, running: running)
    }

    /// The line Settings shows on the host's row.
    public var message: String {
        "Portals host \(latest) is out\(running.map { " (this host runs \($0))" } ?? ""). To update, run \(Self.command) on that computer."
    }

    /// What it comes to, without the command: for a place that shows the command beside it.
    public var headline: String {
        "Portals host \(latest) is out\(running.map { "; this host runs \($0)" } ?? "")."
    }
}
