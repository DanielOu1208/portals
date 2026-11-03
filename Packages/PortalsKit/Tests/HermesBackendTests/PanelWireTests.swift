import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// The panel beside the chat (`ThreadPanelProviding`): what a bridge's `git.status`,
/// `usage.read` and `host.apps` answer, as the app reads it, and the params it sends, as
/// the contract subset lists them.
@Suite struct PanelWireTests {
    private func decode<Output: Decodable>(_ json: String, as type: Output.Type) throws -> Output {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func gitStatusReadsEachState() throws {
        #expect(try decode(#"{"repo":false}"#, as: BridgeWire.GitStatusResult.self).state == .noRepository)
        #expect(try decode(#"{"repo":true,"git":false,"branch":"main","commit":null}"#, as: BridgeWire.GitStatusResult.self).state == .branchOnly(branch: "main", commit: nil))
        let json = #"""
        {"repo":true,"git":true,"root":"/w","branch":"panel","commit":"abc1234","upstream":"origin/panel","ahead":2,"behind":0,
         "files":[{"path":"src/a.ts","status":"modified","staged":false,"added":3,"removed":1},
                  {"path":"b.bin","status":"untracked","staged":false,"added":null,"removed":0},
                  {"path":"new.ts","status":"renamed","from":"old.ts","staged":true,"added":0,"removed":0},
                  {"path":"x","status":"something_new","added":1,"removed":1}],
         "total":40,"added":4,"removed":2}
        """#
        guard case let .status(status) = try decode(json, as: BridgeWire.GitStatusResult.self).state else {
            Issue.record("not a status")
            return
        }
        #expect(status.branch == "panel")
        #expect(status.upstream == "origin/panel")
        #expect(status.ahead == 2)
        #expect(status.total == 40)
        #expect(status.files[1].added == nil)
    }

    @Test func usageReadsWindowsAndAnAgentThatCannotSay() throws {
        #expect(try decode(#"{"available":false}"#, as: BridgeWire.UsageReadResult.self).usage == nil)
        let usage = try #require(try decode(
            #"{"available":true,"title":"Claude Max","plan":"max","limits":[{"name":"5-hour","percent":42,"resets_at":1800000000,"window_seconds":18000},{"name":"weekly","percent":null,"resets_at":null,"reached":true}],"heard_at":1800000000000,"note":"Credits left: 5."}"#,
            as: BridgeWire.UsageReadResult.self
        ).usage)
        #expect(usage.title == "Claude Max")
        #expect(usage.windows[0].length == 18000)
        #expect(usage.windows[1].length == nil)
        #expect(usage.windows[1].left == 0)
        #expect(usage.windows.count == 2)
        #expect(usage.windows[0].percent == 42)
        #expect(usage.windows[0].resetsAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(usage.windows[1].reached)
        #expect(usage.windows[1].percent == nil)
        #expect(usage.heardAt == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(usage.windows[0].heardAt == nil)
        #expect(usage.note == "Credits left: 5.")
    }

    @Test func hostAppsReadTheirKindsAndIcons() throws {
        let apps = try decode(#"{"apps":[{"id":"finder","name":"Finder","kind":"files","icon":"iVBORw=="},{"id":"ghostty","name":"Ghostty","kind":"terminal"}]}"#, as: BridgeWire.HostAppsResult.self).hostApps
        #expect(apps == [
            HostApp(id: "finder", name: "Finder", kind: .files, icon: Data([0x89, 0x50, 0x4E, 0x47])),
            HostApp(id: "ghostty", name: "Ghostty", kind: .terminal),
        ])
    }

    @Test func gitDiffIsOneDiffOfEveryFile() throws {
        let result = try decode(
            #"{"root":"/w","total":4,"files":[{"path":"a.ts","status":"modified","added":2,"removed":1,"diff":"@@ -1 +1 @@\n-x\n+y\n","cut":false},{"path":"new.md","status":"untracked","added":3,"removed":0,"diff":"+a\n"},{"path":"gone.ts","status":"deleted","added":0,"removed":4,"diff":"","cut":true},{"path":"pic.png","status":"added","added":null,"removed":null,"diff":""}]}"#,
            as: BridgeWire.GitDiffResult.self
        )
        #expect(result.root == "/w")
        let diff = result.turnDiff
        #expect(diff.files.map(\.status) == [.modified, .added, .deleted, .added])
        #expect(diff.added == 5)
        #expect(diff.removed == 5)
        #expect(diff.cut)
        #expect(diff.files[3].added == 0)
        #expect(diff.files.map(\.uncounted) == [false, false, false, true])
        #expect(result.total == 4)
    }

    /// How many files differ in all comes in the same answer as the files listed.
    @Test func gitDiffSaysHowManyDifferInAll() throws {
        let result = try decode(
            #"{"root":"/w","total":351,"files":[{"path":"a.ts","status":"modified","added":2,"removed":1,"diff":"","cut":true}]}"#,
            as: BridgeWire.GitDiffResult.self
        )
        #expect(result.total == 351)
    }

    /// `git.status` and `git.diff` as they answer of a repository of a binary file alone: its
    /// counts are null, one or both, and nothing says "+0" for them.
    @Test func aFileGitGaveNoCountForHasNone() throws {
        let diff = try decode(
            #"{"root":"/w","total":2,"files":[{"path":"pic.png","status":"modified","added":null,"removed":null,"diff":"Binary files a/pic.png and b/pic.png differ\n"},{"path":"big.log","status":"untracked","added":null,"removed":0,"diff":"","cut":true}]}"#,
            as: BridgeWire.GitDiffResult.self
        ).turnDiff
        #expect(diff.files.map(\.uncounted) == [true, true])
        #expect(!diff.hasCounts)

        let state = try decode(
            #"{"repo":true,"git":true,"root":"/w","branch":"main","commit":"abc","upstream":null,"ahead":0,"behind":0,"files":[{"path":"pic.png","status":"modified","staged":false,"added":null,"removed":null}],"total":1,"added":0,"removed":0}"#,
            as: BridgeWire.GitStatusResult.self
        ).state
        guard case let .status(status) = state else { throw ThreadPanelError.unavailable }
        #expect(!status.hasCounts)
    }

    @Test func paramsStayInsideTheContract() throws {
        let subset = try Fixtures.json("contract-subset.json")
        func keys(_ method: String) throws -> Set<String> {
            let entry = try #require(subset["bridge"]?["methods"]?[method])
            return Set(try #require(entry["params"]?.arrayValue).compactMap(\.stringValue))
        }
        func sent(_ params: some Encodable) throws -> Set<String> {
            Set(try #require(try JSONValue(encoding: params).objectValue).keys)
        }
        #expect(try sent(BridgeWire.ThreadParams(sessionID: "s1")) == keys(BridgeWire.Method.gitStatus))
        #expect(try sent(BridgeWire.ThreadParams(sessionID: "s1")) == keys(BridgeWire.Method.usageRead))
        #expect(try sent(BridgeWire.ThreadParams(sessionID: "s1")) == keys(BridgeWire.Method.gitDiff))
        #expect(try sent(BridgeWire.FolderOpenParams(sessionID: "s1", app: "finder")) == keys(BridgeWire.Method.folderOpen))
        #expect(try sent(BridgeWire.NoParams()) == keys(BridgeWire.Method.hostApps))
    }

    @Test func paceSaysTheReserveAndWhenItRunsOut() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let week: TimeInterval = 7 * 86400
        // Half the week gone, 30% used: 20 points in reserve, and it lasts.
        let calm = UsageLimits.Window(name: "weekly", percent: 30, resetsAt: now.addingTimeInterval(week / 2), length: week)
        let calmPace = try #require(calm.pace(at: now))
        #expect(abs(calmPace.reserve - 20) < 0.001)
        #expect(calmPace.runsOutAt == nil)
        #expect(abs(calmPace.expectedLeft - 50) < 0.001)
        #expect(calm.left == 70)
        // A quarter of the week gone, 50% used: 25 over, empty in another quarter week.
        let hot = UsageLimits.Window(name: "weekly", percent: 50, resetsAt: now.addingTimeInterval(week * 0.75), length: week)
        let hotPace = try #require(hot.pace(at: now))
        #expect(abs(hotPace.reserve + 25) < 0.001)
        #expect(hotPace.runsOutAt.map { abs($0.timeIntervalSince(now) - week / 4) < 1 } == true)
        // Too early to say, no length, or used up: no pace.
        #expect(UsageLimits.Window(name: "w", percent: 1, resetsAt: now.addingTimeInterval(week * 0.995), length: week).pace(at: now) == nil)
        #expect(UsageLimits.Window(name: "w", percent: 10, resetsAt: now.addingTimeInterval(3600)).pace(at: now) == nil)
        #expect(UsageLimits.Window(name: "w", percent: 100, resetsAt: now.addingTimeInterval(3600), reached: true, length: week).pace(at: now) == nil)
    }

    /// What the panel keeps from one launch to the next comes back as it was.
    /// A window kept from an earlier answer says when (`limits[].heard_at`), the rest being new.
    @Test func usageReadsAWindowsOwnTimeHeard() throws {
        let result = try decode(
            #"{"available":true,"limits":[{"name":"5-hour","percent":42},{"name":"weekly Fable","percent":0,"heard_at":1800000000000}]}"#,
            as: BridgeWire.UsageReadResult.self
        )
        let usage = try #require(result.usage)
        #expect(usage.heardAt == nil)
        #expect(usage.windows[0].heardAt == nil)
        #expect(usage.windows[1].heardAt == Date(timeIntervalSince1970: 1_800_000_000))
    }

    @Test func usageAndAppsSurviveBeingSaved() throws {
        let limits = UsageLimits(
            title: "Claude Ultra",
            windows: [.init(name: "weekly", percent: 67, resetsAt: Date(timeIntervalSince1970: 1_793_671_200), length: 604_800)]
        )
        #expect(try JSONDecoder().decode(UsageLimits.self, from: JSONEncoder().encode(limits)) == limits)
        let app = HostApp(id: "vscode", name: "VS Code", kind: .editor, icon: Data([1, 2, 3]))
        #expect(try JSONDecoder().decode(HostApp.self, from: JSONEncoder().encode(app)) == app)
    }
}
