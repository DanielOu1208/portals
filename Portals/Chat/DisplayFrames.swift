import QuartzCore
import UIKit

/// The display's frames, one element each, until `stop()`: for work that has to look once
/// a frame, no more and no less (a thread finding its end as it opens,
/// `ChatScreen.settle`). A sleep of a frame's length overshoots on a busy main thread
/// and misses frames on a faster display.
@MainActor
final class DisplayFrames {
    let frames: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private let link: CADisplayLink

    init() {
        (frames, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        link = CADisplayLink(target: Ticker(continuation), selector: #selector(Ticker.tick))
        link.add(to: .main, forMode: .common)
    }

    func stop() {
        link.invalidate()
        continuation.finish()
    }

    /// Returns after the display's next `count` frames: for one move made only once the
    /// one before it was laid out.
    static func wait(_ count: Int = 1) async {
        let display = DisplayFrames()
        defer { display.stop() }
        var seen = 0
        for await _ in display.frames {
            seen += 1
            if seen >= count { return }
        }
    }

    private final class Ticker: NSObject {
        let continuation: AsyncStream<Void>.Continuation

        init(_ continuation: AsyncStream<Void>.Continuation) {
            self.continuation = continuation
        }

        @objc func tick() {
            continuation.yield()
        }
    }
}
