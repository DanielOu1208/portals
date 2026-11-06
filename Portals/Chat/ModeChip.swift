import AgentCore
import SwiftUI

/// The composer's mode chip: how much a coding agent's thread asks before acting, as the
/// mode's symbol (a bolt for full access, a map for plan mode, …) and, on a Mac, its name,
/// like the model chip beside it. Tap it for a popover with every mode and a checkmark
/// on the thread's, as the model chip's popover lists the models.
/// A thread that follows the agent's settings shows what those come to.
struct ModeChip: View {
    let mode: ModeState
    /// The height of the composer's buttons, to line up with them.
    let height: CGFloat
    var onPick: (ThreadMode) -> Void

    @State private var isPresented = DebugLaunch.opensModePicker
    @State private var shown = ModeShown()

    var body: some View {
        Button { isPresented = true } label: {
            // A Mac's composer has the room for the name, until its window is narrow: then
            // the name goes before the model's beside it is cut. An iPhone's keeps the symbol.
            if Platform.isMac {
                ViewThatFits(in: .horizontal) {
                    label(named: true)
                    label(named: false)
                }
                .contentShape(.rect)
            } else {
                label(named: false)
            }
        }
        .dropdownChipStyle { isPresented = true }
        .accessibilityLabel("Mode")
        .accessibilityValue(mode.pickerTitle(for: mode.mode))
        .accessibilityHint("Changes how much the agent asks before acting, for this thread")
        .accessibilityIdentifier("mode-chip")
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            // The thread keeps a choice of the mode it is already in to itself.
            ModePanel(shown: shown, opened: mode) { picked in
                isPresented = false
                onPick(picked)
            }
            .presentationCompactAdaptation(.popover)
        }
        .onChange(of: mode, initial: true) { shown.mode = mode }
    }

    private func label(named: Bool) -> some View {
        HStack(spacing: 3) {
            Image(systemName: mode.effective.symbol)
                .font(.app.callout.weight(.medium))
            if named {
                Text(mode.title(for: mode.effective))
                    .lineLimit(1)
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
}

/// The mode the chip shows, for its popover. An open popover is not drawn again when only
/// the view that presents it changes (`ChipShown` in `ModelPicker`): a mode the Mac turned
/// down would stay checked. The popover reads it from here instead, which it observes.
@Observable
private final class ModeShown {
    var mode: ModeState?
}

/// The popover: every mode as a row, its symbol and its name, with a
/// checkmark on the thread's. With large text it scrolls, rather than leave modes out.
private struct ModePanel: View {
    let shown: ModeShown
    /// What the chip showed when the popover was made, until `shown` has it.
    let opened: ModeState
    var onPick: (ThreadMode) -> Void

    private var mode: ModeState { shown.mode ?? opened }
    @ScaledMetric(relativeTo: .body) private var iconWidth: CGFloat = 24

    var body: some View {
        ViewThatFits(in: .vertical) {
            rows
            ScrollView { rows }
                .scrollBounceBehavior(.basedOnSize)
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Mode")
                .font(.app.headline)
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, Theme.grid * 2)
                .padding(.top, Theme.grid * 2)
                .padding(.bottom, Theme.grid)
            ForEach(mode.offeredModes, id: \.self) { item in
                row(item)
            }
        }
        .padding(.bottom, Theme.grid)
    }

    private func row(_ item: ThreadMode) -> some View {
        let isSelected = item == mode.mode
        return Button { onPick(item) } label: {
            HStack(spacing: Theme.grid * 1.5) {
                Image(systemName: item.symbol)
                    .font(.app.body.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: iconWidth)
                Text(mode.pickerTitle(for: item))
                    .font(.app.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "checkmark")
                    .font(.app.body.weight(.semibold))
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, Theme.grid * 2)
            .padding(.vertical, Theme.grid)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(PressedRowStyle())
        .accessibilityLabel(mode.pickerTitle(for: item))
        .accessibilityHint(mode.pickerDescription(for: item))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("mode-\(item.rawValue)")
    }
}
