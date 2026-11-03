import AppKit
import Sparkle

/// Sparkle for the Mac app. The app is Mac Catalyst, which cannot link AppKit frameworks, so
/// this is a bundle of its own that the app loads as it starts (`MacUpdater` in
/// Portals/App/MacUpdater.swift), and calls by name. `scripts/release-mac.sh` builds it and
/// puts it in the DMG's app, with Sparkle.framework. TestFlight builds, which Apple updates,
/// and builds from Xcode have neither.
@objc(PortalsUpdaterPlugin)
public final class PortalsUpdaterPlugin: NSObject {
    private let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)

    @objc public func startUpdater() {
        controller.startUpdater()
    }

    @objc public func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    @objc public var automaticallyChecksForUpdates: Bool {
        get { controller.updater.automaticallyChecksForUpdates }
        set { controller.updater.automaticallyChecksForUpdates = newValue }
    }
}
