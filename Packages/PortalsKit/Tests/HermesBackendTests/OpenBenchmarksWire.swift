import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// What opening a thread costs the app once the host's answer has arrived: the frame
/// parsed, the answer read as a `session.resume` result, and the conversation turned into
/// a transcript (HermesHistoryMapper); and its saved copy made and read as `ThreadStore`
/// writes and reads it (ISO 8601 dates, sorted keys), which the app does on the main
/// thread at each send and turn's end (docs/perf-n18.md). Times only, nothing asserted of them; only when
/// asked, with an answer saved from a bridge (bridge/scripts/bench/open.ts fetch with
/// BENCH_SAVE, scripts/open-bench.sh's 120-turn thread is 2.3 MB):
///
///     PORTALS_BENCH=1 PORTALS_OPEN_FRAME=/private/tmp/…/t120-resume.json \
///         swift test --no-parallel --filter OpenBenchmarksWire
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["PORTALS_BENCH"] == "1", "Only with PORTALS_BENCH=1"))
struct OpenBenchmarksWire {
    @Test func aLongThreadsAnswer() throws {
        let path = try #require(ProcessInfo.processInfo.environment["PORTALS_OPEN_FRAME"])
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let rounds = Int(ProcessInfo.processInfo.environment["PORTALS_OPEN_ROUNDS"] ?? "") ?? 5
        var parse: [Double] = [], decode: [Double] = [], map: [Double] = [], contents: [Double] = []
        var saved: [Double] = [], read: [Double] = []
        var turns = 0, savedBytes = 0
        for _ in 0..<rounds {
            var mark = ContinuousClock.now
            let frame = try InboundFrame.parse(text)
            parse.append(Self.ms(ContinuousClock.now - mark))
            guard case let .response(_, .success(result)) = frame else { Issue.record("not a response"); return }
            mark = ContinuousClock.now
            let resumed = try result.decode(HermesWire.SessionResumeResult.self)
            decode.append(Self.ms(ContinuousClock.now - mark))
            mark = ContinuousClock.now
            for message in resumed.messages ?? [] {
                if let content = message["content"]?.stringValue { _ = try? JSONValue.parse(content) }
            }
            contents.append(Self.ms(ContinuousClock.now - mark))
            mark = ContinuousClock.now
            let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: [])
            map.append(Self.ms(ContinuousClock.now - mark))
            turns = snapshot.transcript.turns.count
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys]
            mark = ContinuousClock.now
            let data = try encoder.encode(snapshot.transcript)
            saved.append(Self.ms(ContinuousClock.now - mark))
            savedBytes = data.count
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            mark = ContinuousClock.now
            _ = try decoder.decode(Transcript.self, from: data)
            read.append(Self.ms(ContinuousClock.now - mark))
        }
        let median = { (values: [Double]) in String(format: "%.1f", values.sorted()[rounds / 2]) }
        print("""

        Opening a thread of \(turns) turns from a \(text.utf8.count / 1000) kB answer: \(rounds) rounds, medians.

        | Frame parsed, ms | Read as a resume, ms | Tools' results parsed, ms | Made a transcript, ms | Saved copy made, ms | Saved copy read, ms | Saved copy, kB |
        |---:|---:|---:|---:|---:|---:|---:|
        | \(median(parse)) | \(median(decode)) | \(median(contents)) | \(median(map)) | \(median(saved)) | \(median(read)) | \(savedBytes / 1000) |

        """)
    }

    private static func ms(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
    }
}
