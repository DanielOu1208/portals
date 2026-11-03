import Foundation

/// The Mac app's updates, in the builds that are a download rather than TestFlight's: those
/// carry a bundle holding Sparkle (scripts/mac-release/PortalsUpdater.swift), which the app
/// loads here and calls by name, as Mac Catalyst cannot link an AppKit framework. With no
/// such bundle, as on TestFlight and from Xcode, `isAvailable` is false and nothing shows.
@MainActor
enum MacUpdater {
    #if targetEnvironment(macCatalyst)
    private static let plugin: NSObject? = {
        guard let url = Bundle.main.builtInPlugInsURL?.appendingPathComponent("PortalsUpdater.bundle"),
              let bundle = Bundle(url: url), bundle.load(),
              let type = bundle.principalClass as? NSObject.Type else { return nil }
        return type.init()
    }()
    #else
    private static let plugin: NSObject? = nil
    #endif

    static var isAvailable: Bool { plugin != nil }

    /// As the app finishes launching: it checks in the background from then on.
    static func start() {
        plugin?.perform(NSSelectorFromString("startUpdater"))
    }

    static func checkForUpdates() {
        plugin?.perform(NSSelectorFromString("checkForUpdates"))
    }

    static var checksAutomatically: Bool {
        get { plugin?.value(forKey: "automaticallyChecksForUpdates") as? Bool ?? false }
        set { plugin?.setValue(newValue, forKey: "automaticallyChecksForUpdates") }
    }
}
