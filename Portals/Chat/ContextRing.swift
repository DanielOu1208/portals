import AgentCore
import SwiftUI

/// How full the model's context is: a small ring that fills as it does, with the
/// percentage beside it, warning by colour when it is nearly full. Tap it for the
/// numbers.
struct ContextRing: View {
    let usage: ContextUsage
    /// The height of the composer's buttons, to line up with them.
    let height: CGFloat
    var showsCompact = false
    var canCompact = false
    var onCompact: () -> Void = {}

    @State private var showsNumbers = false
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 15

    private var percent: Int { Int((usage.fraction * 100).rounded()) }

    private var tint: Color {
        switch usage.fraction {
        case ..<0.7: .secondary
        case ..<0.9: .orange
        default: .red
        }
    }

    var body: some View {
        Button { showsNumbers = true } label: {
            HStack(spacing: Theme.grid * 0.625) {
                ZStack {
                    Circle()
                        .stroke(Color(uiColor: .tertiarySystemFill), lineWidth: 2.5)
                    Circle()
                        // A sliver even when nearly empty, so the ring reads as a gauge.
                        .trim(from: 0, to: max(usage.fraction, 0.03))
                        .stroke(tint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: diameter, height: diameter)
                Text("\(percent)%")
                    .font(.app.footnote.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(tint)
                    .contentTransition(.numericText())
            }
            .padding(.horizontal, Theme.grid * 0.75)
            .frame(height: height)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .animation(.smooth(duration: 0.4), value: usage.fraction)
        // A moment after the ring is there, as a tap would be: a popover asked for
        // while the ring is still moving into place is laid out wrong.
        .onDebugLaunch(DebugLaunch.showsContextNumbers, after: .seconds(1.5)) { showsNumbers = true }
        .accessibilityLabel("Context")
        .accessibilityValue("\(percent) percent full, \(usage.summary) tokens\(usage.estimated ? ", estimated" : "")")
        .accessibilityIdentifier("context-ring")
        .popover(isPresented: $showsNumbers, arrowEdge: .bottom) {
            VStack(spacing: 2) {
                Text("Context \(percent)% full")
                    .font(.app.subheadline.weight(.semibold))
                Text("\(usage.summary) tokens")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                if usage.estimated {
                    Text("Estimated context")
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                }
                if showsCompact {
                    Button("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") {
                        showsNumbers = false
                        onCompact()
                    }
                    .font(.app.footnote.weight(.medium))
                    .disabled(!canCompact)
                    .padding(.top, Theme.grid)
                    .accessibilityHint("Summarizes the conversation to free context space")
                    .accessibilityIdentifier("context-compact")
                }
            }
            // Its own size whatever the numbers are: they change while it is open.
            .fixedSize()
            .padding(.horizontal, Theme.grid * 2)
            .padding(.vertical, Theme.grid * 1.5)
            .presentationCompactAdaptation(.popover)
        }
    }
}
