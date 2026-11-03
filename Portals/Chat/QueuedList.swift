import AgentCore
import SwiftUI

/// The messages waiting for the running turn to end, above the composer: each on a row,
/// with "Steer" to hand it to the turn now, where the agent can take one in, and a button
/// to take it off the list. The host keeps the list, so every device shows the same one.
struct QueuedList: View {
    let messages: [QueuedMessage]
    /// The agent can take a message into a running turn.
    let canSteer: Bool
    var onSteer: (QueuedMessage) -> Void
    var onRemove: (QueuedMessage) -> Void
    var onPlace: (QueuedMessage, WhenBusy) -> Void = { _, _ in }
    @Environment(\.macNames) private var macNames

    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 44
    /// About three rows, so the chat stays in view; more scroll.
    private static let visibleRows: CGFloat = 3.4

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(messages.count == 1 ? "Queued" : "Queued · \(messages.count)")
                .font(.app.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, Theme.grid * 2)
                .padding(.top, Theme.grid * 1.25)
                .padding(.bottom, Theme.grid / 2)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(messages) { message in
                        row(message)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(CGFloat(messages.count), Self.visibleRows) * rowHeight)
        }
        .padding(.bottom, Theme.grid / 2)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        .accessibilityIdentifier("queued-list")
    }

    private func row(_ message: QueuedMessage) -> some View {
        let summary = Self.summary(of: message)
        // One another agent or a script sent through Portals says who it is from.
        let from = message.relayed?.label { macNames[$0] }
        let spoken = [from, summary.isEmpty ? nil : summary].compactMap(\.self).joined(separator: ": ")
        return HStack(spacing: Theme.grid) {
            VStack(alignment: .leading, spacing: 1) {
                Group {
                    if let from {
                        Text("\(Text(from).foregroundStyle(.secondary))\(summary.isEmpty ? "" : " · \(summary)")")
                    } else {
                        Text(summary)
                    }
                }
                .font(.app.subheadline)
                .lineLimit(1)
                if let placement = message.placement {
                    Text(placement == .steer ? "Next model step" : "Next turn")
                        .font(.app.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if canSteer {
                Button("Steer", systemImage: "arrow.turn.down.right") { onSteer(message) }
                    .labelStyle(.titleAndIcon)
                    .font(.app.footnote.weight(.medium))
                    .buttonStyle(.borderedCapsule)
                    .controlSize(.small)
                    .accessibilityLabel("Steer now")
                    .accessibilityHint("Hands this message to the turn the agent is on")
                    .accessibilityIdentifier("queued-steer-\(message.id)")
            }
            if let placement = message.placement {
                Menu {
                    Button("At next model step", systemImage: "arrow.turn.down.right") { onPlace(message, .steer) }
                        .disabled(placement == .steer)
                    Button("At next turn", systemImage: "text.bubble") { onPlace(message, .queue) }
                        .disabled(placement == .queue)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 32, height: 32)
                        .contentShape(.circle)
                }
                .accessibilityLabel("Move queued message")
                .accessibilityIdentifier("queued-placement-\(message.id)")
            }
            Button("Remove", systemImage: "xmark") { onRemove(message) }
                .labelStyle(.iconOnly)
                .font(.app.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .contentShape(.circle)
                .buttonStyle(.plain)
                .accessibilityLabel("Remove from the queue")
                .accessibilityIdentifier("queued-remove-\(message.id)")
        }
        .padding(.leading, Theme.grid * 2)
        .padding(.trailing, Theme.grid)
        .frame(height: rowHeight)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Queued: \(spoken)")
    }

    /// The message on one line: its first words, or what it carries when it has none.
    static func summary(of message: QueuedMessage) -> String {
        let parts = message.parts
        // A message another agent sent through the fleet opens with who it is from, which
        // its row says apart.
        let words = message.relayed?.text ?? parts.text
        let lines = words.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let attached = parts.attachments == 0 ? nil : (parts.attachments == 1 ? "1 attachment" : "\(parts.attachments) attachments")
        return [lines.first, attached].compactMap(\.self).joined(separator: " · ")
    }
}
