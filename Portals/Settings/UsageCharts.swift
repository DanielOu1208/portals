import AgentCore
import Charts
import SwiftUI

// The drawings of Settings, Usage (`UsageSettings`): the tokens by agent as lines, the
// dollars by type of token as one bar, a limit's bar with its pace, and a row of a list.

// MARK: Tokens by agent

/// The tokens by agent as lines (2026-11-06: "some line graph would be cool that shows token
/// spread"): day by day over the range (hour by hour over the 24 hours), or over the 24
/// hours of an average day. A tap or a drag, or the pointer on a Mac, shows the values
/// where it is.
struct UsageLineChart: View {
    let report: UsageReport
    let overADay: Bool
    let colors: [String: Color]

    @State private var pickedDate: Date?
    @State private var pickedHour: Int?
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 200

    private var names: [String] { report.agents.map(UsageAgentName.of) }
    private var palette: [Color] { report.agents.map { colors[$0] ?? UsageColors.color(of: $0) } }
    private var byHour: Bool { report.range == .day }

    var body: some View {
        Group {
            if overADay { spread } else { series }
        }
        .chartForegroundStyleScale(domain: names, range: palette)
        .chartLegend(position: .bottom, alignment: .leading)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let tokens = value.as(Double.self) { Text(UsageFormat.tokens(Int(tokens))) }
                }
            }
        }
        .frame(height: height)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(overADay ? "Tokens by agent over an average day" : "Tokens by agent, \(report.range.title)")
    }

    // MARK: Over the range

    private var series: some View {
        Chart {
            ForEach(report.series) { point in
                LineMark(
                    x: .value(byHour ? "Hour" : "Day", point.date, unit: byHour ? .hour : .day),
                    y: .value("Tokens", point.tokens)
                )
                .foregroundStyle(by: .value("Agent", UsageAgentName.of(point.agent)))
                .interpolationMethod(.monotone)
                .accessibilityLabel("\(UsageAgentName.of(point.agent)), \(dateText(point.date))")
                .accessibilityValue("\(UsageFormat.tokens(point.tokens)) tokens")
            }
            if let date = shownDate {
                RuleMark(x: .value("Picked", date, unit: byHour ? .hour : .day))
                    .foregroundStyle(Color.secondary.opacity(0.35))
                    .annotation(position: .top, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        callout(title: dateText(date), values: report.series.filter { $0.date == date }.map { ($0.agent, Double($0.tokens)) })
                    }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: byHour ? 6 : 5)) { _ in
                AxisGridLine()
                AxisValueLabel(format: byHour ? .dateTime.hour() : .dateTime.month(.abbreviated).day())
            }
        }
        .chartXSelection(value: Platform.isMac ? .constant(nil) : $pickedDate)
        .chartOverlay { proxy in
            if Platform.isMac {
                hover(proxy) { x in pickedDate = x.flatMap { proxy.value(atX: $0, as: Date.self) } }
            }
        }
    }

    /// The point of the day (or hour) picked.
    private var shownDate: Date? {
        guard let pickedDate else { return nil }
        let start = byHour
            ? Date(timeIntervalSince1970: (pickedDate.timeIntervalSince1970 / 3600).rounded(.down) * 3600)
            : Calendar.current.startOfDay(for: pickedDate)
        return report.series.contains { $0.date == start } ? start : nil
    }

    private func dateText(_ date: Date) -> String {
        byHour
            ? date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
            : date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    // MARK: Over a day

    private var spread: some View {
        Chart {
            ForEach(report.spread) { point in
                LineMark(x: .value("Hour", point.hour), y: .value("Tokens", point.tokens))
                    .foregroundStyle(by: .value("Agent", UsageAgentName.of(point.agent)))
                    .interpolationMethod(.monotone)
                    .accessibilityLabel("\(UsageAgentName.of(point.agent)), \(hourText(point.hour))")
                    .accessibilityValue("\(UsageFormat.tokens(Int(point.tokens))) tokens on an average day")
            }
            if let hour = pickedHour.map({ min(max($0, 0), 23) }) {
                RuleMark(x: .value("Picked", hour))
                    .foregroundStyle(Color.secondary.opacity(0.35))
                    .annotation(position: .top, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        callout(title: "\(hourText(hour)), an average day", values: report.spread.filter { $0.hour == hour }.map { ($0.agent, $0.tokens) })
                    }
            }
        }
        .chartXScale(domain: 0 ... 23)
        .chartXAxis {
            AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let hour = value.as(Int.self) { Text(hourText(hour)) }
                }
            }
        }
        .chartXSelection(value: Platform.isMac ? .constant(nil) : $pickedHour)
        .chartOverlay { proxy in
            if Platform.isMac {
                hover(proxy) { x in pickedHour = x.flatMap { proxy.value(atX: $0, as: Double.self) }.map { Int($0.rounded()) } }
            }
        }
    }

    /// "09:00", or "9 AM", as the device writes hours.
    private func hourText(_ hour: Int) -> String {
        let start = Calendar.current.startOfDay(for: .now).addingTimeInterval(Double(hour) * 3600)
        return start.formatted(.dateTime.hour())
    }

    // MARK: Values where it is

    /// On a Mac the pointer picks, as a finger does elsewhere: a plain place in the plot
    /// that follows it, `pick` given its place across the plot, nil as it leaves.
    private func hover(_ proxy: ChartProxy, pick: @escaping (CGFloat?) -> Void) -> some View {
        GeometryReader { geometry in
            Rectangle()
                .fill(.clear)
                .contentShape(.rect)
                .onContinuousHover { phase in
                    switch phase {
                    case let .active(location):
                        guard let plot = proxy.plotFrame else { return pick(nil) }
                        pick(location.x - geometry[plot].origin.x)
                    case .ended:
                        pick(nil)
                    }
                }
        }
    }

    private func callout(title: String, values: [(agent: String, tokens: Double)]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.app.caption.weight(.semibold))
            ForEach(values.filter { $0.tokens > 0 }.sorted { $0.tokens > $1.tokens }, id: \.agent) { value in
                HStack(spacing: Theme.grid * 0.5) {
                    Circle()
                        .fill(colors[value.agent] ?? UsageColors.color(of: value.agent))
                        .frame(width: 7, height: 7)
                    Text(UsageAgentName.of(value.agent))
                    Spacer(minLength: Theme.grid)
                    Text(UsageFormat.tokens(Int(value.tokens)))
                        .monospacedDigit()
                }
                .font(.app.caption)
            }
            if !values.contains(where: { $0.tokens > 0 }) {
                Text("No tokens")
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(Theme.grid)
        .frame(minWidth: 150)
        .background(.regularMaterial, in: .rect(cornerRadius: 10, style: .continuous))
    }
}

// MARK: Cost by token type

/// The dollars by type of token as one bar split in its parts, with a legend.
struct UsageCostBar: View {
    let costs: [UsageTypeCost]
    let unpricedTokens: Int

    @ScaledMetric(relativeTo: .body) private var barHeight: CGFloat = 14

    static func color(of type: UsageTokenType) -> Color {
        switch type {
        // Apart from the agents' colours, which the chart above draws.
        case .input: .indigo
        case .output: .pink
        case .cacheRead: .mint
        case .cacheWrite: .yellow
        }
    }

    private var total: Double { costs.reduce(0) { $0 + $1.usd } }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            GeometryReader { geometry in
                HStack(spacing: 2) {
                    ForEach(costs.filter { $0.usd > 0 }) { cost in
                        Rectangle()
                            .fill(Self.color(of: cost.type))
                            .frame(width: max(2, (geometry.size.width - 6) * cost.usd / max(total, 0.000_001)))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: barHeight)
            .background(Color.secondary.opacity(0.15))
            .clipShape(.capsule)
            .accessibilityHidden(true)

            ForEach(costs) { cost in
                HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
                    Circle()
                        .fill(Self.color(of: cost.type))
                        .frame(width: 9, height: 9)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                    Text(cost.type.title)
                    Spacer(minLength: Theme.grid)
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(UsageFormat.dollars(cost.usd))
                            .monospacedDigit()
                        Text("\(UsageFormat.tokens(cost.tokens)) tokens")
                            .font(.app.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(cost.type.title)
                .accessibilityValue("\(UsageFormat.dollars(cost.usd)), \(total > 0 ? UsageFormat.share(cost.usd / total) : "none") of the cost, \(UsageFormat.tokens(cost.tokens)) tokens")
            }
            if unpricedTokens > 0 {
                Text("\(UsageFormat.tokens(unpricedTokens)) tokens of models with no price are not in the dollars.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: Limits

/// A plan's window: how much is used, the mark where an even pace would be, and when it
/// runs out at this rate or that it lasts until the reset.
struct UsageLimitRow: View {
    let pace: UsageLimitPace
    let color: Color

    @ScaledMetric(relativeTo: .body) private var barHeight: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 0.75) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(UsageAgentName.of(pace.agent)), \(pace.name)")
                Spacer(minLength: Theme.grid)
                Text(pace.hasReset ? "–" : UsageFormat.share(pace.percent / 100))
                    .monospacedDigit()
                    .foregroundStyle(pace.isOverPace || pace.isUsedUp ? Color.orange : .primary)
            }
            GeometryReader { geometry in
                let width = geometry.size.width
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.18))
                    Capsule()
                        .fill(color)
                        .frame(width: pace.hasReset ? 0 : max(barHeight, width * pace.percent / 100))
                    if let passed = pace.passed {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(Color.primary)
                            .frame(width: 2, height: barHeight + 6)
                            .offset(x: min(max(width * passed - 1, 0), width - 2))
                    }
                }
            }
            .frame(height: barHeight)
            .padding(.vertical, 3)
            Text(paceText)
                .font(.app.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(UsageAgentName.of(pace.agent)), \(pace.name)")
        .accessibilityValue(accessibilityValue)
    }

    /// When it runs out, or that it lasts; how far from an even pace.
    private var paceText: String {
        if pace.hasReset { return "Started again since it was last read." }
        if pace.isUsedUp { return pace.resetsAt.map { "Used up until \(Self.time($0))." } ?? "Used up." }
        guard let resetsAt = pace.resetsAt else { return "Its reset is not known." }
        let away = pace.reserve.map { reserve in
            abs(reserve) < 1 ? "On pace" : reserve < 0 ? "\(Int(-reserve.rounded())) points over pace" : "\(Int(reserve.rounded())) points in reserve"
        }
        let when = pace.runsOutAt.map { "runs out \(Self.time($0))" } ?? "lasts until the reset, \(Self.time(resetsAt))"
        return away.map { "\($0): \(when)." } ?? "At this rate it \(when)."
    }

    private var accessibilityValue: String {
        if pace.hasReset { return "Started again since it was last read" }
        let gone = pace.passed.map { ", \(UsageFormat.share($0)) of the window gone" } ?? ""
        return "\(UsageFormat.share(pace.percent / 100)) used\(gone). \(paceText)"
    }

    /// "14:20" today, "Sat 14:20" later on.
    static func time(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? "at \(date.formatted(date: .omitted, time: .shortened))"
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}

// MARK: A list's row

/// One agent, model, folder or Mac: its name, dollars, tokens and share, with a bar.
struct UsageSliceRow: View {
    let slice: UsageSlice
    let color: Color
    /// What the pointer shows on a Mac: a folder's whole path.
    var help: String?

    @ScaledMetric(relativeTo: .body) private var barHeight: CGFloat = 5

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
            HStack(alignment: .firstTextBaseline) {
                Text(slice.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Theme.grid)
                Text(dollarsText)
                    .monospacedDigit()
            }
            HStack(spacing: Theme.grid) {
                GeometryReader { geometry in
                    Capsule()
                        .fill(color)
                        .frame(width: max(barHeight, geometry.size.width * slice.share))
                }
                .frame(height: barHeight)
                Text("\(UsageFormat.tokens(slice.tokens.total)) · \(UsageFormat.share(slice.share))")
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .layoutPriority(1)
            }
        }
        .help(help ?? "")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(slice.name)
        .accessibilityValue("\(dollarsText), \(UsageFormat.tokens(slice.tokens.total)) tokens, \(UsageFormat.share(slice.share)) of all")
    }

    private var dollarsText: String {
        if slice.usd == 0, slice.unpricedTokens > 0 { return "No price" }
        return UsageFormat.dollars(slice.usd)
    }
}
