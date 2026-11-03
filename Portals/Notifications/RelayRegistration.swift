import AgentCore
import Foundation
import os

/// The device's registration with the Portals relay (relay/, docs/pairing-and-relay.md),
/// which sends notifications for bridges that have no APNs key of their own. The app
/// trades its device token for a relay token and gives that to each bridge; the bridge
/// sends through the relay with it.
///
/// A relay token is kept for its device token and environment, and asked for again
/// after a week, so a relay that changed its signing secret is caught up with.
nonisolated enum RelayRegistration {
    private static let savedKey = "PortalsRelayRegistration"
    private static let freshFor: TimeInterval = 7 * 24 * 3600

    private struct Saved: Codable {
        var relay: String
        var token: String
        var environment: String
        var relayToken: String
        var at: Date
    }

    /// The relay this build names under `PortalsRelayURL`, or the one a development launch
    /// names (`DebugLaunch.relayURL`); nil when it names none.
    static var relay: URL? {
        if let named = DebugLaunch.relayURL, named.scheme == "https" || named.scheme == "http" { return named }
        guard let text = Bundle.main.object(forInfoDictionaryKey: "PortalsRelayURL") as? String, !text.isEmpty,
              let url = URL(string: text), url.scheme == "https" || url.scheme == "http" else { return nil }
        return url
    }

    /// The relay token for this device: the saved one while it is fresh, else a new one
    /// from the relay. nil when the build names no relay or the relay cannot be reached;
    /// the hosts then keep the token they were given before.
    static func token(for device: String, environment: PushDevice.Environment, bundleID: String) async -> String? {
        guard let relay else { return nil }
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: savedKey), let saved = try? JSONDecoder().decode(Saved.self, from: data),
           saved.relay == relay.absoluteString, saved.token == device, saved.environment == environment.rawValue,
           Date().timeIntervalSince(saved.at) < freshFor {
            return saved.relayToken
        }

        var request = URLRequest(url: relay.appendingPathComponent("v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20
        request.httpBody = try? JSONEncoder().encode(["token": device, "environment": environment.rawValue, "bundle_id": bundleID])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200,
                  let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let relayToken = answer["relay_token"] as? String, !relayToken.isEmpty else {
                AppLog.push.error("The relay answered \(status) to the device's registration")
                return nil
            }
            let saved = Saved(relay: relay.absoluteString, token: device, environment: environment.rawValue, relayToken: relayToken, at: Date())
            defaults.set(try? JSONEncoder().encode(saved), forKey: savedKey)
            AppLog.push.notice("Registered with the relay")
            return relayToken
        } catch {
            AppLog.push.error("Could not register with the relay: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
