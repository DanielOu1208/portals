import SwiftUI

/// The menu bar's commands for the tabs, the Macs and the sidebar, with their keys, as
/// in Safari (2026-10-23): ⌘T a new tab, ⌘W closes the one on screen (and never
/// the window), ⌘1 to ⌘9 go to a tab (⌘9 to the last), ⌃Tab and ⌃⇧Tab or ⌘⇧] and ⌘⇧[
/// to the next and the one before, ⌘⌥→ and ⌘⌥← to the next Mac and the one before, ⌘S
/// shows or hides the sidebar. ⌃⌘S does too: the key of the sidebar's own button, in the
/// tab bar or the chat's header, as it was before the tabs. On an iPad they are what
/// holding ⌘ lists.
///
/// ⌘, opens Settings, over the window; while it is open the other commands do nothing,
/// for what they would change is out of sight under it.
///
/// Read nothing that changes in `body`: the menus are built again each time it is.
struct TabCommands: Commands {
    /// The app's fleet, reached only as a command is chosen: the app's commands are made
    /// before its window, and the fleet is made with the window's first view, as it was
    /// before there were commands (`RootView.fleetForTheRun`). The demo's while it is on.
    private var fleet: Fleet { RootView.demoForTheRun ?? RootView.fleetForTheRun }

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            if MacUpdater.isAvailable {
                Button("Check for Updates…") { MacUpdater.checkForUpdates() }
            }
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { ScreenCommands.shared.showSettings?() }
                .keyboardShortcut(",")
        }
        // Close is a window's, in the File menu: here it closes the tab.
        CommandGroup(replacing: .saveItem) {
            Button("Close Tab") { onScreen { fleet.closeShownTab() } }
                .keyboardShortcut("w")
        }
        CommandGroup(replacing: .sidebar) {
            Button("Show or Hide Sidebar") { onScreen { ScreenCommands.shared.toggleSidebar?() } }
                .keyboardShortcut("s")
        }
        // SwiftUI's: the app has a `CommandMenu` of its own, the composer's slash commands.
        SwiftUI.CommandMenu("Tabs") {
            Button("New Tab") { onScreen { fleet.newTab() } }
                .keyboardShortcut("t")
            Divider()
            Button("Next Tab") { onScreen { fleet.cycleTabs(by: 1) } }
                .keyboardShortcut(.tab, modifiers: .control)
            Button("Previous Tab") { onScreen { fleet.cycleTabs(by: -1) } }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
            // The same twice, with Safari's other keys: a menu item has one key each.
            Button("Next Tab ") { onScreen { fleet.cycleTabs(by: 1) } }
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Previous Tab ") { onScreen { fleet.cycleTabs(by: -1) } }
                .keyboardShortcut("[", modifiers: [.command, .shift])
            Divider()
            ForEach(1..<10) { number in
                Button(number == 9 ? "Last Tab" : "Tab \(number)") { onScreen { fleet.showTab(at: number - 1) } }
                    .keyboardShortcut(KeyEquivalent(Character("\(number)")), modifiers: .command)
            }
        }
        SwiftUI.CommandMenu("Hosts") {
            Button("Next Host") { onScreen { fleet.stepSpace(by: 1) } }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
            Button("Previous Host") { onScreen { fleet.stepSpace(by: -1) } }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
        }
    }

    /// What a command does to the tabs and the sidebar, unless Settings covers them.
    private func onScreen(_ action: () -> Void) {
        guard !ScreenCommands.shared.showsSettings else { return }
        action()
    }
}

/// What the menu bar's commands ask of the screen that only it can do, set by it as it
/// appears (`MainScreen`): the app has one window, and one screen in it.
@MainActor
final class ScreenCommands {
    static let shared = ScreenCommands()

    /// Shows or hides the sidebar: beside the chat on a wide window, or behind it.
    var toggleSidebar: (@MainActor () -> Void)?
    /// Opens Settings over the window (`RootView`).
    var showSettings: (@MainActor () -> Void)?
    /// Settings is open over the window.
    var showsSettings = false
}
