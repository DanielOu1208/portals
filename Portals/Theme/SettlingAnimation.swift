import SwiftUI

extension Animation {
    /// `base`, the same curve, over once what is left of it can no longer be seen. SwiftUI
    /// runs a spring on until a thousandth of a point is left of it: the tab strip's
    /// `.smooth(duration: 0.25)` went on so for 0.6 s after each switch, though nothing
    /// moved by a pixel after 0.4 s, and each of those frames cost the main thread about as
    /// much as one of the motion itself (the window's whole graph brought up to date,
    /// docs/perf-tabs.md).
    static func settling(_ base: Animation) -> Animation {
        Animation(Settling(base: base))
    }
}

/// Ends `base` once each part of what it moves is within a tenth of a point of where it
/// goes (a fifth of a pixel), for sizes and places, or a thousandth, for what goes from 0
/// to 1 (an opacity, a colour), and moves less than that in a frame: what is left is then
/// put in place, as `base` would have put it a few frames later. A change of 2 or more is
/// taken to be in points: nothing that animates this way changes by that much in other
/// units.
private struct Settling: CustomAnimation {
    let base: Animation

    func animate<V: VectorArithmetic>(value: V, time: TimeInterval, context: inout AnimationContext<V>) -> V? {
        guard let now = base.animate(value: value, time: time, context: &context) else { return nil }
        let near = value.magnitudeSquared >= 4 ? 0.1 : 0.001
        var left = value
        left -= now
        guard left.magnitudeSquared < near * near else { return now }
        // Still moving (an animation taken over from one under way can pass its end on the
        // way back): not yet.
        if let speed = base.velocity(value: value, time: time, context: context),
           speed.magnitudeSquared / (60 * 60) >= near * near {
            return now
        }
        return nil
    }

    func velocity<V: VectorArithmetic>(value: V, time: TimeInterval, context: AnimationContext<V>) -> V? {
        base.velocity(value: value, time: time, context: context)
    }

    func shouldMerge<V: VectorArithmetic>(previous: Animation, value: V, time: TimeInterval, context: inout AnimationContext<V>) -> Bool {
        base.shouldMerge(previous: previous, value: value, time: time, context: &context)
    }
}
