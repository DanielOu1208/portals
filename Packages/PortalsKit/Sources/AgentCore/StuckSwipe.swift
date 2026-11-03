/// When a sidebar swipe that stopped moving without an end is put to rest: a quarter of a
/// second and a bit after its last move, or, with the finger still down (resting
/// mid-swipe), longer. One check waits for it for the whole swipe (`MainScreen`'s
/// `SidebarSlide.StuckCheck`), where a task of its own was made at each move.
public enum StuckSwipe {
    /// How long a swipe may go without a move before it is taken to be stuck.
    public static let quiet = 0.35
    /// How much longer a finger may rest mid-swipe.
    public static let resting = 1.2

    public enum Step: Equatable, Sendable {
        /// Look again in this many seconds: it may move meanwhile.
        case wait(Double)
        /// Put it to rest where it is.
        case settle
    }

    /// What to do about a swipe that has not moved for `still` seconds.
    public static func step(still: Double, fingerDown: Bool) -> Step {
        let due = fingerDown ? quiet + resting : quiet
        return still >= due ? .settle : .wait(due - max(still, 0))
    }
}
