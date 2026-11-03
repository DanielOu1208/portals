import AgentCore
import SwiftUI

struct ToolExecutionView: View {
    let execution: ToolExecution

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid / 2) {
            if let summary = execution.summary, !summary.isEmpty {
                Text(summary).font(.app.subheadline)
            }
            if !attributes.isEmpty {
                Text(attributes.joined(separator: " · "))
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var attributes: [String] {
        var values: [String] = []
        if let risk = execution.riskLevel { values.append("\(risk.capitalized) risk") }
        if execution.background == true { values.append("Background") }
        if let timeout = execution.timeout { values.append("Timeout \(timeout.formatted())s") }
        return values
    }
}
