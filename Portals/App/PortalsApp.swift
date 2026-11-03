import SwiftUI

@main
struct PortalsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // Before anything reads them: a demo the app was quit in leaves none of its changes.
        Demo.putBackSettingsLeftByADemo()
        AppWatchdog.start()
        // The sizes of the reply pictures kept on disk, read off the main thread now, so
        // the first chat opened already keeps each its own place (`ReplyImages.knownSize`).
        ReplyImages.prepareSizes()
        SidebarProbe.mark("app-init", once: true)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .tint(Theme.tint)
                .appDefaultFont()
        }
        .commands { TabCommands() }
    }
}
