import AgentCore
import Foundation
import SwiftUI

/// Measuring the tabs and the Macs' spaces, for scripts/tabs-bench.sh (docs/perf-tabs.md).
/// Keystrokes cannot be sent to a copy of the app in the background, so the bench has the
/// app make the same calls the keys and a click make, on a Darwin notification:
///
/// - `com.danielou.portals.bench.tabs`, with `PORTALS_DEBUG_TAB_SWITCHES=<n>:<seconds>`:
///   `n` switches between the open tabs, `seconds` apart, in turn as ⌃Tab and ⌃⇧Tab do
///   (`Fleet.cycleTabs`), as ⌘1 to ⌘9 do (`Fleet.showTab(at:)`) and as a click on a tab
///   does (`Fleet.showTab`), never to the tab on screen; then the first tab again. The
///   probe (`SidebarProbe`) notes `tab-switch <way>` before each and `tab-frame <ms>`, the
///   time until the main thread could draw again, and `tab-switches-done` at the end.
/// - `com.danielou.portals.bench.tabs.return`: as many switches, each back to a tab shown
///   a moment ago, in turn the one before the tab on screen and the one before that (three
///   tabs gone round, as someone going back and forth between a few does), as a click
///   does; `tab-switch return` before each, then `tab-frame` and `tab-switches-done`.
/// - `com.danielou.portals.bench.tabs.far`: as many switches, each to the open tab shown
///   longest ago (never, for those not shown yet since launch, the first of them first),
///   as a click does: a tab not looked at for a while; `tab-switch far` before each.
/// - `com.danielou.portals.bench.tabs.prime`: the last three tabs shown one after
///   another, 0.7 s apart, then the tab on screen before them again, and
///   `tabs-primed <id>,<id>,<id>`: the bench then starts turns in those three, not on
///   screen though shown a moment ago.
/// - `com.danielou.portals.bench.sidebar`: the sidebar hidden and shown again ten times, a
///   second apart, as ⌘S does (`toggleSidebar`).
/// - `com.danielou.portals.bench.spaces`, with `PORTALS_DEBUG_SPACE_STEPS=<n>:<seconds>`:
///   `n` steps from one Mac's space to the next and back, as ⌘⌥→ and ⌘⌥← do
///   (`Fleet.stepSpace`) and, every other one, as a click on a Mac's tab does (animated),
///   with `space-step <way>`, `space-frame <ms>` and `space-steps-done`.
///
/// Only a development build reads the switches; elsewhere there is nothing here.
@MainActor
enum TabsBench {
    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    private static weak var fleet: Fleet?
    private static var isRunning = false

    /// Listens for the bench's notifications, once, when a switch asks for them.
    static func listen(to fleet: Fleet) {
        guard self.fleet == nil, DebugLaunch.tabSwitches != nil || DebugLaunch.spaceSteps != nil else { return }
        self.fleet = fleet
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        for name in [tabsNotification, returnNotification, farNotification, primeNotification, sidebarNotification, spacesNotification] {
            CFNotificationCenterAddObserver(
                center, nil,
                { _, _, name, _, _ in
                    let said = name?.rawValue as String?
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            if said == TabsBench.tabsNotification { TabsBench.switchTabs() }
                            if said == TabsBench.returnNotification { TabsBench.switchTabs(.back) }
                            if said == TabsBench.farNotification { TabsBench.switchTabs(.far) }
                            if said == TabsBench.primeNotification { TabsBench.prime() }
                            if said == TabsBench.sidebarNotification { TabsBench.toggleSidebar() }
                            if said == TabsBench.spacesNotification { TabsBench.stepSpaces() }
                        }
                    }
                },
                name as CFString, nil, .deliverImmediately
            )
        }
    }

    nonisolated static let tabsNotification = "com.danielou.portals.bench.tabs"
    nonisolated static let returnNotification = "com.danielou.portals.bench.tabs.return"
    nonisolated static let farNotification = "com.danielou.portals.bench.tabs.far"
    nonisolated static let primeNotification = "com.danielou.portals.bench.tabs.prime"
    nonisolated static let sidebarNotification = "com.danielou.portals.bench.sidebar"

    /// The sidebar hidden and shown again, as ⌘S does, ten times a second apart: the chat
    /// beside it changes width as it slides. `sidebar-toggle` before each, then
    /// `sidebar-frame` and `sidebar-toggles-done`.
    private static func toggleSidebar() {
        guard !isRunning else { return }
        isRunning = true
        Task { @MainActor in
            defer { isRunning = false }
            for _ in 0..<10 {
                SidebarProbe.markNextFrame("sidebar-frame")
                SidebarProbe.mark("sidebar-toggle")
                ScreenCommands.shared.toggleSidebar?()
                try? await Task.sleep(for: .seconds(1))
            }
            SidebarProbe.mark("sidebar-toggles-done")
        }
    }

    /// The tabs in the order they were last shown by the bench, the one on screen last;
    /// those it has not shown yet first, in the tabs' order.
    private static var shownOrder: [ThreadKey] = []

    private static func noteShown() {
        guard let fleet else { return }
        let keys = fleet.tabs.keys
        shownOrder.removeAll { !keys.contains($0) }
        shownOrder = keys.filter { !shownOrder.contains($0) } + shownOrder
        if let shown = fleet.chat?.thread?.key, let place = shownOrder.firstIndex(of: shown) {
            shownOrder.remove(at: place)
            shownOrder.append(shown)
        }
    }

    /// The patterns besides the mixed one: back to a tab shown a moment ago, or to the one
    /// shown longest ago.
    enum Pattern { case back, far }

    private static func switchTabs(_ pattern: Pattern) {
        guard let plan = DebugLaunch.tabSwitches, !isRunning else { return }
        isRunning = true
        Task { @MainActor in
            defer { isRunning = false }
            noteShown()
            for index in 0..<plan.count {
                guard let fleet, fleet.tabs.keys.count > 2 else { break }
                noteShown()
                let order = shownOrder
                let target: ThreadKey = switch pattern {
                // The one before the tab on screen, and the one before that, in turn.
                case .back: order[order.count - (index % 2 == 0 ? 2 : 3)]
                case .far: order[0]
                }
                SidebarProbe.markNextFrame("tab-frame")
                SidebarProbe.mark("tab-switch", detail: pattern == .back ? "return" : "far")
                fleet.showTab(target)
                try? await Task.sleep(for: plan.every)
            }
            // The first tab on screen at the end, as after the mixed switches.
            if let fleet, let first = fleet.tabs.keys.first, fleet.chat?.thread?.key != first {
                fleet.showTab(first)
                try? await Task.sleep(for: plan.every)
            }
            noteShown()
            SidebarProbe.mark("tab-switches-done")
        }
    }

    private static func prime() {
        guard !isRunning, let fleet else { return }
        isRunning = true
        Task { @MainActor in
            defer { isRunning = false }
            let start = fleet.chat?.thread?.key
            let others = Array(fleet.tabs.keys.filter { $0 != start }.suffix(3))
            for key in others {
                fleet.showTab(key)
                try? await Task.sleep(for: .seconds(0.7))
            }
            if let start { fleet.showTab(start) }
            try? await Task.sleep(for: .seconds(0.7))
            SidebarProbe.mark("tabs-primed", detail: others.map(\.id.rawValue).joined(separator: ","))
        }
    }

    nonisolated static let spacesNotification = "com.danielou.portals.bench.spaces"

    private static func switchTabs() {
        guard let plan = DebugLaunch.tabSwitches, !isRunning else { return }
        isRunning = true
        Task { @MainActor in
            defer { isRunning = false }
            for index in 0..<plan.count {
                guard let fleet else { return }
                let keys = fleet.tabs.keys
                guard keys.count > 1 else { break }
                let shown = fleet.chat?.thread?.key
                SidebarProbe.markNextFrame("tab-frame")
                switch index % 3 {
                case 0:
                    // ⌃Tab, and every other time ⌃⇧Tab.
                    let step = index % 6 == 0 ? 1 : -1
                    SidebarProbe.mark("tab-switch", detail: step > 0 ? "next" : "previous")
                    fleet.cycleTabs(by: step)
                case 1:
                    // ⌘1 to ⌘9, the ninth the last tab.
                    var number = (index * 5) % min(9, keys.count)
                    if fleet.tabs.key(at: number) == shown { number = (number + 1) % min(9, keys.count) }
                    SidebarProbe.mark("tab-switch", detail: "number")
                    fleet.showTab(at: number)
                default:
                    // A click on a tab, which shows its thread (`TabChip`).
                    var place = (index * 7) % keys.count
                    if keys[place] == shown { place = (place + 1) % keys.count }
                    SidebarProbe.mark("tab-switch", detail: "click")
                    fleet.showTab(keys[place])
                }
                try? await Task.sleep(for: plan.every)
                noteShown()
            }
            // The first tab on screen at the end, for a relaunch to bring back.
            if let fleet, let first = fleet.tabs.keys.first, fleet.chat?.thread?.key != first {
                fleet.showTab(first)
                try? await Task.sleep(for: plan.every)
            }
            noteShown()
            SidebarProbe.mark("tab-switches-done")
        }
    }

    private static func stepSpaces() {
        guard let plan = DebugLaunch.spaceSteps, !isRunning else { return }
        isRunning = true
        Task { @MainActor in
            defer { isRunning = false }
            for index in 0..<plan.count {
                guard let fleet, fleet.hosts.count > 1 else { break }
                let onFirst = fleet.spaceOnScreen == fleet.hosts.first?.id
                SidebarProbe.markNextFrame("space-frame")
                if index % 2 == 0 {
                    SidebarProbe.mark("space-step", detail: "key")
                    fleet.stepSpace(by: onFirst ? 1 : -1)
                } else {
                    // A click on a Mac's tab (`MacTabs`).
                    let target = onFirst ? fleet.hosts[1].id : fleet.hosts[0].id
                    SidebarProbe.mark("space-step", detail: "tab")
                    withAnimation(.smooth(duration: 0.3)) { fleet.showSpace(target) }
                }
                try? await Task.sleep(for: plan.every)
            }
            SidebarProbe.mark("space-steps-done")
        }
    }
    #else
    static func listen(to fleet: Fleet) {}
    #endif
}
