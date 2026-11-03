/// Bounds how far a page may move the chat by itself. The frame follows each growth of the
/// page until it has grown `mostIncreases` times since it loaded, its width changed, or the
/// user last did something on it (a tap, a key: `interacted`); after that it follows only
/// shrinks, until one of those three. So an expand or collapse the user taps always resizes
/// the frame, however many there are, while a page that keeps changing its own height (an
/// animation that pulses, content rebuilt every second) stops relaying out the chat after a
/// moment, rather than for as long as it is loaded: a shrink alone does not give the
/// allowance back. Even a refused resize keeps the real content height, so the native frame
/// can stop growing without making its overflow unreachable.
public struct WidgetGrowth: Sendable {
    private var accepted: (height: Double, width: Double)?
    private var increases = 0
    private static let mostIncreases = 40

    public private(set) var contentHeight: Double?

    public init() {}

    /// Whether the native frame should follow this measurement. `interacted`: the user did
    /// something on the page since its last measurement.
    public mutating func record(height: Double, width: Double, interacted: Bool = false) -> Bool {
        guard height.isFinite, width.isFinite, height >= 0, height <= 100_000, width > 0 else { return false }
        contentHeight = height
        // The user's doing, or another width (the device turned, the column resized): a
        // fresh allowance. The first measurement has one already.
        if interacted || (accepted.map { $0.width != width } ?? false) { increases = 0 }
        if let accepted, accepted.width == width, height > accepted.height {
            guard increases < Self.mostIncreases else { return false }
            increases += 1
        }
        accepted = (height, width)
        return true
    }

    public mutating func reset() {
        self = Self()
    }
}
