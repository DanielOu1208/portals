import Foundation

/// Which of the threads opened since launch the app keeps ready, and which it lets go.
///
/// Every thread opened used to stay in memory until the app quit, with its transcript,
/// so that a run going on in it kept being followed while another was on screen. A
/// thread at rest and off screen needs none of that: let go, it is opened again from its
/// saved copy the next time it is shown, the way it is after a launch. So the app keeps
/// the thread on screen, every thread with something under way (a run, a question for
/// the user, a message on its way or queued), and the few at rest that were looked at
/// last, open tabs before the rest; the others are let go.
public enum OpenThreads {
    /// Threads at rest kept besides those, the most recently shown.
    public static let keptAtRest = 8

    /// The threads to let go, of those `open`.
    ///
    /// - Parameters:
    ///   - open: the threads held now.
    ///   - shown: the order they were last put on screen in, the most recent last. A
    ///     thread held but never shown counts as shown before all of these.
    ///   - atRest: those of `open` with nothing under way.
    ///   - onScreen: the thread on screen, which is always kept.
    ///   - preferring: threads kept before the others at rest, the most recently shown of
    ///     them first: this device's open tabs (`OpenTabs`), which are put back on screen
    ///     with a click. The others at rest take the places they leave.
    public static func toLetGo<ID: Hashable>(
        open: Set<ID>, shown: [ID], atRest: Set<ID>, onScreen: ID?, keeping kept: Int = keptAtRest,
        preferring preferred: Set<ID> = []
    ) -> Set<ID> {
        var rank: [ID: Int] = [:]
        for (index, id) in shown.enumerated() { rank[id] = index }
        let resting = open.filter { atRest.contains($0) && $0 != onScreen }
            .sorted { one, other in
                let isPreferred = (preferred.contains(one), preferred.contains(other))
                if isPreferred.0 != isPreferred.1 { return isPreferred.0 }
                return (rank[one] ?? -1) > (rank[other] ?? -1)
            }
        return Set(resting.dropFirst(max(kept, 0)))
    }
}
