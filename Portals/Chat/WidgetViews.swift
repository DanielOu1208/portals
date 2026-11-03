import AgentCore
import SwiftUI
import UIKit

/// A widget in a reply (`MarkdownWidget`): its page right in the reply, on the chat's
/// own background and in line with its text, under a line with its title, Expand and a
/// menu; as tall as the page says it is, or as it was the last time before it has said.
/// While the agent is still writing it, it is drawn as far as it goes, with how much is
/// written in place of Expand and the menu.
struct WidgetBlockView: View {
    let widget: MarkdownWidget
    let key: WidgetKey
    /// Whether the reply is still being written.
    let isBeingWritten: Bool

    var body: some View {
        if widget.isTooLarge {
            WidgetSourceView(widget: widget, title: "Too large to show as a visual")
        } else if widget.isComplete || isBeingWritten {
            // The same views while it is written and once it is finished, so the page
            // being drawn stays where it is when its scripts start.
            let session = WidgetPool.shared.session(for: key, widget: widget)
            if let failure = session.failure {
                // Given up on (a script that never ends, a page whose process keeps
                // ending): a small card that says so and can try again, rather than the
                // orb for ever.
                WidgetGivenUpView(session: session, failure: failure)
            } else {
                VStack(alignment: .leading, spacing: Theme.grid / 2) {
                    WidgetTitleLine(title: widget.title) {
                        if widget.isComplete {
                            WidgetActions(session: session)
                        } else {
                            WidgetProgress(source: widget.source)
                        }
                    }
                    WidgetFrame(session: session)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(widget.title.map { "Visual: \($0)" } ?? "Visual")
            }
        } else {
            // The reply ended inside it.
            WidgetSourceView(widget: widget, title: "Unfinished visual")
        }
    }
}

/// Where a visual will go while the agent plans it ("Planning a visual…"): the orb in the
/// room a visual being written starts with, under the line its title will be in, so that
/// the visual takes its place without moving the chat. A page is made ready meanwhile,
/// so that drawing the visual waits for no process to start.
struct VisualPlanningView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid / 2) {
            // The line under the turn says what it is waiting for.
            WidgetTitleLine(title: nil) { EmptyView() }
            ThinkingOrbView()
                .frame(maxWidth: .infinity)
                .frame(height: WidgetSizing.draftFloor)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Planning a visual")
        .onAppear { WidgetPool.shared.warm() }
    }
}

/// A widget's title, small and quiet, with what can be done with it at the end.
private struct WidgetTitleLine<Actions: View>: View {
    let title: String?
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: Theme.grid) {
            Text(title ?? "Visual")
                .lineLimit(1)
            Spacer(minLength: Theme.grid)
            actions()
        }
        .font(.app.caption.weight(.medium))
        .foregroundStyle(.secondary)
    }
}

/// Expand, and a menu with Copy Source and Reload.
private struct WidgetActions: View {
    let session: WidgetSession

    @Environment(\.widgetExpander) private var expander

    var body: some View {
        HStack(spacing: Theme.grid / 2) {
            if let expander {
                Button("Expand", systemImage: "arrow.up.left.and.arrow.down.right") { expander.expand(session) }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 28, minHeight: 24)
                    .contentShape(.rect)
                    .accessibilityIdentifier("widget-expand")
                    #if DEBUG
                    .task {
                        // `PORTALS_DEBUG_EXPAND_VISUAL`: the first visual opens expanded.
                        guard let delay = DebugLaunch.expandsFirstVisualAfter, !WidgetExpander.debugExpandedOne else { return }
                        WidgetExpander.debugExpandedOne = true
                        try? await Task.sleep(for: .seconds(delay))
                        expander.expand(session)
                    }
                    #endif
            }
            Menu {
                Button("Copy Source", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = session.widget.source
                }
                Button("Reload", systemImage: "arrow.clockwise") { session.reload() }
            } label: {
                Label("More", systemImage: "ellipsis")
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 28, minHeight: 24)
                    .contentShape(.rect)
            }
            .plainMenuOnMac()
            .accessibilityIdentifier("widget-menu")
        }
        .buttonStyle(.plain)
    }
}

/// A visual given up on (`WidgetFailure`), in its place: its title line, and a small card
/// with what happened and Try again, which draws only this visual again from the reply's
/// own source (`WidgetPool.tryAgain`), sending nothing to the agent (2026-10-22:
/// "the button shouldnt reprompt the prompt that started the thread should just prompt
/// to retry visual"). Its source stays a menu away: Copy Source, Show Source.
private struct WidgetGivenUpView: View {
    let session: WidgetSession
    let failure: WidgetFailure

    /// Kept by the chat (`OpenRows`), not the row: open on a long visual, its source
    /// closed again when the turn was let go of far from the screen and made anew, and
    /// the turn came back shorter than it was remembered.
    @RowOpen private var showsSource: Bool

    init(session: WidgetSession, failure: WidgetFailure) {
        self.session = session
        self.failure = failure
        _showsSource = RowOpen(.visualSource(turn: session.key.turn, segment: session.key.segment, block: session.key.block), initially: false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid / 2) {
            WidgetTitleLine(title: session.widget.title) {
                Menu {
                    Button("Copy Source", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = session.widget.source
                    }
                    Button(showsSource ? "Hide Source" : "Show Source", systemImage: "chevron.left.forwardslash.chevron.right") {
                        showsSource.toggle()
                    }
                } label: {
                    Label("More", systemImage: "ellipsis")
                        .labelStyle(.iconOnly)
                        .frame(minWidth: 28, minHeight: 24)
                        .contentShape(.rect)
                }
                .plainMenuOnMac()
                .buttonStyle(.plain)
                .accessibilityIdentifier("widget-menu")
            }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Theme.grid) {
                    Label(failure.title, systemImage: "exclamationmark.triangle")
                        .labelStyle(.titleAndIcon)
                        .font(.app.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("widget-given-up")
                    Spacer(minLength: Theme.grid)
                    // Offered `WidgetPool.triesAllowed` times; after that the card only
                    // says so.
                    if WidgetPool.shared.canTryAgain(session) {
                        Button("Try again") {
                            WidgetPool.shared.tryAgain(session)
                        }
                        .font(.app.callout.weight(.medium))
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("widget-try-again")
                    } else {
                        Text("Tried \(WidgetPool.triesAllowed) times")
                            .font(.app.caption)
                            .foregroundStyle(.tertiary)
                            .accessibilityIdentifier("widget-tried-out")
                    }
                }
                .padding(.horizontal, Theme.grid * 1.5)
                .padding(.vertical, Theme.grid)
                if showsSource {
                    Divider()
                    SidewaysText(text: session.widget.source, font: .app.caption.monospaced())
                }
            }
            .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(session.widget.title.map { "Visual: \($0)" } ?? "Visual")
    }
}

/// A widget's HTML as code, where it cannot be drawn.
private struct WidgetSourceView: View {
    let widget: MarkdownWidget
    let title: String

    var body: some View {
        CopyableBlock(title: title, copies: widget.source) {
            SidewaysText(text: widget.source, font: .app.callout.monospaced())
        }
    }
}

/// How much of a widget is written, while it is: "Drawing · 120 lines".
private struct WidgetProgress: View {
    let source: String

    var body: some View {
        HStack(spacing: Theme.grid / 2) {
            ProgressView()
                .controlSize(.mini)
            Text("Drawing · \(lines) \(lines == 1 ? "line" : "lines")")
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }

    private var lines: Int {
        source.utf8.reduce(1) { $1 == UInt8(ascii: "\n") ? $0 + 1 : $0 }
    }
}

/// The page, as tall as it was measured at this width, here or the last time, before it
/// has said. Until the page is worth looking at (`WidgetSession.isPresentable`), the orb
/// stands over it, and the page is drawn faded under the orb as the agent writes it, so
/// that the visual can be watched taking shape (a page that shows nothing yet shows
/// nothing); faded, it takes no touch, and the chat scrolls over it. Once it is worth
/// looking at, the page comes up to full and the orb fades away, in one move.
private struct WidgetFrame: View {
    let session: WidgetSession

    /// The width it is shown at, to find the height it had there.
    @State private var width: CGFloat?
    @Environment(\.widgetLayoutWidth) private var layoutWidth
    /// How near the chat's view it is: until its first layout says, away, so that a reply
    /// with many visuals makes pages only for those near the screen.
    @State private var sight = WidgetSight.away

    @Environment(\.colorScheme) private var colorScheme
    /// Its chat is kept out of sight behind the one on screen (`ChatScreen.isShown`): its
    /// page is out of the window meanwhile, as one far from the screen is, and does nothing.
    @Environment(\.isOutOfSight) private var isOutOfSight

    var body: some View {
        let isPresentable = session.isPresentable
        // The page is drawn under the orb whether it is seen or not: showing it faded
        // only changes how it is put on the screen.
        WidgetWebHost(session: session, sight: isOutOfSight ? .away : sight, takesTouches: isPresentable)
            .opacity(isPresentable ? 1 : draftOpacity)
            .allowsHitTesting(isPresentable)
            // The web view's own elements (a draft's sliders) reach VoiceOver past the host
            // view's hiding: hidden here too while it is faded.
            .accessibilityHidden(!isPresentable)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .overlay(alignment: .top) {
                // Where it is while the agent plans the visual, however tall the page
                // grows meanwhile.
                if !isPresentable {
                    ThinkingOrbView()
                        .background { DraftClearing() }
                        .frame(maxWidth: .infinity)
                        .frame(height: WidgetSizing.draftFloor)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.3), value: isPresentable)
            .animation(nil, value: height)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .onGeometryChange(for: WidgetSight.self) { WidgetSight($0) } action: { sight = $0 }
    }

    /// How much of the page shows under the orb before it is worth looking at: enough to
    /// see it being drawn, little enough that it reads as not ready yet. A touch less on a
    /// dark background, where light text stands out more.
    private var draftOpacity: Double {
        colorScheme == .dark ? 0.35 : 0.4
    }

    private var height: CGFloat {
        if let fixed = session.widget.height { return WidgetSizing.shown(CGFloat(fixed)) }
        // Being written, it grows from a little room as it is drawn; finished before it
        // showed anything, it keeps that room under the orb until its script has drawn it.
        if session.isDraft || session.keepsDraftRoom && !session.isPresentable {
            return WidgetSizing.shown(max(session.measured?.height ?? 0, WidgetSizing.draftFloor))
        }
        let width = width ?? (layoutWidth > 0 ? layoutWidth : nil)
        let measured = session.measured
        if let measured, width.map({ abs($0 - measured.width) < WidgetHeights.widthStep }) ?? true {
            return WidgetSizing.shown(measured.height)
        }
        if let width, let remembered = WidgetHeightStore.shared.height(for: session.key.source, width: width) {
            return WidgetSizing.shown(remembered)
        }
        return WidgetSizing.shown(measured?.height ?? WidgetSizing.guess)
    }
}

/// A soft clearing of the chat's background behind the orb over a faded page, so that the
/// orb reads clearly over what is drawn under it. Still, and drawn once.
private struct DraftClearing: View {
    var body: some View {
        RadialGradient(
            stops: [
                .init(color: Theme.pageBackground.opacity(0.9), location: 0),
                .init(color: Theme.pageBackground.opacity(0.7), location: 0.55),
                .init(color: Theme.pageBackground.opacity(0), location: 1),
            ],
            center: .center, startRadius: 0, endRadius: WidgetSizing.draftFloor / 2
        )
        .frame(width: WidgetSizing.draftFloor, height: WidgetSizing.draftFloor)
        .allowsHitTesting(false)
    }
}

/// Where the page's web view is put; the view moves on to the next row that shows the
/// same widget (`WidgetPool`), and to the expanded view and back.
private struct WidgetWebHost: UIViewRepresentable {
    let session: WidgetSession
    var sight = WidgetSight.seen
    var isExpanded = false
    /// Whether the page takes touches (`WidgetHostView.takesTouches`).
    var takesTouches = true

    func makeUIView(context: Context) -> WidgetHostView {
        let view = WidgetHostView(expanded: isExpanded)
        view.sight = sight
        return view
    }

    func updateUIView(_ view: WidgetHostView, context: Context) {
        view.sight = sight
        view.takesTouches = takesTouches
        view.show(session)
    }

    static func dismantleUIView(_ view: WidgetHostView, coordinator: ()) {
        view.show(nil)
    }
}

// MARK: - Expanded

extension EnvironmentValues {
    /// Opens a widget expanded, over the chat (`expandsWidgetsHere`); nil where there is
    /// nowhere to open it. An object, the same for as long as the chat is shown: a
    /// closure made at each redraw would redraw every widget's title line with each word
    /// of a reply.
    @Entry var widgetExpander: WidgetExpander? = nil
}

extension View {
    /// Opens a widget expanded from here, as large as the screen or a panel in the window
    /// allows, instead of from its row, which the chat lets go of far from the screen.
    /// The page moves there as it is, and back into its row when it is closed.
    func expandsWidgetsHere() -> some View {
        modifier(ExpandsWidgetsHere())
    }
}

/// The widget open expanded, if one is.
@MainActor
@Observable
final class WidgetExpander {
    fileprivate var expanded: Expanded?
    #if DEBUG
    /// `PORTALS_DEBUG_EXPAND_VISUAL` opened one already.
    static var debugExpandedOne = false
    #endif

    func expand(_ session: WidgetSession) {
        expanded = Expanded(session: session)
    }

    fileprivate struct Expanded: Hashable {
        let id = UUID()
        let session: WidgetSession

        static func == (a: Self, b: Self) -> Bool { a.id == b.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
}

private struct ExpandsWidgetsHere: ViewModifier {
    @State private var expander = WidgetExpander()

    func body(content: Content) -> some View {
        @Bindable var expander = expander
        content
            .environment(\.widgetExpander, expander)
            // However it is closed (Done, a swipe, Esc, a click beside it), the page goes
            // back to its row at once.
            .onChange(of: expander.expanded) { old, new in
                if let old, old != new { old.session.closeExpanded() }
            }
            .sheetOrPanel($expander.expanded, width: 960, height: 760) { expanded, close in
                PanelChrome(title: expanded.session.widget.title ?? "Visual", doneIdentifier: "widget-done", onDone: close) {
                    // On the chat's background, which the page's colours are made for.
                    // A view of its own each time it is opened: the one closed last may
                    // still be leaving (`WidgetHostView.leave`) when it is opened again.
                    WidgetWebHost(session: expanded.session, isExpanded: true)
                        .id(expanded.id)
                        .padding(.horizontal, ChatFeature.margin + Theme.grid)
                        .padding(.vertical, Theme.grid)
                        .background(Theme.pageBackground)
                }
                .presentationDetents([.large])
                .presentationBackground(Theme.pageBackground)
            }
    }
}
