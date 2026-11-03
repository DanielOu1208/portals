import SwiftUI

/// Design tokens. Use these instead of literal numbers so the whole app moves
/// together when the styling is tuned on device.
///
/// - Controls are monochrome: the root view applies `.tint(Theme.tint)`.
/// - Content cards are solid (`Theme.cardFill`) with 24 pt continuous corners.
///   Liquid Glass is for floating controls only, never for cards.
/// - Margins are 20 pt horizontal on an 8 pt grid.
enum Theme {
    /// The accent: the primary label colour (black in light mode, white in dark).
    static let tint: Color = .primary

    /// Horizontal page margin.
    static let margin: CGFloat = 20
    /// The layout grid. Vertical spacing is a multiple of this.
    static let grid: CGFloat = 8

    /// Space added between the lines of a reply's text. A Mac's screen is read from
    /// further away, in longer lines, which read tight at the text's own leading.
    static let proseLineSpacing: CGFloat = Platform.isMac ? 5 : 0
    /// Space between the blocks of a reply: paragraphs, lists, code, tables; 2 points more
    /// since 2026-11-01 (the ask).
    static let blockSpacing: CGFloat = Platform.isMac ? 20 : grid * 1.25 + 2
    /// Spacing between stacked cards.
    static let cardSpacing: CGFloat = 16
    /// Inner padding of a content card.
    static let cardPadding: CGFloat = 20

    /// Corner radius of content cards, with `.continuous` corners.
    static let cardRadius: CGFloat = 24
    static let cardShape = RoundedRectangle(cornerRadius: cardRadius, style: .continuous)

    // The app's surfaces. On an iPhone and iPad they are the system's backgrounds. A
    // Mac's are a desk app's window greys, which leave dark mode grey where an iPhone is
    // black, so there each is set to the value the iPhone has for it (`surface`).

    /// Solid card fill.
    nonisolated static let cardFill = surface(.secondarySystemGroupedBackground, light: 0xFFFFFF, dark: 0x1C1C1E)
    /// The page behind cards, and what the blue wash fades into.
    nonisolated static let pageBackground = surface(.systemGroupedBackground, light: 0xF2F2F7, dark: 0x000000)
    /// A well set into a card: the box a command is shown in.
    nonisolated static let insetFill = surface(.tertiarySystemGroupedBackground, light: 0xF2F2F7, dark: 0x2C2C2E)
    /// The plain background: the sidebar, and the label of a button filled in the label
    /// colour.
    nonisolated static let plainBackground = surface(.systemBackground, light: 0xFFFFFF, dark: 0x000000)
    /// What a small thing stands out on, over any of the others: a logo's badge.
    nonisolated static let raisedBackground = surface(.tertiarySystemBackground, light: 0xFFFFFF, dark: 0x2C2C2E)
    /// The label colour as a fill: a prominent button's capsule, under a label in
    /// `plainBackground`. On a Mac set to black or white: the system's label colour as a
    /// fill greys in a window that is not in front, where `plainBackground` stays, and a
    /// black label on dark grey was as grey as the quiet buttons beside it.
    nonisolated static let ink = surface(.label, light: 0x000000, dark: 0xFFFFFF)

    private nonisolated static func surface(_ system: UIColor, light: UInt32, dark: UInt32) -> Color {
        #if targetEnvironment(macCatalyst)
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
        #else
        Color(uiColor: system)
        #endif
    }

    /// Share of the screen height the blue wash covers at rest.
    static let gradientHeightFraction: CGFloat = 0.45
}

extension View {
    /// A solid content card: `secondarySystemGroupedBackground`, 24 pt continuous corners.
    func cardSurface(padding: CGFloat = Theme.cardPadding) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.cardFill, in: Theme.cardShape)
    }

    /// The 20 pt horizontal page margin.
    func pageMargins() -> some View {
        padding(.horizontal, Theme.margin)
    }
}

/// The app's text styles. Views set their type in these, not in the system's own:
/// `.font(.app.footnote)`, not `.font(.footnote)`.
///
/// - On an iPhone and iPad they are the system's, and follow Dynamic Type.
/// - On a Mac the system's are a desk app's small sizes (13 pt for body), next to
///   controls drawn as large as on an iPhone, and nothing scales them: the reader's
///   text size is not a Mac's setting. There they are the iPhone's sizes, a little
///   reduced (`macScale`), which is the one number to tune them all by.
nonisolated struct AppTextStyles: Sendable {
    var largeTitle: Font { font(.largeTitle) }
    var title: Font { font(.title) }
    var title2: Font { font(.title2) }
    var title3: Font { font(.title3) }
    var headline: Font { font(.headline) }
    var body: Font { font(.body) }
    var callout: Font { font(.callout) }
    var subheadline: Font { font(.subheadline) }
    var footnote: Font { font(.footnote) }
    var caption: Font { font(.caption) }
    var caption2: Font { font(.caption2) }

    func font(_ style: Font.TextStyle) -> Font {
        guard let size = Self.fixedSize(of: style) else { return .system(style) }
        return .system(size: size, weight: style == .headline ? .semibold : .regular)
    }

    /// A Mac's text against an iPhone's at the standard text size.
    static let macScale = 0.95

    /// The size of `style` in points where the app sets it itself (a Mac); nil where the
    /// system does, by the reader's text size.
    static func fixedSize(of style: Font.TextStyle) -> CGFloat? {
        #if targetEnvironment(macCatalyst)
        let phone: CGFloat = switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 17
        }
        // To the half point: a Mac's screen draws those sharply.
        return (phone * macScale * 2).rounded() / 2
        #else
        return nil
        #endif
    }
}

extension Font {
    /// The app's text styles (`AppTextStyles`).
    nonisolated static let app = AppTextStyles()
}

extension View {
    /// Text that names no style of its own is set in the app's body. Only a Mac needs
    /// telling: elsewhere that is the system's body already.
    func appDefaultFont() -> some View {
        #if targetEnvironment(macCatalyst)
        font(.app.body)
        #else
        self
        #endif
    }
}

extension View {
    /// What a sheet's content asks for on a Mac, where a sheet is a small panel of one
    /// size unless its content says how much room it wants. Nothing elsewhere.
    func sheetOnMac(width: CGFloat = 540, height: CGFloat = 640) -> some View {
        #if targetEnvironment(macCatalyst)
        frame(minWidth: width, idealWidth: width, minHeight: height, idealHeight: height)
            .presentationSizing(.fitted)
        #else
        self
        #endif
    }

    /// A sheet showing `panel` while `value` is set, except on a Mac: there a panel drawn
    /// in the window over a dimmed backdrop, `width` wide and at most `height` high. A
    /// Mac's sheet takes no click outside it (the window behind is held while it is up),
    /// and its Done was seen not to close it: the panel closes on a click on the backdrop,
    /// on Esc and on its Done (2026-10-16). `close`, which the panel's
    /// Done calls, sets `value` to nil, either way.
    func sheetOrPanel<Value: Hashable, Panel: View>(
        _ value: Binding<Value?>, width: CGFloat, height: CGFloat = 640,
        @ViewBuilder panel: @escaping (Value, _ close: @escaping () -> Void) -> Panel
    ) -> some View {
        modifier(SheetOrPanel(value: value, width: width, height: height, panel: panel))
    }

    /// A menu shown as its label alone, on a Mac too, which otherwise boxes it as a
    /// pop-up button with an arrow beside it.
    func plainMenuOnMac() -> some View {
        #if targetEnvironment(macCatalyst)
        menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
        #else
        self
        #endif
    }

    /// Room above and below a list's row on a Mac, where a list sets its rows as close
    /// as a desk app's and a row of two or three lines touches its edges. Nothing
    /// elsewhere: the system's own room is right there.
    func listRowOnMac() -> some View {
        #if targetEnvironment(macCatalyst)
        padding(.vertical, Theme.grid * 0.75)
        #else
        self
        #endif
    }

    /// The header of a form's section. The system styles it everywhere but on a Mac,
    /// where it would take the app's body type (`appDefaultFont`).
    func formHeader() -> some View {
        #if targetEnvironment(macCatalyst)
        font(.app.subheadline.weight(.semibold))
        #else
        self
        #endif
    }

    /// The footer under a form's section; as `formHeader`.
    func formFooter() -> some View {
        #if targetEnvironment(macCatalyst)
        font(.app.footnote)
        #else
        self
        #endif
    }
}

/// `.borderedProminent` in the monochrome tint. The tint is the primary label
/// colour, white in dark mode, and the system draws a prominent button's label
/// white too, so it would vanish on the white capsule. Here the label takes the
/// background colour instead: white on black in light mode, black on white in
/// dark. Disabled, it's tertiary on the system's dimmed fill.
///
///     Button("Try again") { … }
///         .buttonStyle(.monochromeProminent)
///         .buttonBorderShape(.capsule)
///
/// On a Mac the app draws the capsule itself (`MacCapsuleButtonStyle`).
struct MonochromeProminentButtonStyle: PrimitiveButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        #if targetEnvironment(macCatalyst)
        Button(role: configuration.role) {
            configuration.trigger()
        } label: {
            configuration.label
        }
        .buttonStyle(MacCapsuleButtonStyle(isProminent: true))
        #else
        Button(role: configuration.role) {
            configuration.trigger()
        } label: {
            configuration.label
                .foregroundStyle(isEnabled ? AnyShapeStyle(Theme.plainBackground) : AnyShapeStyle(.tertiary))
        }
        .buttonStyle(.borderedProminent)
        #endif
    }
}

extension PrimitiveButtonStyle where Self == MonochromeProminentButtonStyle {
    /// `.borderedProminent` with a label that stays readable in the monochrome tint.
    static var monochromeProminent: MonochromeProminentButtonStyle { MonochromeProminentButtonStyle() }
}

/// `.bordered` as a capsule: the app's quiet button, beside a prominent one or by
/// itself. On a Mac the app draws it (`MacCapsuleButtonStyle`).
///
///     Button("Try again") { … }
///         .buttonStyle(.borderedCapsule)
struct BorderedCapsuleButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let button = Button(role: configuration.role) {
            configuration.trigger()
        } label: {
            configuration.label
        }
        #if targetEnvironment(macCatalyst)
        button.buttonStyle(MacCapsuleButtonStyle(isProminent: false))
        #else
        button
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
        #endif
    }
}

extension PrimitiveButtonStyle where Self == BorderedCapsuleButtonStyle {
    /// `.bordered`, as a capsule.
    static var borderedCapsule: BorderedCapsuleButtonStyle { BorderedCapsuleButtonStyle() }
}

/// The app's capsule buttons as a Mac draws them. The system's bordered buttons are a
/// desk app's small push buttons there, whatever shape and size they are asked for, so
/// the capsule is drawn here: the label colour filled for the prominent one, a faint
/// fill for the quiet one, and smaller for `.controlSize(.small)`.
struct MacCapsuleButtonStyle: ButtonStyle {
    let isProminent: Bool

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.controlSize) private var controlSize

    func makeBody(configuration: Configuration) -> some View {
        let isSmall = controlSize == .small || controlSize == .mini
        configuration.label
            .foregroundStyle(label(configuration.role))
            .padding(.horizontal, Theme.grid * (isSmall ? 1.5 : 2.25))
            .padding(.vertical, Theme.grid * (isSmall ? 0.625 : 1.125))
            .background(fill, in: .capsule)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(.capsule)
    }

    // Black or white itself (`Theme.ink`), not the style `.primary` or the label colour:
    // inside a button the first follows the tint and the second greys, as a Mac greys
    // both in every window but the one in front, where the label on it does not.
    private var fill: Color {
        isProminent && isEnabled ? Theme.ink : Color(uiColor: .tertiarySystemFill)
    }

    private func label(_ role: ButtonRole?) -> Color {
        if !isEnabled { return Color(uiColor: .tertiaryLabel) }
        if isProminent { return Theme.plainBackground }
        return role == .destructive ? .red : .primary
    }
}

/// A row in a list of choices (models, commands) that highlights while pressed.
struct PressedRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color(uiColor: .tertiarySystemFill) : .clear)
    }
}

extension Color {
    /// An sRGB colour from a 24-bit hex literal, e.g. `Color(hex: 0xFFD8B5)`.
    nonisolated init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// `sheetOrPanel`.
private struct SheetOrPanel<Value: Hashable, Panel: View>: ViewModifier {
    @Binding var value: Value?
    let width: CGFloat
    let height: CGFloat
    let panel: (Value, @escaping () -> Void) -> Panel

    func body(content: Content) -> some View {
        let isOpen = value != nil
        #if targetEnvironment(macCatalyst)
        // What is under the panel takes no keys and is not read out while it is open: a
        // composer that kept the keyboard would take what is typed, and Return send it.
        content
            .disabled(value != nil)
            .accessibilityHidden(value != nil)
            .overlay {
                GeometryReader { proxy in
                    if let shown = value {
                        ZStack {
                            Color.black.opacity(0.3)
                                .contentShape(.rect)
                                .onTapGesture { value = nil }
                                .accessibilityElement()
                                .accessibilityLabel("Close")
                                .accessibilityAddTraits(.isButton)
                                .accessibilityAction { value = nil }
                                .accessibilityIdentifier("panel-backdrop")
                            panel(shown) { value = nil }
                                .frame(
                                    width: min(width, proxy.size.width - Theme.grid * 4),
                                    height: min(height, proxy.size.height - Theme.grid * 4)
                                )
                                .background(Color(uiColor: .systemGroupedBackground))
                                .clipShape(.rect(cornerRadius: Self.corner, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                                        .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5)
                                }
                                .shadow(color: .black.opacity(0.35), radius: 24, y: 8)
                                .accessibilityAddTraits(.isModal)
                        }
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .transition(.opacity)
                    }
                }
                .ignoresSafeArea()
                .allowsHitTesting(value != nil)
                .animation(.smooth(duration: 0.2), value: value)
            }
            .transformPreference(PanelOpenKey.self) { if isOpen { $0 = true } }
        #else
        content.sheet(isPresented: Binding(get: { value != nil }, set: { if !$0 { value = nil } })) {
            if let shown = value {
                panel(shown) { value = nil }
            }
        }
        .transformPreference(PanelOpenKey.self) { if isOpen { $0 = true } }
        #endif
    }

    private static var corner: CGFloat { 12 }
}

/// Whether a sheet or panel (`sheetOrPanel`) is open over a view, or over any part of it;
/// or a reply's image opened on its own over the window (`ImageLightbox`, said by
/// `showsFilesHere`). The chat reads it for its composer, whose focus a Mac's panel takes
/// while it is open (the chat under it is disabled), and the image too, and gives back as
/// it closes (`FocusWithApp`).
struct PanelOpenKey: PreferenceKey {
    static let defaultValue = false

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// A sheet's or a panel's frame (`sheetOrPanel`): its title over it and Done at its end,
/// which Esc presses too. In a navigation stack's bar on an iPhone and an iPad; on a Mac,
/// where a stack in the window would give its bar to the window's own, a header of the
/// panel's own (a sheet's Cancel in the window's bar was cut to "C…").
struct PanelChrome<Content: View, Action: View>: View {
    let title: String
    var doneIdentifier = "panel-done"
    /// Cancel in place of Done, for a sheet left without choosing anything: at the start of
    /// the bar on an iPhone and an iPad, as a sheet's Cancel is; at its end on a Mac, as Done.
    var cancels = false
    /// The button's own word in place of Cancel or Done: Back, on a page of the panel
    /// with one to go back to.
    var doneTitle: String?
    let onDone: () -> Void
    /// What the sheet is for, beside Cancel (Add, Save), at the end of the bar, and Cancel
    /// at its start, on a Mac too; nil while there is none to do.
    var action: Action?
    @ViewBuilder let content: Content

    /// A panel that has an action, shown or not: Cancel keeps to the start of the bar.
    private var hasAction: Bool { Action.self != EmptyView.self }

    var body: some View {
        #if targetEnvironment(macCatalyst)
        VStack(spacing: 0) {
            ZStack {
                Text(title)
                    .font(.app.headline)
                    .lineLimit(1)
                    .padding(.horizontal, Theme.grid * 10)
                    .accessibilityAddTraits(.isHeader)
                HStack {
                    if hasAction { done }
                    Spacer()
                    if !hasAction {
                        done
                    } else if let action {
                        action
                    }
                }
                .buttonStyle(.borderedCapsule)
            }
            .padding(.horizontal, Theme.grid * 1.5)
            .frame(height: WindowLayout.windowBar)
            Divider()
            // All the room under the bar: content that does not fill it (a sheet's "No
            // sessions") had the bar and itself in the middle of the sheet.
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #else
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: cancels ? .cancellationAction : .confirmationAction) { done }
                    if let action {
                        ToolbarItem(placement: .confirmationAction) { action }
                    }
                }
        }
        #endif
    }

    private var done: some View {
        Button(doneTitle ?? (cancels ? "Cancel" : "Done"), action: onDone)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier(doneIdentifier)
    }
}

extension PanelChrome where Action == EmptyView {
    /// A panel with Done (or Cancel) only.
    init(title: String, doneIdentifier: String = "panel-done", cancels: Bool = false, doneTitle: String? = nil, onDone: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.init(title: title, doneIdentifier: doneIdentifier, cancels: cancels, doneTitle: doneTitle, onDone: onDone, action: nil, content: content)
    }
}
