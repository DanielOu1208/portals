import Foundation

/// How tall widgets were measured, by their HTML and the width they were shown at, kept
/// from one launch to the next: a thread opened again lays its widgets out at their
/// height before their pages have loaded, and does not jump when they have. The least
/// recently measured are let go past `capacity`.
public struct WidgetHeights: Codable, Equatable, Sendable {
    /// How many are kept.
    public static let capacity = 600
    /// Widths this close are one width: a window resized a little keeps its heights.
    public static let widthStep = 16.0
    /// How many steps away a height measured at another width is still taken.
    static let nearby = 4

    private struct Entry: Codable, Equatable {
        var height: Double
        /// When it was measured, as a count of measurements: the lowest goes first.
        var order: Int
    }

    private var entries: [String: Entry] = [:]
    private var count = 0

    public init() {}

    /// The height the widget was measured at for `width`, or at the nearest width it was
    /// measured at, a few steps away at most.
    public func height(for hash: UInt64, width: Double) -> Double? {
        let step = Self.step(width)
        for distance in 0...Self.nearby {
            for candidate in Set([step - distance, step + distance]) {
                if let entry = entries[Self.key(hash, candidate)] { return entry.height }
            }
        }
        return nil
    }

    /// Remembers a measurement. False when it was known already.
    @discardableResult
    public mutating func record(_ height: Double, for hash: UInt64, width: Double) -> Bool {
        let key = Self.key(hash, Self.step(width))
        if entries[key]?.height == height { return false }
        count += 1
        entries[key] = Entry(height: height, order: count)
        if entries.count > Self.capacity {
            let oldest = entries.sorted { $0.value.order < $1.value.order }.prefix(entries.count - Self.capacity)
            for (key, _) in oldest { entries[key] = nil }
        }
        return true
    }

    public var isEmpty: Bool { entries.isEmpty }

    private static func step(_ width: Double) -> Int {
        Int((width / widthStep).rounded())
    }

    private static func key(_ hash: UInt64, _ step: Int) -> String {
        "\(String(hash, radix: 16))@\(step)"
    }
}
