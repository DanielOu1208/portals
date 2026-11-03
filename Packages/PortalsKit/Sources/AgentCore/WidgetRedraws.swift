import Foundation

/// Whether a finished visual's page is drawn again because it is now shown wider than it
/// has been drawn since it loaded. Some pages size what they draw once, or can only make
/// it smaller: Chart.js keeps a chart no taller than the element it is in
/// (`getMaximumSize` in Chart.js 4), which in a visual is the page's body, as tall as the
/// chart, so a chart never grows wider than it was first drawn, nor back after the window
/// was narrowed; a script that reads the page's width once as it draws keeps that width.
/// A page shown `WidgetHeights.widthStep` or more wider than the narrowest it has measured
/// itself at since it loaded is drawn again (the app waits for the width to settle). One
/// shown narrower is not: pages reflow into less room by themselves. Nor is one the user
/// has done something on since it loaded (moved a slider, typed, tapped a legend): drawn
/// again, it would lose that.
public struct WidgetWidening: Sendable, Equatable {
    private var narrowest: Double?
    private var isUsed = false

    public init() {}

    /// The loaded page measured itself at `width`. True when it is to be drawn again.
    public mutating func record(width: Double) -> Bool {
        guard width.isFinite, width > 0 else { return false }
        guard let narrowest, width >= narrowest else {
            self.narrowest = width
            return false
        }
        return !isUsed && width - narrowest >= WidgetHeights.widthStep
    }

    /// Whether the page, shown `width` wide now, is to be drawn again, without taking that
    /// width as one it measured itself at: asked as it comes back into its row from the
    /// expanded view, before it has measured itself there.
    public func redraws(at width: Double) -> Bool {
        guard width.isFinite, let narrowest, !isUsed else { return false }
        return width - narrowest >= WidgetHeights.widthStep
    }

    /// The user did something on the page (a tap, a key, a control changed): it is not
    /// drawn again until it is loaded again.
    public mutating func used() {
        isUsed = true
    }

    /// The page was loaded again: it is drawn at the width it measures itself at next.
    public mutating func reset() {
        narrowest = nil
        isUsed = false
    }
}

/// What is done when WebKit's process for a visual's page ends while the page is shown
/// (it crashed, or the system ended it): the page is drawn again, unless that happened
/// `most` times within `window`, when the visual is given up on and its source shown
/// instead. A page whose drawing ends its process every time would otherwise be drawn
/// again for ever, a process started and ended each time. Endings while the page was out
/// of the window (the system ends those first when memory runs short) are not its doing
/// and are not counted.
public struct WidgetEndings: Sendable, Equatable {
    public static let most = 3
    public static let window: TimeInterval = 120

    private var times: [Date] = []

    public init() {}

    /// The page's process ended at `time` while the page was shown. True when it is to be
    /// drawn again.
    public mutating func ended(at time: Date) -> Bool {
        times = times.filter { time.timeIntervalSince($0) < Self.window }
        times.append(time)
        return times.count < Self.most
    }
}

/// The visuals' pages of a chat that was left are kept for `life` (two minutes), so that
/// going back to it within that time finds them drawn, and are then let go of (2026-10-22: "leave it for a specific time maybe and then free"). Kept by the turns
/// they are in, from when their chat was left; a chat shown again keeps its own for as
/// long as it is shown. One clock for them all: the app waits for `nextDue` alone.
public struct WidgetsLeft<Chat: Hashable & Sendable>: Sendable, Equatable {
    public static var life: TimeInterval { 120 }

    public let life: TimeInterval
    /// When the chat each turn is in was left.
    private var since: [UUID: Date] = [:]
    /// The chat screens on screen, each with the chat it shows: a screen of the same chat
    /// made again (a layout change) may come before the one it replaces has gone, whose
    /// leaving then lets go of nothing.
    private var screens: [UUID: Chat] = [:]

    public init(life: TimeInterval = Self.life) {
        self.life = life
    }

    public var isEmpty: Bool { since.isEmpty }

    /// The chat screen `screen`, showing `chat` with `turns` in it, left at `time`. A
    /// turn already waiting keeps the time it was first left at. Nothing, while another
    /// screen shows the same chat.
    public mutating func left(_ turns: some Sequence<UUID>, of chat: Chat, from screen: UUID, at time: Date) {
        screens[screen] = nil
        guard !screens.values.contains(chat) else { return }
        for turn in turns where since[turn] == nil { since[turn] = time }
    }

    /// The chat screen `screen`, showing `chat` with `turns` in it, is on screen: their
    /// pages are kept.
    public mutating func shown(_ turns: some Sequence<UUID>, of chat: Chat, on screen: UUID) {
        screens[screen] = chat
        for turn in turns { since[turn] = nil }
    }

    /// Only `turns` still have pages: the others are forgotten.
    public mutating func keep(only turns: Set<UUID>) {
        since = since.filter { turns.contains($0.key) }
    }

    /// When the next pages are due to be let go of, if any wait.
    public var nextDue: Date? {
        since.values.min().map { $0.addingTimeInterval(life) }
    }

    /// The turns whose pages are due to be let go of at `now`, forgotten here.
    public mutating func due(at now: Date) -> Set<UUID> {
        let due = Set(since.filter { now.timeIntervalSince($0.value) >= life }.keys)
        for turn in due { since[turn] = nil }
        return due
    }
}
