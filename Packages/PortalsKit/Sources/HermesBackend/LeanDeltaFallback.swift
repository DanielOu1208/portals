import AgentCore
import Synchronization

/// A bad compact frame disables the opt-in for this host until the app exits, even
/// if its backend is recreated or its route changes. Nothing is written to disk.
enum LeanDeltaFallback {
    private static let disabledHosts = Mutex<Set<HostID>>([])

    static func allows(_ host: HostID) -> Bool {
        disabledHosts.withLock { !$0.contains(host) }
    }

    static func record(_ error: (any Error)?, for host: HostID) {
        guard error is LeanDeltaFormatError else { return }
        disabledHosts.withLock { _ = $0.insert(host) }
    }
}
