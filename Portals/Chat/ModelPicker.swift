import AgentCore
import SwiftUI

/// The composer's model chip: the model a thread runs on and how hard it thinks, like
/// Codex's effort button. Tap it for a popover with the models in a list, a search field
/// over them when there are many, and under them the level in large type and a slider
/// across the levels, coloured warm to cool as the level rises. A choice applies to this
/// thread only.
///
/// Adapted from Mimo's picker in Ryoko (`MimoModelPicker.swift`).
struct ModelChip: View {
    let catalog: ModelCatalog
    /// What the thread runs on now.
    let setting: ModelSetting
    /// The height of the composer's buttons, to line up with them.
    let height: CGFloat
    @Binding var isPresented: Bool
    var onPickModel: (_ model: String, _ provider: String) -> Void
    var onPickLevel: (ThinkingLevel) -> Void
    var onReset: () -> Void

    @State private var shown = ChipShown()
    /// The chip's size, and the size it had when the popover opened. The popover points at
    /// the chip as it was then, so it stays where it opened while the words in the chip
    /// change under it (a level or a model picked in it): it pointed at the chip's middle,
    /// which moved with them (2026-10-23: changing the level moved the open
    /// picker; it should keep its place until a click outside closes it).
    @State private var size = CGSize.zero
    @State private var openedSize: CGSize?

    /// The level the chip names: none for a model that takes none (Cursor's Auto).
    private var shownLevel: ThinkingLevel? {
        catalog.takesLevels(setting.model) ? setting.level : nil
    }

    var body: some View {
        Button { isPresented = true } label: {
            HStack(spacing: 3) {
                // A long name gives way in its middle, where the two ends still tell
                // the models apart.
                Text(catalog.shortName(of: setting))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let level = shownLevel {
                    Text("· \(level.title)")
                        .fixedSize()
                        .contentTransition(.opacity)
                }
                Image(systemName: "chevron.down")
                    .font(.app.caption2.weight(.bold))
                    .imageScale(.small)
            }
            .font(.app.footnote.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, Theme.grid * 0.75)
            .frame(height: height)
            .contentShape(.rect)
        }
        .dropdownChipStyle { isPresented = true }
        .accessibilityLabel("Model")
        .accessibilityValue([catalog.shortName(of: setting), shownLevel?.title].compactMap(\.self).joined(separator: ", "))
        .accessibilityHint("Changes the model and how hard it thinks, for this thread")
        .accessibilityIdentifier("model-chip")
        .onGeometryChange(for: CGSize.self, of: \.size) { size = $0 }
        .onChange(of: isPresented, initial: true) { openedSize = isPresented ? size : nil }
        .popover(
            isPresented: $isPresented,
            attachmentAnchor: .rect(.rect(CGRect(origin: .zero, size: openedSize ?? size))),
            arrowEdge: .bottom
        ) {
            ModelPanel(
                shown: shown,
                openedCatalog: catalog,
                openedSetting: setting,
                onPickModel: onPickModel,
                onPickLevel: onPickLevel,
                onReset: onReset
            )
            .presentationCompactAdaptation(.popover)
        }
        .onChange(of: catalog, initial: true) { shown.catalog = catalog }
        .onChange(of: setting, initial: true) { shown.setting = setting }
    }
}

/// The model and level the chip shows, for its popover. An open popover is not drawn
/// again when only the view that presents it changes: a level let go of on the slider
/// sprang back to the one before while the chip named the new one. The popover reads
/// them from here instead, which it observes itself.
@Observable
private final class ChipShown {
    var catalog: ModelCatalog?
    var setting: ModelSetting?
}

/// The popover: the models, then the level and the slider, with a reset to the agent's
/// own setting. A model is one tap away, and the popover stays open after it for the
/// level, whose stops are the new model's (2026-10-25: the models were a page of
/// their own behind the model's name; "rows is best but maybe make it a scroll area and
/// add a search field").
private struct ModelPanel: View {
    let shown: ChipShown
    /// What the chip showed when the popover was made, until `shown` has it.
    let openedCatalog: ModelCatalog
    let openedSetting: ModelSetting
    var onPickModel: (_ model: String, _ provider: String) -> Void
    var onPickLevel: (ThinkingLevel) -> Void
    var onReset: () -> Void

    /// The level under the finger while the slider is dragged, before it is chosen.
    @State private var previewed: ThinkingLevel?

    private var catalog: ModelCatalog { shown.catalog ?? openedCatalog }
    private var setting: ModelSetting { shown.setting ?? openedSetting }

    /// The level the slider shows: the thread's, or the agent's when the host has not
    /// said what the thread uses.
    private var level: ThinkingLevel { setting.level ?? catalog.agentDefault.level ?? .medium }
    /// The level the title names: where the slider is being dragged to, else the one in use.
    private var named: ThinkingLevel { previewed ?? level }
    private var takesLevels: Bool { catalog.takesLevels(setting.model) }
    private var isDefault: Bool {
        catalog.isAgentModel(setting) && level == (catalog.agentDefault.level ?? level)
    }

    var body: some View {
        VStack(spacing: 0) {
            ModelList(catalog: catalog, setting: setting, onPick: onPickModel)
            Divider()
            levels
        }
        .frame(width: 320)
        .onDebugLaunch(DebugLaunch.holdsModelSlider, after: .seconds(0.8)) { previewed = .max }
    }

    private var levels: some View {
        VStack(spacing: Theme.grid * 1.5) {
            HStack {
                // Balances the reset button, so the title stays centred.
                Color.clear.frame(width: 32, height: 32)
                Spacer(minLength: 0)
                if takesLevels {
                    Text(named.title)
                        .font(.app.title3.weight(.semibold))
                        .foregroundStyle(named.tint)
                        .contentTransition(.opacity)
                } else {
                    Text("No thinking levels")
                        .font(.app.body.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button("Reset to the agent's own", systemImage: "arrow.counterclockwise", action: onReset)
                    .labelStyle(.iconOnly)
                    .font(.app.body.weight(.medium))
                    .frame(width: 32, height: 32)
                    .contentShape(.circle)
                    .buttonStyle(.plain)
                    .foregroundStyle(isDefault ? .tertiary : .secondary)
                    .disabled(isDefault)
            }
            // The levels this model takes, when the host says (a Portals bridge); every
            // level otherwise. None for a model the host lists with none (Cursor's Auto,
            // feature model_levels_none): no slider then.
            if takesLevels {
                LevelSlider(
                    levels: catalog.levels(for: setting.model),
                    selection: Binding(get: { level }, set: { onPickLevel($0) }),
                    dragged: $previewed
                )
            }
            // No Spec model of its own for Droid since 2026-10-23: Spec mode plans with
            // the model and level picked here ("if users go into spec mode they can
            // just use the normal model picker").
        }
        .padding(Theme.grid * 2)
        .animation(.smooth(duration: 0.2), value: named)
    }
}

/// Every model, with a checkmark on the one in use, scrolled to it when the popover
/// opens. A short list (Claude Code's, Codex's) is shown whole; a longer one scrolls in a
/// few rows' height under a search field: a host can offer hundreds. Where several
/// providers offer models they go under the providers' names, the one in use when the
/// panel opened first.
/// Models go by the host's names for them where it gives any (a Portals bridge's Claude
/// Code), and the agent's own is then marked Default.
private struct ModelList: View {
    let catalog: ModelCatalog
    let setting: ModelSetting
    var onPick: (_ model: String, _ provider: String) -> Void

    /// The setting the panel opened with, which orders the providers until it closes:
    /// ordered by the one in use, picking a model of another provider moved that
    /// provider to the top while the panel stayed open for the level, and the row just
    /// clicked went far out of sight.
    @State private var openedWith: ModelSetting
    @State private var query = ""
    @FocusState private var isSearching: Bool
    @State private var position = ScrollPosition(idType: String.self)
    /// Every row is there, not only those down to the model in use (`rows(of:)`).
    @State private var showsAll = false
    /// Rows shown at once before the list scrolls: half a row more shows that it does.
    @ScaledMetric(relativeTo: .body) private var scrollingHeight: CGFloat = 4.5 * 44

    /// The most rows shown whole, without a search field or scrolling.
    private static let rowsShownWhole = 5
    /// The most rows, headers included, laid out at once rather than lazily.
    private static let rowsLaidOutAtOnce = 400
    /// Rows past the model in use there from the start: more than the half of the
    /// list in sight under it.
    private static let rowsPastCurrent = 8
    /// How long after the popover opens the rest of the list comes.
    private static let restAfter: Duration = .milliseconds(400)

    init(catalog: ModelCatalog, setting: ModelSetting, onPick: @escaping (_ model: String, _ provider: String) -> Void) {
        self.catalog = catalog
        self.setting = setting
        self.onPick = onPick
        _openedWith = State(initialValue: setting)
    }

    private var providers: [ModelProvider] { catalog.providers(matching: query, current: openedWith) }
    /// Whether the models go under their providers' names: only where there are several.
    private var namesProviders: Bool { catalog.providers.count(where: { !$0.models.isEmpty }) > 1 }
    private var scrolls: Bool {
        catalog.providers.reduce(0) { $0 + $1.models.count } > Self.rowsShownWhole
    }

    var body: some View {
        if scrolls {
            VStack(spacing: 0) {
                search
                ScrollView {
                    // A lazy stack lays rows out only as they come into sight, guessing at
                    // the rest, so the height the scroll bar is drawn for kept changing and
                    // the bar jumped about while a long list (Pi's) scrolled. Laid out all
                    // at once, the list has its height from the start; only one too long
                    // for that is still laid out lazily.
                    let shown = providers
                    if shown.reduce(0, { $0 + 1 + $1.models.count }) <= Self.rowsLaidOutAtOnce {
                        VStack(alignment: .leading, spacing: 0) { rows(of: shown) }
                            .scrollTargetLayout()
                    } else {
                        LazyVStack(alignment: .leading, spacing: 0) { rows(of: shown) }
                            .scrollTargetLayout()
                    }
                }
                // As high as a few rows whatever the search leaves, so the popover does not
                // change size under the typing; lower where the screen has less room (a
                // phone with its keyboard up).
                .frame(minHeight: 88, idealHeight: scrollingHeight, maxHeight: scrollingHeight)
                // The model in use in sight.
                .scrollPosition($position, anchor: .center)
                .onAppear {
                    if let current { position.scrollTo(id: current, anchor: .center) }
                }
                .task {
                    // Once the system's opening animation (about 250 ms on a Mac) is done.
                    try? await Task.sleep(for: Self.restAfter)
                    showsAll = true
                }
                // What the search leaves is shown from its top: kept centred where the
                // model in use was, the first matches could be above the rows in sight.
                // The search cleared, the whole list is back on the model in use, as it
                // opened.
                .onChange(of: query) {
                    if query.isEmpty, let current {
                        position.scrollTo(id: current, anchor: .center)
                    } else {
                        position.scrollTo(edge: .top)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 0) { rows(of: providers) }
                .padding(.vertical, Theme.grid)
        }
    }

    /// The app's search field, the sidebar's and the folder sheet's (2026-10-27).
    private var search: some View {
        SearchField(prompt: "Search models", text: $query, isFocused: $isSearching, identifier: "model-search-field")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            // Return picks the one model the search has left.
            .onSubmit {
                let left = providers.flatMap { provider in provider.models.map { ($0, provider.id) } }
                if left.count == 1 { onPick(left[0].0, left[0].1) }
            }
            .padding(.horizontal, Theme.grid * 2)
            .padding(.top, Theme.grid * 2)
            .padding(.bottom, Theme.grid / 2)
    }

    /// The row of the model in use, to scroll to.
    private var current: String? {
        for provider in catalog.providers {
            if let model = provider.models.first(where: { catalog.isCurrent($0, at: provider.id, for: setting) }) {
                return Self.id(of: model, at: provider.id)
            }
        }
        return nil
    }

    private static func id(of model: String, at provider: String) -> String { "\(provider)/\(model)" }

    /// A line of the list: a provider's name over its models, or a model.
    private enum Line: Identifiable {
        case provider(ModelProvider)
        case model(String, ModelProvider)

        var id: String {
            switch self {
            case let .provider(provider): "provider \(provider.id)"
            case let .model(model, provider): ModelList.id(of: model, at: provider.id)
            }
        }
    }

    private func lines(of providers: [ModelProvider]) -> [Line] {
        providers.flatMap { provider in
            (namesProviders ? [Line.provider(provider)] : []) + provider.models.map { Line.model($0, provider) }
        }
    }

    /// The lines laid out: until the popover is open, those down to a few past the model in
    /// use, which it opens on; the rest come under them a moment later, where they move
    /// nothing in sight. Three hundred rows took about 85 ms to lay out on a Mac
    /// (2026-11-06, a bench host with 300 models), all of it before the popover could
    /// show anything; the model in use is near the top of most lists (its provider first).
    private func shownLines(of providers: [ModelProvider]) -> [Line] {
        let all = lines(of: providers)
        guard !showsAll, scrolls, let current, let index = all.firstIndex(where: { $0.id == current }) else {
            return all
        }
        return Array(all.prefix(index + 1 + Self.rowsPastCurrent))
    }

    @ViewBuilder
    private func rows(of providers: [ModelProvider]) -> some View {
        // One ForEach of lines, each with an id of its own, for the scroll to the model in
        // use: a scroll view goes by its stack's ForEach ids, not by ids put on the views
        // of a ForEach inside another.
        ForEach(shownLines(of: providers)) { line in
            switch line {
            case let .provider(provider):
                Text(provider.name)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, Theme.grid * 2)
                    .padding(.top, Theme.grid * 1.5)
                    .padding(.bottom, Theme.grid / 2)
                    .accessibilityAddTraits(.isHeader)
            case let .model(model, provider):
                row(model, in: provider)
            }
        }
        if providers.isEmpty {
            Text("No model matches.")
                .font(.app.subheadline)
                .foregroundStyle(.secondary)
                .padding(Theme.grid * 2)
        }
    }

    private func row(_ model: String, in provider: ModelProvider) -> some View {
        let isSelected = catalog.isCurrent(model, at: provider.id, for: setting)
        return Button { onPick(model, provider.id) } label: {
            HStack(spacing: Theme.grid) {
                if catalog.marksAsDefault(model, at: provider.id) {
                    // The mark beside the name, or under it when large text leaves no
                    // room for both: the name is what tells the default apart.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Theme.grid) {
                            name(of: model)
                            defaultMark
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            name(of: model)
                            defaultMark
                        }
                    }
                } else {
                    name(of: model)
                }
                // Kept in every row, unseen, so that the names are cut at the same place.
                Image(systemName: "checkmark")
                    .font(.app.body.weight(.semibold))
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, Theme.grid * 2)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(PressedRowStyle())
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func name(of model: String) -> some View {
        Text(catalog.name(of: model))
            .font(.app.body)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var defaultMark: some View {
        Text("Default")
            .font(.app.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize()
    }
}

/// A row of stops, one per level, with a knob on the chosen one: drag or tap along it.
/// The track fills up to the knob in the level's colour. A chosen level that is not one
/// of the stops (the model changed) sits on the nearest.
private struct LevelSlider: View {
    let levels: [ThinkingLevel]
    @Binding var selection: ThinkingLevel

    private static let trackHeight: CGFloat = 32
    private static let knobSize: CGFloat = 38

    /// The level under the finger, until the drag ends: the choice is sent once, when
    /// you let go, not for every stop passed on the way. Whoever shows the slider can
    /// name the level meanwhile.
    @Binding var dragged: ThinkingLevel?

    private var shown: ThinkingLevel { dragged ?? selection }

    /// The stop for a level: its own, else the nearest one.
    private func stop(of level: ThinkingLevel) -> Int {
        if let index = levels.firstIndex(of: level) { return index }
        let rank = ThinkingLevel.allCases.firstIndex(of: level) ?? 0
        return levels.indices.min {
            abs((ThinkingLevel.allCases.firstIndex(of: levels[$0]) ?? 0) - rank) < abs((ThinkingLevel.allCases.firstIndex(of: levels[$1]) ?? 0) - rank)
        } ?? 0
    }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let index = stop(of: shown)
            let knobX = x(of: index, in: width)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .frame(height: Self.trackHeight)
                Capsule()
                    .fill(shown.tint)
                    .frame(width: knobX + Self.trackHeight / 2, height: Self.trackHeight)
                ForEach(levels.indices, id: \.self) { stop in
                    if stop != index {
                        Circle()
                            .fill(stop < index ? AnyShapeStyle(Color.white.opacity(0.7)) : AnyShapeStyle(.secondary))
                            .frame(width: 6, height: 6)
                            .position(x: x(of: stop, in: width), y: Self.knobSize / 2)
                    }
                }
                Circle()
                    .fill(.white)
                    .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
                    .frame(width: Self.knobSize, height: Self.knobSize)
                    .position(x: knobX, y: Self.knobSize / 2)
            }
            .frame(height: Self.knobSize)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let stop = nearestStop(to: value.location.x, in: width)
                        if levels[stop] != shown { dragged = levels[stop] }
                    }
                    .onEnded { _ in
                        if let dragged, dragged != selection { selection = dragged }
                        dragged = nil
                    }
            )
            .animation(.snappy(duration: 0.2), value: shown)
        }
        .frame(height: Self.knobSize)
        .sensoryFeedback(.selection, trigger: shown)
        .accessibilityRepresentation {
            Slider(value: stopValue, in: 0...Double(max(levels.count - 1, 1)), step: 1) {
                Text("Thinking")
            }
            .accessibilityValue(selection.title)
        }
    }

    /// The selection as a stop number, for VoiceOver's slider.
    private var stopValue: Binding<Double> {
        Binding(
            get: { Double(stop(of: selection)) },
            set: { value in
                let stop = min(max(Int(value.rounded()), 0), levels.count - 1)
                if levels.indices.contains(stop) { selection = levels[stop] }
            }
        )
    }

    /// Where a stop's centre sits: the ends are inset by half the track's height.
    private func x(of stop: Int, in width: CGFloat) -> CGFloat {
        let inset = Self.trackHeight / 2
        guard levels.count > 1 else { return inset }
        return inset + CGFloat(stop) * (width - 2 * inset) / CGFloat(levels.count - 1)
    }

    private func nearestStop(to x: CGFloat, in width: CGFloat) -> Int {
        levels.indices.min { abs(self.x(of: $0, in: width) - x) < abs(self.x(of: $1, in: width) - x) } ?? 0
    }
}

extension ThinkingLevel {
    /// Warm when the model answers at once, cooler as it thinks longer.
    var tint: Color {
        switch self {
        case .off: .orange
        case .minimal: .yellow
        case .low: .green
        case .medium: .teal
        case .high: .blue
        case .extraHigh: .indigo
        case .max: .purple
        case .ultra: .pink
        }
    }
}
