import AgentCore
import SwiftUI

/// The existing diff renderer, and named permission targets rather than raw SDK JSON.
struct ApprovalDetailsView: View, Equatable {
    let details: [ApprovalDetail]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            ForEach(Array(details.enumerated()), id: \.offset) { _, detail in
                VStack(alignment: .leading, spacing: Theme.grid / 2) {
                    Text(detail.name).font(.app.footnote.weight(.semibold))
                    if let path = detail.path { value("File", path) }
                    if let command = detail.command { value("Command", command) }
                    if let server = detail.server { value("MCP server", server) }
                    if let tool = detail.tool { value("MCP tool", tool) }
                    if let impact = detail.impact { value("Impact", impact) }
                    if let violation = detail.violationType { value("Violation", violation) }
                    if let operation = detail.operation { value("Operation", operation) }
                    if let target = detail.target { value("Target", target) }
                    if let reason = detail.reason { value("Reason", reason) }
                    ForEach(Array((detail.findings ?? []).enumerated()), id: \.offset) { _, finding in
                        Text(finding.title).font(.app.footnote.weight(.medium))
                        if let severity = finding.severity { value("Severity", severity) }
                        Text(finding.message).font(.app.footnote).foregroundStyle(.secondary)
                    }
                    if let diff = detail.diff, !diff.isEmpty {
                        InlineDiffView(diff: DiffText(diff))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.top, Theme.grid)
        .accessibilityIdentifier("approval-details")
    }

    private func value(_ label: String, _ text: String) -> some View {
        Text("\(label): \(text)")
            .font(.app.footnote)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
    }
}
