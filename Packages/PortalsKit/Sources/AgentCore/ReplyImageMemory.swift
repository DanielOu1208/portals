import Foundation

/// How many of the images replies show are kept decoded in memory while the app runs
/// (`ReplyImages` in the app), and how many bytes of bitmaps they may take in all.
///
/// An image is decoded at up to 2048 pixels on its longer side: about 8 MB for a phone's
/// screenshot, 16 MB for a square one. Kept by count alone, sixty of them were several
/// hundred MB on a phone, which the system ends an app for; by bytes too, a phone keeps a
/// dozen or so screenshots, and those scrolled away from longest are let go first. The
/// copies on disk (`ReplyImageStore`) are kept either way, so one let go comes back
/// without asking the Mac.
public enum ReplyImageMemory {
    /// At most this many images, however small.
    public static let countLimit = 60

    private static let megabyte = 1024 * 1024

    /// The bytes of bitmaps kept on a device with `physicalMemory` bytes of memory: a
    /// fortieth of it, at most 128 MB on a phone or an iPad (256 MB on a Mac) and at least
    /// 32 MB, room for a few screenshots on the smallest.
    public static func costLimit(physicalMemory: UInt64, isMac: Bool) -> Int {
        let share = Int(clamping: physicalMemory / 40)
        return max(32 * megabyte, min(share, (isMac ? 256 : 128) * megabyte))
    }
}
