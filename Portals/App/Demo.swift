import AgentCore
import Foundation
import SwiftUI

/// The demo, opened only by a development switch (`DebugLaunch.opensDemo`), for launch videos
/// and tests. The welcome offered it to anyone with no host to add from 2026-10-29, for Beta
/// App Review, whose reviewers cannot set up a Mac, until 2026-11-03 ("remove the thing thats
/// like a demo"). A host named Demo plays the fake backend's demo script
/// (`FakeBackend+Demo`), in a fleet of its own that the screens show in place of the app's
/// while the demo is on (`RootView`). Nothing of it goes to the hosts list, the Keychain or
/// the net; nothing is sent to the relay; it registers for no notifications, its backend
/// taking no device address. Its threads are in a scratch folder, removed as it ends, and
/// the settings a person can change during it are put back as they were before it
/// (`KeptSettings`): Settings' choices and what was typed. Ended, or with the app quit, the
/// app is back at the welcome as it was.
enum Demo {
    static let hostID = HostID(rawValue: "portals-demo")

    /// The demo's host: a Portals bridge as far as the screens go, whose agents' threads
    /// started from another are under it, at an address nothing reaches (its backend is the
    /// script's).
    static let host = HostConfig(
        id: hostID, name: "Demo", url: URL(string: "http://demo.invalid")!, kind: .bridge, generalFolder: FakeBackend.demoHome,
        nestsAgentThreads: true
    )

    /// Where the demo's threads are kept while it is on.
    private static var folder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Portals-demo", isDirectory: true)
    }

    /// The settings a person can change while the demo is on, as they were before it:
    /// Settings' choices, the sidebar's pin and what is typed. Only these are put back, so
    /// that nothing the app or the system writes by itself meanwhile is put back over (the
    /// device's notification address, a window's frame). A choice added to Settings is to
    /// be named here too. Kept with the app's data, which the system does not clear as it
    /// may clear tmp, so that a demo the app was quit in is undone at the next launch.
    private static let settings = KeptSettings(
        file: URL.applicationSupportDirectory.appendingPathComponent("Portals-demo-settings.plist"),
        keys: [
            WhenBusy.settingKey, ThoughtWindow.settingKey, NotificationChoices.needsYouKey, NotificationChoices.doneKey,
            AppearanceChoice.settingKey, ChatWash.settingKey, Fleet.asksHermesAgentsForFolderKey, MainScreen.pinsSidebarKey,
            ComposerDrafts.defaultsKey, RecentChoice.showsKey, RecentChoice.countKey,
        ],
        mark: "demo.settingsKept"
    )

    @discardableResult
    private static func putBackSettings() -> KeptSettings.PutBack {
        guard let domain = Bundle.main.bundleIdentifier else { return .none }
        return settings.putBack(into: .standard, domain: domain)
    }

    /// Puts the app's settings back as they were before a demo the app was quit in, or
    /// ended partway through putting them back: at launch, before anything reads them, and
    /// again each time the app comes to the front with no demo on, should they not have been
    /// readable then (before the device was first unlocked).
    @discardableResult
    static func putBackSettingsLeftByADemo() -> KeptSettings.PutBack {
        guard settings.isKept(in: .standard) else { return .none }
        return putBackSettings()
    }

    /// Whether settings a demo changed are still to be put back with no demo on: kept when
    /// the app was quit in one, and not readable since (before the device was first
    /// unlocked). Nothing else may change them until they are back (`RootView`).
    static var hasSettingsLeft: Bool {
        settings.isKept(in: .standard)
    }

    /// Why the demo could not open, or end.
    enum Problem: LocalizedError, Identifiable {
        /// The app's settings could not be kept, to be put back as it ends.
        case settingsNotKept
        /// The settings kept could not be read back just now: the demo stays on until they
        /// are, as nothing else may change them meanwhile.
        case settingsNotPutBack(ending: Bool)

        var id: String { localizedDescription }

        var title: String {
            switch self {
            case .settingsNotKept, .settingsNotPutBack(ending: false): "Can't open the demo"
            case .settingsNotPutBack(ending: true): "Can't end the demo yet"
            }
        }

        var errorDescription: String? {
            switch self {
            case .settingsNotKept:
                "Portals could not keep your settings apart from the demo's, maybe for want of room. Make some room and try again."
            case .settingsNotPutBack:
                "Portals could not read back your settings as they were before the demo just now. Try again in a moment."
            }
        }
    }

    /// A fleet for the demo, its threads put in a scratch folder made anew, with the
    /// tour's thread on screen: the tour begins once the host has listed its agents
    /// (`Fleet.startTour`). Not without the app's settings kept to be put back.
    static func start() throws -> Fleet {
        try? FileManager.default.removeItem(at: folder)
        // What was typed in a demo the app was quit in, should its settings have gone with
        // the scratch files.
        ComposerDrafts.shared.forget(host: hostID)
        // A copy from an earlier demo is put back before another takes its place.
        guard putBackSettingsLeftByADemo() != .notNow else { throw Problem.settingsNotPutBack(ending: false) }
        guard let domain = Bundle.main.bundleIdentifier, settings.keep(.standard, domain: domain) else { throw Problem.settingsNotKept }
        // The list and the agents, to start on at once: the threads' turns are the host's,
        // given as each is opened, as a bridge gives them.
        let store = ThreadStore(directory: folder)
        store.saveAgents(FakeBackend.demoAgents(on: hostID))
        _ = store.saveThreads(FakeBackend.demoThreads(on: hostID).map(\.record))
        let fleet = Fleet(HostDirectory.Starting(hosts: [host], credentials: InMemoryCredentialStore(), savesHosts: false, store: store, isDemo: true))
        fleet.showTab(ThreadKey(host: hostID, id: FakeBackend.demoTourID), readingNow: true)
        return fleet
    }

    /// Ends the demo: the app's settings are as they were before it, then its host stops,
    /// and its threads and what was typed in them go. Not while the settings kept cannot be
    /// read back: the demo stays on, and nothing else changes them meanwhile.
    static func end(_ fleet: Fleet) throws {
        // What is typed is held in memory too, and saved from there.
        ComposerDrafts.shared.forget(host: hostID)
        guard putBackSettings() != .notNow else { throw Problem.settingsNotPutBack(ending: true) }
        fleet.endDemo()
        try? FileManager.default.removeItem(at: folder)
    }
}

/// Ends the demo (`Demo`): from Settings, and the sidebar's foot. Always the same action
/// while the demo is on, so one is as good as another.
struct DemoEnding: Equatable {
    let end: () -> Void

    func callAsFunction() { end() }

    static func == (one: DemoEnding, other: DemoEnding) -> Bool { true }
}

extension EnvironmentValues {
    /// The way out of the demo, while it is on.
    @Entry var endDemo: DemoEnding?
}
