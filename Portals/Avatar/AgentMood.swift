/// What the agent is doing, for the avatar. The app sets it; the avatar morphs between moods
/// through the engine's own transitions (exponential ease-outs, a blink on each shape
/// change).
///
/// | Mood        | bloub states and cycle                                                          |
/// | ----------- | ------------------------------------------------------------------------------- |
/// | `idle`      | `idle` with the rest expression, held still: scheduled blinks, nothing else     |
/// | `listening` | `idle`, the head turns towards the user with the listening expression, held     |
/// | `thinking`  | `idle` with the rest face, glancing up to one side, then the other (3.4 s loop) |
/// | `talking`   | `idle` with small nods of the gaze while text streams                           |
/// | `happy`     | a `wink`, then `idle` with the happy expression, then the rest expression       |
/// | `waiting`   | `notify`: the rest face with a notification dot, until you answer               |
///
/// `happy` plays once and settles: it looks like `idle` afterwards, so the app can leave it
/// set until the next message. The moods that hold a pose (all but `thinking` and
/// `talking`) hold it still: between blinks nothing moves, not even bloub's slow drift of
/// the gaze and the body, which the two moods that loop keep.
nonisolated enum AgentMood: String, CaseIterable, Hashable, Sendable {
    case idle
    case listening
    case thinking
    case talking
    case happy
    /// The agent is blocked on you: an approval or a question.
    case waiting
}
