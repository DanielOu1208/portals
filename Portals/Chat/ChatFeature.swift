import Foundation
import os

/// The chat: one thread with one agent.
///
/// - `ChatScreen`: the screen. Header (the agent's avatar and name), transcript and the
///   composer, which is always at the bottom.
/// - `ThreadController`: one thread. Sends messages, applies the backend's events to a
///   `ThreadState`, stops and retries.
/// - `TurnView`: one turn of the transcript. `MarkdownBlocksView` lays out reply text.
/// - `ConnectionBanner`: under the header while the host is out of reach.
nonisolated enum ChatFeature {
    /// The longest message the composer accepts.
    static let messageLimit = 20_000
    /// The most images one message can carry.
    static let imageLimit = 4
    /// The chat's side margin, tighter than the page's so replies, code and diffs get
    /// the width. The composer is set in by the page's margin while it rests in the
    /// screen's rounded corners, and widens to this one when the keyboard is up.
    static let margin: CGFloat = 12
    /// The side of the composer's buttons, before Dynamic Type scales it.
    static let composerButton: CGFloat = 30
    /// Send and Stop, the composer's main buttons, are a little larger than the rest.
    static let composerSend: CGFloat = 36
    /// They reach a point into the space above and below their row, so the larger disc
    /// adds less to the composer's height than to its own.
    static let composerSendOverlap: CGFloat = -1
    /// On an iPhone and an iPad the composer's text grows to this many lines, then
    /// scrolls (`ComposerTextScroll`). A Mac's field keeps its own 2 to 14.
    static let composerLines = 6
    /// The height of one of the composer's lines at the standard text size: the field's
    /// own text view sets its lines 22 points apart for the 17-point body text.
    static let composerLineHeight: CGFloat = 22
    /// How long the avatar stays pleased after a reply lands.
    static let celebration: Duration = .seconds(2.5)
    /// How long reply text may pause before the status line comes back under it.
    static let replyQuiet: TimeInterval = 1.5
    /// The least time between two changes a reply's pieces make to the thread on screen
    /// (`PiecePacer`): ten a second, under the twenty steps a second its text is eased in
    /// at, so it shows the same.
    static let pieceInterval: TimeInterval = 0.1
    /// How long the host may be out of reach before the chat says so.
    static let connectionGrace: Duration = .seconds(1.5)
}

nonisolated enum AppLog {
    static let subsystem = "com.danielou.portals"
    /// Sends, turn endings and connection changes.
    static let chat = Logger(subsystem: subsystem, category: "chat")
    /// Notification permission, registration and routing.
    static let push = Logger(subsystem: subsystem, category: "push")
    /// The chat's scrolling: its height's jumps, the turns whose space changed and
    /// why, and the app's own moves to the end (to find what the user saw on 2026-10-25,
    /// blank under the last reply after a fast scroll down).
    static let scroll = Logger(subsystem: subsystem, category: "scroll")
}
