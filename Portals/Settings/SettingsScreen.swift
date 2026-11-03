import AgentCore
import SwiftUI

/// A sheet a part of Settings asks for, which the app's top shows (`RootView`), as it does
/// the chat's: one shown from inside Settings took on the part's own layout (its column's
/// margins, its page's colour) and came out squeezed (2026-10-26, of the look
/// editor: "this menu still looks broken just reuse the same component from outside").
enum SettingsSheet {
    case addHost
    case editHost(HostID)
    case addPortal
    case look(Agent)
    case acknowledgements
}

extension EnvironmentValues {
    /// Shows a sheet for Settings (`SettingsSheet`).
    @Entry var showSettingsSheet: (SettingsSheet) -> Void = { _ in }
}

/// A part of Settings.
enum SettingsSection: String, CaseIterable, Identifiable, Hashable {
    case net, chat, agents, notifications, appearance, about

    var id: Self { self }

    var title: String {
        switch self {
        case .net: "Net"
        case .chat: "Chat"
        case .agents: "Agents"
        case .notifications: "Notifications"
        case .appearance: "Appearance"
        case .about: "About"
        }
    }

    var symbol: String {
        switch self {
        case .net: "point.3.connected.trianglepath.dotted"
        case .chat: "bubble.left.and.bubble.right.fill"
        case .agents: "person.2.fill"
        case .notifications: "bell.badge.fill"
        case .appearance: "circle.lefthalf.filled"
        case .about: "info"
        }
    }

    /// The colour of its icon's tile, as the system's Settings gives each part one.
    var tint: Color {
        switch self {
        case .net: .blue
        case .chat: .green
        case .agents: .purple
        case .notifications: .red
        case .appearance: .indigo
        case .about: .gray
        }
    }
}

/// The app's settings, over the whole window (2026-10-25: "over the window"), in
/// six parts: Net, Chat, Agents, Notifications, Appearance and About.
///
/// - On a wide window (`WindowLayout.wideWidth`) the parts are listed where the sidebar
///   is, under Back to Chats, and the one chosen fills the rest of the window.
/// - On a narrow one (an iPhone, an iPad in Split View, a small Mac window) the list of
///   parts is a page, and a part opens over it.
///
/// What it covers stays as it was, held still out of sight (`RootView`); Esc closes it.
struct SettingsScreen: View {
    /// What a part is drawn on, its bar and what sits on the page too: on a Mac the app's
    /// own colour, white or black as its sidebar and chats are, not the system's grey
    /// (2026-10-26: "dont have the gray background on mac it just looks
    /// terrible"); elsewhere the system's grouped one.
    static let background: Color = Platform.isMac ? Theme.plainBackground : Color(uiColor: .systemGroupedBackground)

    /// A part's rows on a Mac, on `background`: a little off it, as a sidebar's chosen row is.
    static let rowFill = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x1C / 255.0, green: 0x1C / 255.0, blue: 0x1E / 255.0, alpha: 1)
            : UIColor(red: 0xF2 / 255.0, green: 0xF2 / 255.0, blue: 0xF7 / 255.0, alpha: 1)
    })

    let fleet: Fleet
    /// The part shown, kept by the screen under it: Settings opens again where it was left.
    @Binding var section: SettingsSection
    let onClose: () -> Void

    var body: some View {
        GeometryReader { proxy in
            if proxy.size.width >= WindowLayout.wideWidth {
                HStack(spacing: 0) {
                    SettingsColumn(section: $section, onClose: onClose)
                        .frame(width: WindowLayout.pinnedSidebarWidth)
                    Divider()
                        .ignoresSafeArea()
                    SettingsPage(fleet: fleet, section: section, header: .bar)
                        .id(section)
                }
            } else {
                SettingsStack(fleet: fleet, section: $section, onClose: onClose)
            }
        }
        .background(Self.background.ignoresSafeArea())
        // Not `.isModal` for VoiceOver (the screen under it is hidden from it anyway): on a
        // Mac that trait kept every sheet from opening once anything in Settings had been
        // clicked (Change Look did nothing, 2026-10-26.
    }
}

// MARK: The list of parts

/// Where the sidebar is, on a wide window: Back to Chats, and the parts.
private struct SettingsColumn: View {
    @Binding var section: SettingsSection
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: RowMetrics.spacing) {
            Button(action: onClose) {
                RowBox {
                    Label("Back to Chats", systemImage: "chevron.backward")
                        .labelStyle(RowLabelStyle())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, RowMetrics.padding)
                }
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("settings-close")

            Text("Settings")
                .font(.app.title2.weight(.bold))
                .padding(.horizontal, RowMetrics.padding)
                .padding(.top, RowMetrics.blockGap)
                .padding(.bottom, Theme.grid)
                .accessibilityAddTraits(.isHeader)

            ForEach(SettingsSection.allCases) { item in
                Button { section = item } label: {
                    RowBox(isCurrent: section == item) {
                        Label { Text(item.title) } icon: { SettingsIcon(section: item) }
                            .labelStyle(RowLabelStyle())
                            .padding(.horizontal, RowMetrics.padding)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(section == item ? .isSelected : [])
                .accessibilityIdentifier("settings-section-\(item.rawValue)")
            }
        }
        .font(.app.body)
        .padding(.horizontal, RowMetrics.inset)
        .padding(.top, Theme.grid)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AgentSidebar.background.ignoresSafeArea())
    }
}

/// A part's icon: its symbol, white on a tile of its colour.
struct SettingsIcon: View {
    let section: SettingsSection

    var body: some View {
        RoundedRectangle(cornerRadius: Self.size * 0.24, style: .continuous)
            .fill(section.tint.gradient)
            .frame(width: Self.size, height: Self.size)
            .overlay {
                Image(systemName: section.symbol)
                    .font(.system(size: Self.size * 0.5, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }

    static let size: CGFloat = Platform.isMac ? 22 : 29
}

// MARK: A narrow window

/// Settings on a narrow window: the list of parts, and the part opened over it. In a
/// navigation stack on an iPhone and iPad; on a Mac, where a stack in the window would
/// give its bar to the window's own, with a bar of its own (`SettingsBar`).
private struct SettingsStack: View {
    let fleet: Fleet
    /// The part last opened, which the wide layout shows.
    @Binding var section: SettingsSection
    let onClose: () -> Void

    /// The part open over the list; it opens on the list, but for a development switch's.
    @State private var path: [SettingsSection] = DebugLaunch.settingsOpensAt.map { [$0] } ?? []

    var body: some View {
        #if targetEnvironment(macCatalyst)
        ZStack {
            if let shown = path.last {
                SettingsPage(fleet: fleet, section: shown, header: .back({ path.removeAll() }, close: onClose))
            } else {
                list
                    .safeAreaInset(edge: .top, spacing: 0) {
                        SettingsBar(title: "Settings", trailing: AnyView(done.buttonStyle(.borderedCapsule)))
                    }
                    .ignoresSafeArea(.container, edges: .top)
            }
        }
        #else
        NavigationStack(path: $path) {
            list
                .navigationTitle("Settings")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { done }
                }
                .navigationDestination(for: SettingsSection.self) { item in
                    SettingsPage(fleet: fleet, section: item, header: .none)
                        .navigationTitle(item.title)
                        .navigationBarTitleDisplayMode(.inline)
                }
        }
        #endif
    }

    private var list: some View {
        List {
            Section {
                ForEach(SettingsSection.allCases) { item in
                    Button {
                        path = [item]
                        // Where a wider window, or the next opening there, shows it.
                        section = item
                    } label: {
                        HStack(spacing: Theme.grid * 1.5) {
                            SettingsIcon(section: item)
                            Text(item.title)
                                .foregroundStyle(.primary)
                            Spacer(minLength: Theme.grid)
                            Image(systemName: "chevron.forward")
                                .font(.app.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .listRowOnMac()
                    .accessibilityIdentifier("settings-section-\(item.rawValue)")
                }
            } footer: {
                Text(AboutSettings.appVersion)
                    .formFooter()
            }
            .settingsRows()
        }
        .modifier(SettingsSurface())
    }

    private var done: some View {
        Button("Done", action: onClose)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("settings-close")
    }
}

// MARK: A part

/// A part of Settings, under its title.
struct SettingsPage: View {
    /// What is over the part.
    enum Header {
        /// Nothing: the navigation stack's bar has its title.
        case none
        /// Its title in a bar of its own: on a Mac, up in the window's bar.
        case bar
        /// Its title, with Settings to go back to the list of parts and Done to close
        /// Settings (a narrow Mac window).
        case back(() -> Void, close: () -> Void)
    }

    let fleet: Fleet
    let section: SettingsSection
    let header: Header

    var body: some View {
        switch header {
        case .none:
            content
        case .bar:
            content
                .safeAreaInset(edge: .top, spacing: 0) { SettingsBar(title: section.title) }
                .ignoresSafeArea(.container, edges: Platform.isMac ? .top : [])
        case let .back(back, close):
            content
                .safeAreaInset(edge: .top, spacing: 0) {
                    SettingsBar(
                        title: section.title,
                        leading: AnyView(
                            Button(action: back) {
                                Label("Settings", systemImage: "chevron.backward")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("settings-back")
                        ),
                        // Esc closes Settings from a part as from the list.
                        trailing: AnyView(
                            Button("Done", action: close)
                                .buttonStyle(.borderedCapsule)
                                .keyboardShortcut(.cancelAction)
                                .accessibilityIdentifier("settings-close")
                        )
                    )
                }
                .ignoresSafeArea(.container, edges: Platform.isMac ? .top : [])
        }
    }

    private var content: some View {
        Group {
            switch section {
            case .net: NetSettings(fleet: fleet)
            case .chat: ChatSettings(fleet: fleet)
            case .agents: AgentSettings(fleet: fleet)
            case .notifications: NotificationSettings(fleet: fleet)
            case .appearance: AppearanceSettings(fleet: fleet)
            case .about: AboutSettings(fleet: fleet)
            }
        }
        .formStyle(.grouped)
        .modifier(SettingsSurface())
        .modifier(SettingsSwitches())
        .modifier(PageColumn())
    }
}

/// On a Mac, a part's page in `SettingsScreen.background`, not the form's grey (its rows
/// say their own colour, `settingsRows`). Elsewhere the form's own look. The folder sheet
/// is drawn so too.
struct SettingsSurface: ViewModifier {
    func body(content: Content) -> some View {
        #if targetEnvironment(macCatalyst)
        content
            .scrollContentBackground(.hidden)
            .background(SettingsScreen.background)
        #else
        content
        #endif
    }
}

extension View {
    /// A section's rows in `SettingsScreen.rowFill` on a Mac, where the page is no longer
    /// the form's grey (`SettingsSurface`); the system's elsewhere.
    func settingsRows() -> some View {
        #if targetEnvironment(macCatalyst)
        listRowBackground(SettingsScreen.rowFill)
        #else
        self
        #endif
    }
}

/// Switches in the system's green on an iPhone and iPad: in the app's tint, the label's
/// colour, a switch that is on is white on white in dark mode. A Mac keeps its checkboxes.
private struct SettingsSwitches: ViewModifier {
    func body(content: Content) -> some View {
        #if targetEnvironment(macCatalyst)
        content
        #else
        content.toggleStyle(SwitchToggleStyle(tint: .green))
        #endif
    }
}

/// A part's rows in a column of a readable width on a wide window, its scrolling the
/// whole page's; a form's own margins on a narrower one.
private struct PageColumn: ViewModifier {
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .contentMargins(.horizontal, width > Self.widest + Theme.margin * 2 ? (width - Self.widest) / 2 : nil, for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    static let widest: CGFloat = 680
}

/// The bar over a part: its title in the middle, and what may go at either end. On a Mac
/// it is the window's bar, its leading end clear of the window's buttons.
private struct SettingsBar: View {
    let title: String
    var leading: AnyView?
    var trailing: AnyView?

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ZStack {
            Text(title)
                .font(.app.headline)
                .lineLimit(1)
                .padding(.horizontal, Theme.grid * 12)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: Theme.grid) {
                if Platform.isMac, leading != nil {
                    // The window's buttons.
                    Spacer().frame(width: 62)
                }
                leading
                Spacer(minLength: 0)
                trailing
            }
            .font(.app.body)
        }
        .padding(.horizontal, Theme.grid * 1.5)
        .frame(height: WindowLayout.windowBar)
        .frame(maxWidth: .infinity)
        .background(SettingsScreen.background)
        // A rule, not a `Divider`: in the wide layout's row that would stand upright.
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(uiColor: .separator))
                .frame(height: 1 / displayScale)
        }
    }
}
