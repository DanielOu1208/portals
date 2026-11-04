import Foundation

/// The free space on a host's disk, as its bridge says it (feature `disk_space`, `disk`):
/// Settings shows it on the host's row, with a warning while it runs low, before the disk
/// is full and agents fail (2026-11-03: "guard against full disk and show it in settings").
/// The bridge tells the threads itself.
public struct HostDisk: Hashable, Sendable {
    /// How full the disk is, as the bridge judged it: `low` under 5 GB free, `critical`
    /// under 1 GB (less on a small disk).
    public enum Level: String, Sendable {
        case ok, low, critical
    }

    /// Free bytes, as an app on the host may use them.
    public var free: Int64
    /// The disk's size in bytes.
    public var total: Int64
    public var level: Level

    public init(free: Int64, total: Int64, level: Level) {
        self.free = free
        self.total = total
        self.level = level
    }

    /// Whether Settings warns of it.
    public var isLow: Bool { level != .ok }

    /// "120.4 GB free", in the units Finder uses.
    public var freeText: String {
        "\(ByteCountFormatter.string(fromByteCount: free, countStyle: .file)) free"
    }

    /// The line Settings shows on the host's row.
    public var message: String {
        switch level {
        case .ok: freeText
        case .low: "Low on disk space: \(freeText)"
        case .critical: "Almost out of disk space: \(freeText)"
        }
    }
}
