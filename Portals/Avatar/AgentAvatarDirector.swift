import AgentCore
import Foundation

/// A mood as a timeline of engine setters, relative to the moment the mood starts:
/// an intro played once, then an optional loop.
nonisolated struct AgentMoodScript: Sendable {
    enum Action: Equatable, Sendable {
        case state(Bloub.StateID)
        case expression(Bloub.ExpressionID)
        case look(Bloub.Look?, morph: Double)
    }

    struct Step: Equatable, Sendable {
        var at: Double
        var action: Action
    }

    var intro: [Step]
    var loop: [Step] = []
    /// When the loop starts, after the mood starts.
    var loopStart = 0.0
    /// Length of one loop iteration.
    var period = 0.0

    var loops: Bool { !loop.isEmpty && period > 0 }

    /// When a non-looping script has played its last step.
    var end: Double { intro.map(\.at).max() ?? 0 }

    /// An upward glance to one side, for thinking.
    static func ponder(yaw: Double, pitch: Double = 20) -> Bloub.Look {
        Bloub.Look(yaw: yaw, pitch: pitch, mix: 1, spin: 0, wander: 0.2)
    }

    /// The listening face's turn towards the user. Held: the avatar listens still.
    static let listeningLook = Bloub.Look(yaw: 2, pitch: 2, mix: 0.6, spin: 0, wander: 0, float: 0)

    /// The moods that play out and hold a pose (idle, listening, happy, waiting) hold it
    /// still: nothing moves between blinks, not even bloub's slow drift of the gaze and
    /// the body. Their looks glide it out as a mood starts. The moods that loop
    /// (thinking, talking) keep the drift, a part of their motion.
    static func script(for mood: AgentMood, style: AgentAvatarStyle) -> AgentMoodScript {
        let rest = style.rest.expression.gaze
        switch mood {
        case .idle:
            return AgentMoodScript(intro: [
                Step(at: 0, action: .state(.idle)),
                Step(at: 0, action: .expression(style.rest)),
                Step(at: 0, action: .look(.still, morph: 0.5)),
            ])
        case .listening:
            // The listening face (a head tilt) turned to face the user.
            return AgentMoodScript(intro: [
                Step(at: 0, action: .state(.idle)),
                Step(at: 0, action: .expression(style.listening)),
                Step(at: 0, action: .look(listeningLook, morph: 0.5)),
            ])
        case .thinking:
            // Pondering: the avatar keeps its body and face and glances up to one side,
            // drifts, then up to the other, as someone does while they think.
            // (bloub's own thinking state turns the body into three dots.)
            return AgentMoodScript(
                intro: [
                    Step(at: 0, action: .state(.idle)),
                    Step(at: 0, action: .expression(style.rest)),
                    Step(at: 0, action: .look(Self.ponder(yaw: -18), morph: 0.45)),
                ],
                loop: [
                    Step(at: 0, action: .look(Self.ponder(yaw: -18), morph: 0.45)),
                    Step(at: 1.1, action: .look(Self.ponder(yaw: -9, pitch: 24), morph: 0.6)),
                    Step(at: 1.7, action: .look(Self.ponder(yaw: 18), morph: 0.45)),
                    Step(at: 2.8, action: .look(Self.ponder(yaw: 9, pitch: 24), morph: 0.6)),
                ],
                loopStart: 0.6,
                period: 3.4
            )
        case .talking:
            // Small nods of the gaze, at a speaking rhythm, around the rest face.
            func nod(_ dYaw: Double, _ dPitch: Double) -> Action {
                .look(Bloub.Look(yaw: rest.yaw + dYaw, pitch: rest.pitch + dPitch, mix: 1, spin: 0, wander: 0.35), morph: 0.26)
            }
            return AgentMoodScript(
                intro: [Step(at: 0, action: .state(.idle)), Step(at: 0, action: .expression(style.rest))],
                loop: [
                    Step(at: 0, action: nod(1, 6)),
                    Step(at: 0.3, action: nod(0, -2)),
                    Step(at: 0.62, action: nod(-2, 5)),
                    Step(at: 0.9, action: nod(1, -1)),
                    Step(at: 1.35, action: nod(3, 7)),
                    Step(at: 1.66, action: nod(0, -3)),
                    Step(at: 2.1, action: nod(-1, 3)),
                ],
                loopStart: 0,
                period: 2.6
            )
        case .happy:
            return AgentMoodScript(intro: [
                Step(at: 0, action: .look(.still, morph: 0.5)),
                Step(at: 0, action: .state(.wink)),
                Step(at: 1.2, action: .state(.idle)),
                Step(at: 1.2, action: .expression(style.happy)),
                Step(at: 3.2, action: .expression(style.rest)),
            ])
        case .waiting:
            // bloub's notify state: the body with a notification dot, looking at you.
            return AgentMoodScript(intro: [
                Step(at: 0, action: .look(.still, morph: 0.5)),
                Step(at: 0, action: .expression(style.rest)),
                Step(at: 0, action: .state(.notify)),
            ])
        }
    }
}

/// Plays moods on a `Bloub.Engine`.
///
/// Every setter is applied with its own scheduled timestamp, never the frame's, so what
/// you see depends only on when the moods changed, not on the frame rate. The engine
/// stays a pure function of time; this class only holds the schedule.
///
/// Its time is the avatar's own clock (`AvatarClock`), read off the system's uptime, never
/// the time of day the timeline's dates are in: the time of day set back while the app was
/// away kept an avatar timed by it at 30 frames a second until the old time came round.
/// While paused (the app in the background, or no window of it seen) the clock stands
/// still, so that it goes on from the pose it was left in, not one further on.
final class AgentAvatarDirector {
    private var engine: Bloub.Engine
    private var style: AgentAvatarStyle
    /// Its clock, where its mood began and what changed last: whether it is at rest.
    private var pacing: AvatarPacing
    /// The system's uptime and the time of day, as read here: given, to try the avatar
    /// with the time of day set back.
    private let uptime: () -> TimeInterval
    private let wallNow: () -> Date
    private var mood: AgentMood?
    private var script = AgentMoodScript(intro: [])
    /// Next intro step to apply.
    private var introCursor = 0
    /// Next loop step to apply: iteration and index.
    private var loopIteration = 0
    private var loopCursor = 0

    /// bloub pre-draws blinks for 900 s. Past this, the clock is moved back at the next
    /// quiet blink (see `reanchorIfQuiet`).
    private static let reanchorAfter = 600.0

    /// `clockStart`: where on bloub's clock this avatar starts, so two avatars on screen
    /// don't blink (or, thinking, drift) in unison. Within the first minute, far from the
    /// 900 s schedule end.
    init(style: AgentAvatarStyle = .standard, clockStart: Double = .random(in: 0..<60),
         uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         wallNow: @escaping () -> Date = { Date() })
    {
        self.style = style
        self.uptime = uptime
        self.wallNow = wallNow
        pacing = AvatarPacing(clock: AvatarClock(start: clockStart), cadence: Self.cadence)
        engine = Bloub.Engine(scale: 1, initial: .idle, shape: style.bodyShape, expression: style.rest.expression)
        // Still from the start, before the clock's first frame (at `clockStart`): an
        // avatar at rest as it appears does not glide in from a drift.
        engine.setLook(.still, now: -10)
    }

    /// The avatar is paused, or goes on, now.
    func setPaused(_ paused: Bool) {
        if paused {
            pacing.clock.pause(at: uptime())
        } else {
            pacing.clock.resume(at: uptime())
        }
    }

    /// The frame for now, starting or switching mood first if needed. Drawn while paused (a
    /// change of mood or look, the first frame as it goes on), it is drawn at the time it
    /// paused at: its clock goes on from there once it resumes.
    func frame(mood: AgentMood, style: AgentAvatarStyle) -> Bloub.Frame {
        let uptime = uptime()
        var now = pacing.clock.time(at: uptime)
        if style != self.style {
            self.style = style
            engine.setShape(style.bodyShape, now: now)
            pacing.lastChange = now
            self.mood = nil
        }
        if mood != self.mood { start(mood, at: now) }
        advance(to: now)
        if now > Self.reanchorAfter, reanchorIfQuiet(at: now, uptime: uptime) {
            now = pacing.clock.time(at: uptime)
        }
        return engine.sample(now)
    }

    /// When the frame after the one at `date` is due: at the full rate while something
    /// moves, at rest only for the blinks (`AvatarCadence`). A `mood` or `style` not started
    /// yet is a change about to be drawn: its first frames come at the full rate too, not
    /// a rest's gap after the frame that starts it.
    /// Its dates are the timeline's, in the time of day; the times they stand for are on the
    /// avatar's clock (`AvatarPacing.nextDate`). At rest, the body holds a still pose: at
    /// rest, or waiting (its dot pops in its first half second, then stays).
    func nextFrame(after date: Date, mood: AgentMood, style: AgentAvatarStyle) -> Date {
        guard pacing.clock.hasStarted, mood == self.mood, style == self.style else { return date.addingTimeInterval(Self.cadence.busy) }
        return pacing.nextDate(after: date, now: wallNow(), uptime: uptime(), stillPose: Self.stillStates.contains(engine.state),
                               blinks: Bloub.blinkSchedule, blinkLength: Bloub.blinkDuration)
    }

    static let cadence = AvatarCadence()

    private static let stillStates: Set<Bloub.StateID> = [.idle, .notify]

    private func start(_ mood: AgentMood, at now: Double) {
        self.mood = mood
        script = AgentMoodScript.script(for: mood, style: style)
        pacing.began(length: script.end, loops: script.loops, at: now)
        introCursor = 0
        loopIteration = 0
        loopCursor = 0
    }

    private func advance(to now: Double) {
        let scriptStart = pacing.moodStart
        while introCursor < script.intro.count, scriptStart + script.intro[introCursor].at <= now {
            apply(script.intro[introCursor].action, at: scriptStart + script.intro[introCursor].at)
            introCursor += 1
        }
        guard script.loops, now >= scriptStart + script.loopStart else { return }
        // After a long pause (app in the background), skip to the current iteration.
        let elapsed = now - scriptStart - script.loopStart
        let current = Int(elapsed / script.period)
        if current > loopIteration + 1 {
            loopIteration = current - 1
            loopCursor = 0
        }
        while true {
            let step = script.loop[loopCursor]
            let at = scriptStart + script.loopStart + Double(loopIteration) * script.period + step.at
            if at > now { break }
            apply(step.action, at: at)
            loopCursor += 1
            if loopCursor == script.loop.count {
                loopCursor = 0
                loopIteration += 1
            }
        }
    }

    private func apply(_ action: AgentMoodScript.Action, at t: Double) {
        switch action {
        case .state(let id):
            if engine.state != id { pacing.lastChange = t }
            engine.setState(id, now: t)
        case .expression(let id):
            if engine.currentExpression?.id != id { pacing.lastChange = t }
            engine.setExpression(id.expression, now: t)
        case .look(let look, let morph):
            if engine.currentLook != (look ?? .none) { pacing.lastChange = t }
            engine.setLook(look, now: t, morph: morph)
        }
    }

    /// bloub's blink schedule ends at 900 s and its drift is a function of absolute time,
    /// so the clock can't simply wrap. Once a non-looping mood has settled (holding
    /// still, its drift out), the engine is rebuilt on a fresh clock at the bottom of a
    /// scheduled blink, where the new clock is also mid-blink: the eyes are closed as it
    /// changes.
    private func reanchorIfQuiet(at now: Double, uptime: TimeInterval) -> Bool {
        guard !script.loops, now - pacing.moodStart > script.end + 1, now - pacing.lastChange > 2 else { return false }
        let schedule = Bloub.blinkSchedule
        guard let start = schedule.last(where: { $0 <= now }) else { return false }
        let into = now - start
        // the bottom of a blink: lid below about 0.3
        guard into > 0.055, into < 0.11, schedule.count > 2 else { return false }
        let fresh = schedule[2] + into
        var engine = Bloub.Engine(scale: 1, initial: self.engine.state, shape: style.bodyShape,
                                  expression: self.engine.currentExpression)
        let look = self.engine.currentLook
        engine.setLook(look == .none ? nil : look, now: fresh - 10)
        self.engine = engine
        pacing.clock.set(fresh, at: uptime)
        pacing.moodStart = fresh - script.end - 10
        pacing.lastChange = fresh - 10
        return true
    }

    /// A still frame of a mood, for Reduce Motion: the pose the mood settles on.
    static func still(_ mood: AgentMood, style: AgentAvatarStyle) -> Bloub.Frame {
        switch mood {
        case .idle, .talking:
            return frozen(.idle, at: 1, style: style)
        case .listening:
            return frozen(.idle, at: 1, style: style, expression: style.listening,
                          look: Bloub.Look(yaw: 2, pitch: 2, mix: 0.6, spin: 0, wander: 0.5))
        case .thinking:
            return frozen(.idle, at: 1, style: style, look: AgentMoodScript.ponder(yaw: -18))
        case .happy:
            return frozen(.idle, at: 1, style: style, expression: style.happy)
        case .waiting:
            return frozen(.notify, at: Bloub.poseTimes[.notify] ?? 0.9, style: style)
        }
    }

    /// One exact frame of a bloub state, `t` seconds into it, in `style`.
    static func frozen(_ state: Bloub.StateID, at t: Double, style: AgentAvatarStyle,
                       expression: Bloub.ExpressionID? = nil, look: Bloub.Look? = nil) -> Bloub.Frame
    {
        // A still avatar of a row (no expression or look of its own) is the same frame
        // every time it is drawn: worked out once per look, not per row and per redraw.
        let key = expression == nil && look == nil ? FrozenKey(state: state, t: t, style: style) : nil
        if let key, let frame = frozenFrames[key] { return frame }
        var engine = Bloub.Engine(scale: 1, initial: state, shape: style.bodyShape,
                                  expression: (expression ?? style.rest).expression)
        if let look { engine.setLook(look, now: t - 10) }
        let frame = engine.sample(t)
        if let key {
            if frozenFrames.count >= 64 { frozenFrames.removeAll() }
            frozenFrames[key] = frame
        }
        return frame
    }

    private struct FrozenKey: Hashable {
        var state: Bloub.StateID
        var t: Double
        var style: AgentAvatarStyle
    }

    private static var frozenFrames: [FrozenKey: Bloub.Frame] = [:]
}
