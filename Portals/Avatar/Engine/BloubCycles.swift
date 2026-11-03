// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/cycles.ts (the montage model; the editor's naming helpers and the
// localStorage parser are not ported). Full licence text: THIRD_PARTY_NOTICES.md.

/// A cycle is a montage: a list of blocks, each a state held for a chosen time. A block
/// is stretched by letting the state run longer and shortened by cutting; local time is
/// never scaled, which would break every measured duration at once.
nonisolated extension Bloub {
    struct Block: Equatable, Sendable {
        var state: StateID
        var duration: Double
    }

    struct Cycle: Equatable, Sendable {
        var id: String
        var name: String
        var blocks: [Block]
    }

    enum Cycles {
        /// Common floor for every block, DERIVED from the longest entry morph in the
        /// catalogue (orbit's 0.6 s), not written by hand.
        static let minBlock: Double = states.map(\.morph).max() ?? 0.6

        /// Editor guard, not a measurement.
        static let maxBlock = 10.0
        static let maxBlocks = 200
        static let maxCycles = 50

        /// Wheel and resize step, seconds.
        static let step = 0.1

        static let defaultCycleID = "defaut"

        /// A block's shortest duration: the engine floor, or the state's measured one.
        static func minDuration(of state: StateID) -> Double {
            max(minBlock, state.def.minDuration ?? minBlock)
        }

        /// Clamps a duration to its bounds and to the step, with no floating tail.
        static func clampDuration(_ state: StateID, _ seconds: Double) -> Double {
            let snapped = jsRound(seconds / step) * step
            let bounded = min(maxBlock, max(minDuration(of: state), snapped))
            return jsRound(bounded * 100) / 100
        }

        static func makeBlock(_ state: StateID) -> Block {
            // the reference duration is the one measured on the video for this state
            Block(state: state, duration: clampDuration(state, state.def.duration))
        }

        /// The montage measured on the video: `sequence`, each state held its measured time.
        static func defaultCycle() -> Cycle {
            Cycle(id: defaultCycleID, name: "", blocks: sequence.map(makeBlock))
        }

        static func totalDuration(_ blocks: [Block]) -> Double {
            blocks.reduce(0) { $0 + $1.duration }
        }

        /// Start time of a block in the montage.
        static func offset(of index: Int, in blocks: [Block]) -> Double {
            var acc = 0.0
            var i = 0
            while i < index && i < blocks.count {
                acc += blocks[i].duration
                i += 1
            }
            return acc
        }

        /// The block playing at time `t`, and the time elapsed in it. Past the last block
        /// playback wraps to the start: the montage loops.
        static func blockAt(_ blocks: [Block], _ t: Double) -> (index: Int, elapsed: Double) {
            let total = totalDuration(blocks)
            if blocks.isEmpty || total <= 0 { return (0, 0) }
            // the modulo only applies when needed: on a time already inside the cycle it
            // would only add a floating tail to the elapsed time
            let wrapped = t >= 0 && t < total
                ? t
                : ((t.truncatingRemainder(dividingBy: total)) + total).truncatingRemainder(dividingBy: total)
            var acc = 0.0
            for (i, block) in blocks.enumerated() {
                let end = acc + block.duration
                if wrapped < end { return (i, wrapped - acc) }
                acc = end
            }
            return (blocks.count - 1, 0)
        }

        /// Appends a state to the montage, capped at `maxBlocks`.
        static func blocks(_ blocks: [Block], with state: StateID) -> [Block] {
            if blocks.count >= maxBlocks { return blocks }
            return blocks + [makeBlock(state)]
        }

        /// Moves a block, returning a new list.
        static func moveBlock(_ blocks: [Block], from: Int, to: Int) -> [Block] {
            guard blocks.indices.contains(from) else { return blocks }
            var next = blocks
            let moved = next.remove(at: from)
            next.insert(moved, at: min(max(to, 0), next.count))
            return next
        }
    }
}
