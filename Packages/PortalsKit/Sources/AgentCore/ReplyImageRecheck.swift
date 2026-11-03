import Foundation

/// When an image a reply shows is asked of the Mac once more, whatever it said before: as
/// the reply that names it ends, when it was shown while the reply was being written (the
/// agent may have made or changed the file meanwhile). Once: an ended reply's image that
/// comes back into view later (the lazy chat loads it again each time) is asked no more
/// than any other's, from what the Mac said since (`ReplyImages.load` in the app, by etag).
///
/// One for each image on screen (`LoadedImage` in the app), kept with it.
public struct ReplyImageRecheck: Sendable, Equatable {
    /// Shown while its reply was being written, and not asked again since the reply ended.
    private var due = false

    public init() {}

    /// A load of the image begins, its reply being written or not: whether this one is to
    /// ask the Mac whatever it said before. Until it is `made`, every load after the
    /// reply's end is (one stopped before it asked, as the image went out of view, is
    /// not the check).
    public mutating func begin(isBeingWritten: Bool) -> Bool {
        if isBeingWritten {
            due = true
            return false
        }
        return due
    }

    /// The Mac was asked, as the reply ended: it answered, said no or could not be reached.
    public mutating func made() {
        due = false
    }
}
