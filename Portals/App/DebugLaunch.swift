import AgentCore
import Foundation
import SwiftUI
import os
import Wash

/// Development switches read from the launch environment. From the command line:
///
///     SIMCTL_CHILD_PORTALS_FAKE=markdown SIMCTL_CHILD_PORTALS_DEBUG_PROMPT="Show me" \
///         xcrun simctl launch booted com.danielou.portals
///
/// They are read only by a debug build running in the simulator, or on a Mac, where
/// the environment is the launching shell's:
///
///     PORTALS_FAKE=markdown Portals.app/Contents/MacOS/Portals
///
/// Everywhere else every switch is off, a debug build on a phone included: a Mac the
/// phone is paired with can launch an app there with an environment of its choosing,
/// and some of these send messages and answer approvals.
enum DebugLaunch {
    /// The one place the environment is read. Each switch below is declared once and
    /// is off when this returns nil. A switch is also read under the name it had before
    /// the app was Portals (`AERIPORTAL_` for `PORTALS_`), so older scripts still work;
    /// the new name wins when both are set.
    private nonisolated static func value(_ name: String) -> String? {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        let given = environment[name] ?? (name.hasPrefix("PORTALS_") ? environment["AERIPORTAL_" + name.dropFirst("PORTALS_".count)] : nil)
        guard let value = given?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
        #else
        return nil
        #endif
    }

    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    /// The launch environment, read once: nothing in the app changes it, and
    /// `ProcessInfo.environment` builds a new dictionary of every variable each time it
    /// is asked, which the switches read in `ChatScreen`'s body and the like at every
    /// update (2% of the main thread while tabs are switched, 1.8% of the app's samples
    /// while a reply streams, docs/perf-n18.md).
    private nonisolated static let environment = ProcessInfo.processInfo.environment
    #endif

    /// Whether any development switch is set (`PORTALS_DEBUG_…`, `PORTALS_FAKE…`): the
    /// app then opens with a new thread, as it did before it kept tabs, and not with the
    /// tab left on screen (`Fleet.reopenLastTab`), so a script's message goes to the
    /// thread the script means, never into one of the user's.
    static var opensWithNewThread: Bool {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        guard !restoresTabs else { return false }
        let prefixes = ["PORTALS_DEBUG_", "PORTALS_FAKE", "AERIPORTAL_DEBUG_", "AERIPORTAL_FAKE"]
        return environment.contains { name, value in
            prefixes.contains { name.hasPrefix($0) } && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        #else
        return false
        #endif
    }

    /// `PORTALS_HERMES_URL`: the Hermes backend to use. Defaults to a local `hermes serve`.
    static var hermesURL: URL {
        value("PORTALS_HERMES_URL").flatMap(URL.init(string:)) ?? URL(string: "http://127.0.0.1:9119")!
    }

    /// `PORTALS_DEBUG_RELAYED`: how a message another agent sent through Portals looks
    /// (`RelayedLook`: `outline`, the default, `veiled`, `quote` or `before`), to compare.
    static var relayedLook: String? { value("PORTALS_DEBUG_RELAYED") }

    /// `PORTALS_DEBUG_STATUS_HOLD`: how many seconds a tool call stays on the status line
    /// at least (`StatusHold`), to try others; 0 holds nothing, as before.
    static var statusHold: TimeInterval? { value("PORTALS_DEBUG_STATUS_HOLD").flatMap(TimeInterval.init) }
    /// `PORTALS_DEBUG_STATUS_LINE=before`: the status line with its spinner and no sheen,
    /// as before, to compare.
    static var statusLineBefore: Bool { value("PORTALS_DEBUG_STATUS_LINE") == "before" }
    /// `PORTALS_DEBUG_STATUS_HEADLINE=before`: "Thinking…" on the status line as before, not
    /// what the agent says it is working on (`StatusHeadline`), and the thought's titles kept
    /// in the window under the line, to compare.
    static var statusHeadlineBefore: Bool { value("PORTALS_DEBUG_STATUS_HEADLINE") == "before" }
    /// `PORTALS_DEBUG_PLAN_SECTION=before`: the running turn's to-do list in its status line,
    /// opened with the line's steps, as before, not in a part of its own under it
    /// (`TodoPlanSection`), to compare.
    static var planSectionBefore: Bool { value("PORTALS_DEBUG_PLAN_SECTION") == "before" }

    /// `PORTALS_DEBUG_RELAY_URL`: the Portals relay to use instead of the one this build
    /// names (`PortalsRelayURL`), such as one run on this Mac with `wrangler dev`
    /// (relay/README.md): for the tunnel to a Mac of the net, and the device's registration.
    nonisolated static var relayURL: URL? { value("PORTALS_DEBUG_RELAY_URL").flatMap(URL.init(string:)) }

    /// `PORTALS_HERMES_USER` and `PORTALS_HERMES_PASSWORD`: sign in to that backend with
    /// these, for a `hermes serve` that requires it.
    static var hermesUser: String? { value("PORTALS_HERMES_USER") }
    static var hermesPassword: String? { value("PORTALS_HERMES_PASSWORD") }

    /// Whether the launch environment says which host to use, instead of the saved one.
    static var overridesHost: Bool {
        fakeScript != nil || value("PORTALS_HERMES_URL") != nil || hermesUser != nil
    }

    /// `PORTALS_DEBUG_HOSTS`: several hosts to use instead of the saved ones, for this
    /// launch only, with their passwords kept in memory. A JSON list:
    ///
    ///     [{"name":"This Mac","url":"http://127.0.0.1:9119"},
    ///      {"name":"MacBook","url":"http://127.0.0.1:9120","user":"tester","password":"…"}]
    ///
    /// Each can give an `id`; otherwise the first is `local`, the host the switches
    /// above use, and the others `debug-2`, `debug-3` and so on. Ahead of the switches
    /// above, except `PORTALS_FAKE`. `[]` starts with none, as a new install does on a
    /// device, for the welcome (a simulator otherwise adds This Mac).
    static var hosts: [(host: HostConfig, password: String?)]? {
        struct Entry: Decodable {
            var id: String?
            var name: String
            var url: String
            var user: String?
            var password: String?
        }
        guard let text = value("PORTALS_DEBUG_HOSTS"),
              let entries = try? JSONDecoder().decode([Entry].self, from: Data(text.utf8)) else { return nil }
        if entries.isEmpty { return [] }
        let hosts = entries.enumerated().compactMap { index, entry -> (host: HostConfig, password: String?)? in
            guard let url = HostConfig.url(fromTyped: entry.url) else { return nil }
            let id = entry.id ?? (index == 0 ? HostDirectory.localID.rawValue : "debug-\(index + 1)")
            let user = entry.user?.isEmpty == false ? entry.user : nil
            return (HostConfig(id: HostID(rawValue: id), name: entry.name, url: url, username: user), entry.password)
        }
        return hosts.isEmpty ? nil : hosts
    }

    /// `PORTALS_DEBUG_HOST_SETTINGS`: open the first host's settings once the app has
    /// started. The value `test` also tries the connection there; `list` opens Settings
    /// at Net instead.
    static var opensHostSettings: Bool { value("PORTALS_DEBUG_HOST_SETTINGS") != nil && !opensHostList && !scansForHost && !addsDevice && !showsDevices }
    static var testsHostSettings: Bool { value("PORTALS_DEBUG_HOST_SETTINGS") == "test" }
    static var opensHostList: Bool { value("PORTALS_DEBUG_HOST_SETTINGS") == "list" }
    /// `PORTALS_DEBUG_HOST_SETTINGS=device`: open Settings at Net with Add a device over
    /// it, once a Mac of the net is connected to make the code.
    static var addsDevice: Bool { value("PORTALS_DEBUG_HOST_SETTINGS") == "device" }
    /// `PORTALS_DEBUG_HOST_SETTINGS=devices`: open Settings at Net, scrolled to Devices,
    /// the net's members.
    static var showsDevices: Bool { value("PORTALS_DEBUG_HOST_SETTINGS") == "devices" }
    /// `PORTALS_DEBUG_HOST_SETTINGS=scan`: open the sheet for adding a Mac with the
    /// camera, as Scan the code on the welcome screen does.
    static var scansForHost: Bool { value("PORTALS_DEBUG_HOST_SETTINGS") == "scan" }

    /// Opens Settings at a part: `net`, `chat`, `agents`, `usage`, `notifications`,
    /// `appearance` or `about` (`SettingsSection`).
    static var settingsSection: SettingsSection? { value("PORTALS_DEBUG_SETTINGS").flatMap(SettingsSection.init(rawValue:)) }

    /// `PORTALS_DEBUG_AGENT_PROGRAM`: the id of a program whose page opens from Settings'
    /// Agents, on the first host that lists it (`claude`, `hermes`), for a look at it.
    static var opensAgentProgram: String? { value("PORTALS_DEBUG_AGENT_PROGRAM") }

    /// The part Settings opens at for a development switch: `settingsSection`, or Net for
    /// the switches that look at the hosts and the net (`PORTALS_DEBUG_HOST_SETTINGS`
    /// `list`, `device`, `devices`; `PORTALS_DEBUG_NET_REMOVE`, `PORTALS_DEBUG_RENAME_DEVICE`);
    /// nil leaves it shut.
    static var settingsOpensAt: SettingsSection? {
        settingsSection ?? (opensHostList || addsDevice || showsDevices || removesFromNet != nil || renamesDevice != nil ? .net : nil)
    }

    /// Draws Settings' net picture with made-up hosts instead of the fleet's
    /// (`NetPictureDemo`), for a look at how it lays them out: `demo`, `one`, `many` or a
    /// number of hosts.
    static var netPicture: String? { value("PORTALS_DEBUG_NET_PICTURE") }

    /// `PORTALS_DEBUG_OPEN_LINK`: a `portals://` link to open as the app starts, as one
    /// opened from the Camera would be, without the system asking first.
    static var openLink: String? { value("PORTALS_DEBUG_OPEN_LINK") }

    /// `PORTALS_DEBUG_FROM_CODE`: press the one button of a sheet filled in from a code (Add
    /// this Mac, Join, Switch) a moment after it comes up, as a tap would.
    static var pressesFromCode: Bool { value("PORTALS_DEBUG_FROM_CODE") != nil }

    /// `PORTALS_DEBUG_RENAME_HOST`: in the settings `PORTALS_DEBUG_HOST_SETTINGS` opens, type
    /// this name and press Save a moment after the sheet comes up, as a tap would.
    static var renamesHost: String? { value("PORTALS_DEBUG_RENAME_HOST") }

    /// `PORTALS_DEBUG_NET_REMOVE`: with the list of hosts open, ask to take the member of
    /// the net with this name out, show the confirmation for a moment, and confirm it.
    static var removesFromNet: String? { value("PORTALS_DEBUG_NET_REMOVE") }

    /// `PORTALS_DEBUG_RENAME_DEVICE`: with the list of hosts open, once a Mac of the net that
    /// renames portals is connected, ask to rename this device, type this name, show it a
    /// moment, and rename it.
    static var renamesDevice: String? { value("PORTALS_DEBUG_RENAME_DEVICE") }

    /// `PORTALS_DEBUG_FIRST_RUN`: start as on a new phone, with no Mac added; what is
    /// added is kept in memory and a scratch folder, for this launch only.
    static var startsFirstRun: Bool { value("PORTALS_DEBUG_FIRST_RUN") != nil }

    /// `PORTALS_FAKE`: talk to a scripted backend instead of a host. The value names the
    /// script: `greeting`, `markdown`, `math`, `failure`, `thinking`, `tools`, `approval`,
    /// `clarify`, `wakeup`, `delegation`, `workflow`, `commands` or `namedModels` (the greeting, with
    /// models as a bridge offers Claude Code's).
    static var fakeScript: FakeBackend.Script? {
        value("PORTALS_FAKE").flatMap(FakeBackend.Script.init(rawValue:))
    }

    /// `PORTALS_FAKE_USAGE`: how the scripted backend's hosts tell Settings, Usage of their
    /// usage, a list of `scanning` (a first read of history 42% through), `old` (a host
    /// from before usage was kept) and `locked` (anonymous totals kept off by the host's
    /// environment), separated by `,`; each for every host, or with `@` and a host's id
    /// for that one alone (`old@debug-3`). Unset, every host has its usage read.
    static func fakeUsage(for host: HostID) -> FakeBackend.UsageSample {
        var sample = FakeBackend.UsageSample()
        for item in (value("PORTALS_FAKE_USAGE") ?? "").split(separator: ",") {
            let parts = item.split(separator: "@", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 1 || parts[1] == host.rawValue else { continue }
            switch parts[0] {
            case "scanning": sample.scanning = 0.42
            case "old": sample.keepsNone = true
            case "locked": sample.totalsLocked = true
            default: break
            }
        }
        return sample
    }

    /// `PORTALS_DEBUG_USAGE`: how Settings, Usage opens, for a look at a part of it without
    /// scrolling: a list separated by `,` of a range (`day`, `week`, `month`, `quarter`),
    /// `spread` for the chart over an average day, and a part to scroll to (`chart`,
    /// `cost`, `limits`, `lists`, `sharing`).
    static var usageView: Set<String> {
        Set((value("PORTALS_DEBUG_USAGE") ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    }

    /// `PORTALS_FAKE_PACE`: the scripted backend's pause between pieces, in
    /// milliseconds (25 otherwise): larger to have time to act on a turn while it runs.
    static var fakePace: Duration {
        value("PORTALS_FAKE_PACE").flatMap(Int.init).map { .milliseconds($0) } ?? .milliseconds(25)
    }

    /// `PORTALS_DEV_MODEL` (and optionally `PORTALS_DEV_PROVIDER`): run new threads on this
    /// model, whatever the agent is configured with.
    static var modelOverride: ModelOverride? {
        value("PORTALS_DEV_MODEL").map { ModelOverride(model: $0, provider: value("PORTALS_DEV_PROVIDER")) }
    }

    /// `PORTALS_DEV_CWD`: the working directory for new threads that were not given a
    /// folder (every Hermes thread; a coding agent's opened without the folder sheet).
    /// A bridge takes only General or a folder it lists.
    static var workingDirectory: String? { value("PORTALS_DEV_CWD") }

    /// `PORTALS_DEBUG_FOLDERS`: open the folder sheet for the agent with this name, as
    /// tapping its New thread would, once its host has listed its agents.
    static var folderSheetAgent: String? { value("PORTALS_DEBUG_FOLDERS") }

    /// `PORTALS_DEBUG_FOLDER_SEARCH`: the folder sheet opens with this typed in its search
    /// field, on a host that searches its folders (`~/cod/por`, `portals`).
    static var folderSearch: String? { value("PORTALS_DEBUG_FOLDER_SEARCH") }

    /// `PORTALS_DEBUG_SIDEBAR_SEARCH`: the sidebar opens with this typed in its search field,
    /// its results in place of the groups and the spaces, to check them without typing.
    static var sidebarSearch: String? { value("PORTALS_DEBUG_SIDEBAR_SEARCH") }

    /// `PORTALS_DEBUG_DESK`: open the list of sessions from the desk for the agent with
    /// this name, as From this Mac in its menu would, once its host has said it
    /// lists them.
    static var deskSheetAgent: String? { value("PORTALS_DEBUG_DESK") }

    /// `PORTALS_DEBUG_FOLDER`: with `PORTALS_DEBUG_AGENT` naming a coding agent, its
    /// new thread starts in the folder of this name ("No project", "aerirc"), or this path,
    /// from the ones its host lists; `PORTALS_DEBUG_PROMPT` is then sent there.
    static var folderName: String? { value("PORTALS_DEBUG_FOLDER") }

    /// `PORTALS_DEBUG_PROMPT`: send this message as soon as the app is connected.
    static var prompt: String? { value("PORTALS_DEBUG_PROMPT") }

    /// `PORTALS_DEBUG_IMAGE`: image files to send with `PORTALS_DEBUG_PROMPT`, separated
    /// by `|`, or on their own when there is no prompt. The simulator can read the Mac's
    /// files.
    static var imagePaths: [String] {
        value("PORTALS_DEBUG_IMAGE")?.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? []
    }

    /// `PORTALS_DEBUG_FILE`: files of any kind to send with `PORTALS_DEBUG_PROMPT`,
    /// separated by `|`, to a host that takes files.
    static var filePaths: [String] {
        value("PORTALS_DEBUG_FILE")?.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? []
    }

    /// `PORTALS_DEBUG_WHILE_BUSY`: messages sent one after another, separated by `|`, a
    /// moment after `PORTALS_DEBUG_PROMPT`, while its turn runs: steered or queued as
    /// the setting says (`-whenBusy queue` on the command line sets it for one launch).
    static var whileBusy: [String] {
        value("PORTALS_DEBUG_WHILE_BUSY")?.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? []
    }

    /// Whether a message is sent as soon as the app is connected: a prompt, images, files, or any of them.
    static var sendsMessage: Bool { prompt != nil || !imagePaths.isEmpty || !filePaths.isEmpty }

    /// `PORTALS_DEBUG_PUSH`: skip the permission question and take notifications
    /// quietly (provisional), so the simulator can be sent test notifications.
    static var allowsPushQuietly: Bool { value("PORTALS_DEBUG_PUSH") != nil }

    /// `PORTALS_DEBUG_TAB_STATES`: what the first tabs show, by their key, whatever their
    /// threads do: "working", "waiting", "unseen" or "idle", comma-separated
    /// (`TabStatus.forced`).
    static var tabStates: [String] {
        value("PORTALS_DEBUG_TAB_STATES")?.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } ?? []
    }

    /// `PORTALS_DEBUG_DRAFT`: text in the composer at launch, not sent ("/st" shows the
    /// command menu).
    static var draft: String? { value("PORTALS_DEBUG_DRAFT") }
    /// `PORTALS_DEBUG_FOCUS`: start typing in the composer at launch, so the keyboard is
    /// up (the simulator's software keyboard: I/O > Keyboard > Connect Hardware Keyboard off).
    static var focusesComposer: Bool { value("PORTALS_DEBUG_FOCUS") != nil }

    /// `PORTALS_DEBUG_CONTEXT`: show the context ring's numbers as soon as the ring is there.
    static var showsContextNumbers: Bool { value("PORTALS_DEBUG_CONTEXT") != nil }

    /// `PORTALS_DEBUG_MODE_PICKER`: open the mode chip's popover once the chip is shown.
    static var opensModePicker: Bool { value("PORTALS_DEBUG_MODE_PICKER") != nil }

    /// `PORTALS_DEBUG_MODEL_PICKER`: open the model picker once it can be shown.
    static var opensModelPicker: Bool { value("PORTALS_DEBUG_MODEL_PICKER") != nil && !holdsModelSlider }
    /// `PORTALS_DEBUG_MODEL_PICKER=drag`: once the picker is opened (`PORTALS_DEBUG_THEN=/model`),
    /// show it as it is while the slider is held on a level that has not been chosen yet.
    static var holdsModelSlider: Bool { value("PORTALS_DEBUG_MODEL_PICKER") == "drag" }

    /// `PORTALS_DEBUG_MODEL_SWITCH`: `provider|model|level`, picked once the first turn
    /// is over, or for the new thread when there is no `PORTALS_DEBUG_PROMPT` or
    /// `PORTALS_DEBUG_IMAGE`.
    /// `PORTALS_DEBUG_THEN`: a message sent after that.
    static var modelSwitch: (provider: String, model: String, level: ThinkingLevel?)? {
        guard let parts = value("PORTALS_DEBUG_MODEL_SWITCH")?.split(separator: "|").map(String.init), parts.count >= 2 else { return nil }
        return (parts[0], parts[1], parts.count > 2 ? ThinkingLevel(rawValue: parts[2]) : nil)
    }

    static var thenPrompt: String? { value("PORTALS_DEBUG_THEN") }

    /// `PORTALS_DEBUG_FOLLOW_UP`: a second message, sent as soon as the agent asks for
    /// an approval or a question after `PORTALS_DEBUG_PROMPT`.
    static var followUp: String? { value("PORTALS_DEBUG_FOLLOW_UP") }

    /// `PORTALS_DEBUG_DRAFT_IMAGE`: an image file to put in the composer, unsent.
    static var draftImagePath: String? { value("PORTALS_DEBUG_DRAFT_IMAGE") }

    /// `PORTALS_DEBUG_AGENT`: the agent to talk to, by its name on whichever host lists
    /// it first; the first host's default otherwise.
    static var agentName: String? { value("PORTALS_DEBUG_AGENT") }

    /// `PORTALS_DEBUG_ANSWER`: answer every request after a moment. `once`, `session`,
    /// `always` or `deny` answers an approval; any other text answers each question.
    /// `approvals:` before a choice answers approvals alone, leaving questions on screen.
    static var autoAnswer: ((PendingRequest) -> RequestAnswer?)? {
        guard let given = value("PORTALS_DEBUG_ANSWER") else { return nil }
        let approvalsOnly = given.hasPrefix("approvals:")
        let text = approvalsOnly ? String(given.dropFirst("approvals:".count)) : given
        return { request in
            switch request.kind {
            case .approval:
                ApprovalChoice(rawValue: text).map(RequestAnswer.approval)
            case let .clarify(questions):
                approvalsOnly ? nil : .clarify(Dictionary(uniqueKeysWithValues: questions.map { ($0.id, text) }))
            }
        }
    }

    /// `PORTALS_DEBUG_DEMO`: open the demo (`Demo`) as the app starts, the only way in, where
    /// there is no host (`PORTALS_DEBUG_HOSTS='[]'`).
    static var opensDemo: Bool { value("PORTALS_DEBUG_DEMO") != nil }

    /// `PORTALS_DEBUG_NOTE`: an approval card opens with its field for what to do
    /// instead, where the host takes one.
    static var writesApprovalNote: Bool { value("PORTALS_DEBUG_NOTE") != nil }

    /// `PORTALS_DEBUG_APPROVAL_OPTIONS`: an approval card with more options opens them as
    /// it comes, for screenshots: `list` on their list, an option's id on that option.
    static var approvalOptions: String? { value("PORTALS_DEBUG_APPROVAL_OPTIONS") }

    /// `PORTALS_DEBUG_ORB`: the state of the orb that stands in for a visual being
    /// planned or drawn (`ThinkingOrb.State`: working, searching, solving, listening,
    /// connecting, weaving, composing, breathing, shaping), instead of the app's own.
    static var orbState: ThinkingOrb.State? { value("PORTALS_DEBUG_ORB").flatMap(ThinkingOrb.State.init(rawValue:)) }

    /// `PORTALS_DEBUG_VISUALS=drawn`: keep every visual's page in the window while its
    /// row is, as before pages were taken out of it away from the screen: to measure what
    /// that costs.
    nonisolated static var keepsVisualsDrawn: Bool { value("PORTALS_DEBUG_VISUALS") == "drawn" }

    /// `PORTALS_DEBUG_VISUALS_KEPT=<seconds>`: how long a left chat's visuals' pages are
    /// kept (`WidgetsLeft`, two minutes), shorter to watch them let go of.
    static var visualsKeptAfterLeaving: TimeInterval? { value("PORTALS_DEBUG_VISUALS_KEPT").flatMap(TimeInterval.init) }

    /// `PORTALS_DEBUG_EXPAND_VISUAL=<seconds>`: the first visual shown opens expanded that
    /// long after it appears: to look at the expanded view (a Mac's panel) in a copy whose
    /// window, in the background, takes no click.
    static var expandsFirstVisualAfter: TimeInterval? { value("PORTALS_DEBUG_EXPAND_VISUAL").flatMap(TimeInterval.init) }

    /// `PORTALS_DEBUG_OPEN_FILE`: open this file of the thread's in the file viewer once
    /// the host can read it: a path, `path:line`, or `image:path` for an image a reply
    /// shows (from anywhere on the Mac).
    static var openFile: FileLocation? {
        guard let text = value("PORTALS_DEBUG_OPEN_FILE"), !text.isEmpty else { return nil }
        if text.hasPrefix("image:") { return FileLocation(path: String(text.dropFirst("image:".count)), purpose: .image) }
        let (path, line) = FileLocation.splitLine(text)
        return FileLocation(path: path, line: line)
    }

    /// `PORTALS_DEBUG_EXPAND`: show tool rows, reasoning and folded steps opened; `plan`,
    /// only the running turn's to-do list under its status line (`TodoPlanSection`).
    static var expandsWork: Bool { value("PORTALS_DEBUG_EXPAND").map { $0 != "plan" } ?? false }
    static var expandsPlan: Bool { value("PORTALS_DEBUG_EXPAND") == "plan" }

    /// `PORTALS_DEBUG_FOOT_LINE=before`: the foot of a chat as the two lines it was before
    /// they were one (2026-10-26), the subagents line with the started threads'
    /// under it (`ChatFoot`).
    static var footLineBefore: Bool { value("PORTALS_DEBUG_FOOT_LINE") == "before" }

    /// `PORTALS_DEBUG_PANEL=1`: the panel over the chat open as the app starts (`ThreadPanel`).
    static var opensPanel: Bool { value("PORTALS_DEBUG_PANEL") == "1" }

    /// `PORTALS_DEBUG_FILE_UNDO=1`: open the latest eligible turn's actual file preview.
    /// It never restores files.
    static var opensFileUndo: Bool { value("PORTALS_DEBUG_FILE_UNDO") == "1" }

    /// `PORTALS_DEBUG_MESSAGE_FORK=edit|fork`: stage an edit in the composer or open a
    /// fork of the first eligible completed message after the debug thread appears.
    /// Fork creates a thread but neither action sends a model prompt.
    static var opensMessageFork: Bool? {
        switch value("PORTALS_DEBUG_MESSAGE_FORK") {
        case "edit": true
        case "fork": false
        default: nil
        }
    }

    /// `PORTALS_DEBUG_TURN_DIFF`: `<files>` or `<files>:file`. Open what a turn changed
    /// (`TurnDiffPanel`) for the first turn on screen that changed that many files, once;
    /// with `:file`, on its first file's diff. For screenshots.
    static var opensTurnDiff: (files: Int, onFile: Bool)? {
        guard let parts = value("PORTALS_DEBUG_TURN_DIFF")?.split(separator: ":"), let files = parts.first.flatMap({ Int($0) }) else { return nil }
        return (files, parts.dropFirst().first == "file")
    }

    /// `PORTALS_DEBUG_SUBAGENT`: open the detail of the first subagent on the line whose
    /// messages can be read, once; `messages`, on its messages. For screenshots.
    enum SubagentOpening { case detail, messages }
    static var opensSubagent: SubagentOpening? {
        value("PORTALS_DEBUG_SUBAGENT").map { $0 == "messages" ? .messages : .detail }
    }

    /// `PORTALS_DEBUG_OPEN_LATEST`: open the most recent saved thread, of any host, once
    /// connected. With `PORTALS_DEBUG_PROMPT`, the prompt is sent into that thread.
    static var opensLatestThread: Bool { value("PORTALS_DEBUG_OPEN_LATEST") != nil }

    /// `PORTALS_DEBUG_OPEN_EACH`: `<n>` or `<n>:<seconds>`. Open the `n` most recent
    /// threads one after another, `seconds` apart (1.5 by default), once the list has them,
    /// then the most recent again: for measuring what opening many threads costs
    /// (scripts/app-footprint.sh). The log says "Opened each of n threads" at the end.
    static var opensEachThread: (count: Int, every: Duration)? {
        guard let parts = value("PORTALS_DEBUG_OPEN_EACH")?.split(separator: ":"),
              let count = parts.first.flatMap({ Int($0) }), count > 0 else { return nil }
        let seconds = parts.count > 1 ? Double(parts[1]) ?? 1.5 : 1.5
        return (count, .milliseconds(Int(seconds * 1000)))
    }

    /// `PORTALS_DEBUG_OPEN_PROBE`: for each thread put on screen, write how it opened to
    /// this file (`OpenProbe`), for scripts/open-bench.sh.
    static var openProbePath: String? { value("PORTALS_DEBUG_OPEN_PROBE") }

    /// `PORTALS_DEBUG_COMPOSER_PROBE`: note to this file where the composer's caret is
    /// on screen, every frame it moves (`ComposerProbe`), for ComposerUITests.
    static var composerProbePath: String? { value("PORTALS_DEBUG_COMPOSER_PROBE") }

    /// `PORTALS_DEBUG_BLANK`: note to this file each time a chat on screen sits at its end
    /// with none of its turns in view (`BlankProbe`): a thread opened blank until
    /// scrolled by hand.
    static var blankProbePath: String? { value("PORTALS_DEBUG_BLANK") }

    /// `PORTALS_DEBUG_BLANK_FIX`: with `PORTALS_DEBUG_BLANK`, what to try once a blank
    /// chat is seen (`BlankProbe.Repair`): `last`, `last-end`, `last-then-end`, `end`,
    /// `previous`, `nudge`, `nudge-now` or `layout` (docs/blank-open.md).
    static var blankRepair: String? { value("PORTALS_DEBUG_BLANK_FIX") }

    /// `PORTALS_DEBUG_BLANK_TRACE`: with `PORTALS_DEBUG_BLANK`, also note each turn the
    /// lazy stack builds or lets go of over a chat's first four seconds.
    static var blankTraces: Bool { value("PORTALS_DEBUG_BLANK_TRACE") != nil }

    /// `PORTALS_DEBUG_GAPS`: note to this file each time a turn's or a block's space
    /// (`TranscriptTurn`, `TranscriptBlock`) is in view with nothing built in it, and each
    /// time a turn is told it is near the screen or not (`GapProbe`).
    static var gapProbePath: String? { value("PORTALS_DEBUG_GAPS") }

    /// `PORTALS_DEBUG_GAPS_FIX`: leaves out a part of the fix for gaps in the chat
    /// (`RowNearness`), to compare: `before` all, `hold` the near tracker keeping a
    /// row built when told "not near" at once after "near", `reconcile` settling such a
    /// "not near" by where the row's box is once the settling time is over (as 380a5944
    /// had it), `onscreen` a row built whenever it is on the screen.
    enum GapsFix: String { case hold, reconcile, onScreen = "onscreen" }

    /// Whether `part` of the fix for gaps is left out (`PORTALS_DEBUG_GAPS_FIX`).
    static func leavesOutGapsFix(_ part: GapsFix) -> Bool {
        guard let value = gapsFixLeftOut else { return false }
        return value == "before" || value == part.rawValue
    }

    private static let gapsFixLeftOut = value("PORTALS_DEBUG_GAPS_FIX")

    /// `PORTALS_DEBUG_GAPS_TRACKERS`: with `PORTALS_DEBUG_GAPS`, also note where each
    /// near tracker's box was when the scroll view told it (a geometry reader on each).
    static var gapProbeTracesTrackers: Bool { value("PORTALS_DEBUG_GAPS_TRACKERS") != nil }

    /// `PORTALS_DEBUG_BLANK_SETTLE=before`: a thread that opens is put at its end as before
    /// 2026-10-19 (`ChatScreen.settle`), to its last turn and to the end marker in one
    /// frame, and a chat left blank is not moved (`ChatScreen.repairIfBlank`): to compare
    /// with how it opens now (docs/blank-open.md).
    static var settlesAsBefore: Bool { value("PORTALS_DEBUG_BLANK_SETTLE") == "before" }

    /// `PORTALS_DEBUG_OPEN_PLAN`: `<id>,<id>,…[:<seconds>]`. Open these threads, by their
    /// ids on the host, one after another, `seconds` apart (4 by default), once the list
    /// has them all: for scripts/open-bench.sh. The log says "Open plan done" at the end.
    static var openPlan: (threads: [String], every: Duration)? {
        guard let text = value("PORTALS_DEBUG_OPEN_PLAN") else { return nil }
        let parts = text.split(separator: ":", maxSplits: 1)
        let threads = parts[0].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let seconds = parts.count > 1 ? Double(parts[1]) ?? 4 : 4
        return threads.isEmpty ? nil : (threads, .milliseconds(Int(seconds * 1000)))
    }

    /// `PORTALS_DEBUG_NEW_TAB`: once the open plan is done, a new tab as + and ⌘T make one
    /// (`Fleet.newTab`), for screenshots: a click and a key cannot be sent headless.
    static var makesNewTab: Bool { value("PORTALS_DEBUG_NEW_TAB") != nil }

    /// `PORTALS_DEBUG_NEW_THREAD_PICKER`: open the agent chip's picker on a new thread's
    /// screen once the chip is shown (`NewThreadPickers`).
    static var opensNewThreadAgentPicker: Bool { value("PORTALS_DEBUG_NEW_THREAD_PICKER") != nil }

    /// `PORTALS_DEBUG_NEW_TAB_CHOICE`: `<agent name>:<folder name>`, with
    /// `PORTALS_DEBUG_NEW_TAB`: words are typed in the new tab, then its agent and folder
    /// are changed to these as its chips change them (`Fleet.remakeNewThread`); a folder
    /// the space does not list, `General` say, is the host's General folder.
    static var newTabChoice: (agent: String, folder: String)? {
        guard let text = value("PORTALS_DEBUG_NEW_TAB_CHOICE") else { return nil }
        let parts = text.split(separator: ":", maxSplits: 1).map(String.init)
        return parts.count == 2 ? (parts[0], parts[1]) : nil
    }

    /// `PORTALS_DEBUG_NEW_TAB_MAC`: `<Mac name>`, with `PORTALS_DEBUG_NEW_TAB`: words are
    /// typed in the new tab (unless `PORTALS_DEBUG_NEW_TAB_CHOICE` typed them), then it is
    /// taken to the Mac of that name as its Mac chip takes it (`Fleet.remakeNewThread(on:)`),
    /// after any change of agent and folder.
    static var newTabMac: String? { value("PORTALS_DEBUG_NEW_TAB_MAC") }

    /// `PORTALS_DEBUG_NEW_TAB_THEN`: with `PORTALS_DEBUG_NEW_TAB`, what is done with the
    /// new tab once made (and changed): `close` closes it as ⌘W does, `send:<words>`
    /// sends its first message, which makes it a tab.
    static var newTabThen: String? { value("PORTALS_DEBUG_NEW_TAB_THEN") }

    /// `PORTALS_DEBUG_TAB_SWITCHES`: `<n>:<seconds>`. On the tabs bench's notification,
    /// switch between the open tabs `n` times, `seconds` apart (0.7 by default), as the
    /// keys and a click do (`TabsBench`), for scripts/tabs-bench.sh.
    static var tabSwitches: (count: Int, every: Duration)? { countAndGap("PORTALS_DEBUG_TAB_SWITCHES", every: 0.7) }

    /// `PORTALS_DEBUG_SPACE_STEPS`: `<n>:<seconds>`. On the spaces bench's notification,
    /// go from one Mac's space to the next and back `n` times, `seconds` apart (1 by
    /// default; `TabsBench`), for scripts/tabs-bench.sh.
    static var spaceSteps: (count: Int, every: Duration)? { countAndGap("PORTALS_DEBUG_SPACE_STEPS", every: 1) }

    /// `PORTALS_DEBUG_RESTORE_TABS`: the tab on screen when the app was last left is put
    /// back on screen at launch, as without any switch (`Fleet.reopenLastTab`), for
    /// measuring that with the other switches on.
    static var restoresTabs: Bool { value("PORTALS_DEBUG_RESTORE_TABS") != nil }

    /// `PORTALS_DEBUG_WINDOWS_HIDDEN`: as if no window of the app's could be seen
    /// (`WindowVisibility`), which a simulator and a copy launched hidden never say, for
    /// checking what the app does then.
    static var windowsHidden: Bool { value("PORTALS_DEBUG_WINDOWS_HIDDEN") != nil }

    /// `PORTALS_DEBUG_TAB_MOTION=instant`: a tab switch moves the tab strip at once, with no
    /// slide (an experiment).
    static var tabsMoveAtOnce: Bool { value("PORTALS_DEBUG_TAB_MOTION") == "instant" }

    /// `PORTALS_DEBUG_KEPT_FREEZE=0`: the chats kept out of sight take the deck's size as the
    /// one on screen does, and move with it (`ChatDeck`), as before: for measuring.
    static var keepsChatsInPlace: Bool { value("PORTALS_DEBUG_KEPT_FREEZE") != "0" }

    /// `PORTALS_DEBUG_TAB_TEXT=morph`: a tab's title morphs between its weights over the
    /// tabs' motion as it is shown or left, as before (`TabChip`), for measuring.
    static var tabTitlesMorph: Bool { value("PORTALS_DEBUG_TAB_TEXT") == "morph" }

    /// `PORTALS_DEBUG_REVEAL=settle`: a single-turn chat that fits waits for the settling
    /// frames to be shown, as before (`ChatScreen.revealChat`), for measuring.
    static var revealsAfterSettling: Bool { value("PORTALS_DEBUG_REVEAL") == "settle" }

    /// `PORTALS_DEBUG_KEPT_CHATS=<n>`: how many chats are kept built behind the one on screen
    /// where the tabs are (`MainScreen.chatsKeptBehind`; 0 builds each anew, as before).
    static var chatsKeptBehind: Int? { value("PORTALS_DEBUG_KEPT_CHATS").flatMap { Int($0) } }

    /// `PORTALS_DEBUG_TABS_FILE`: keep the tabs in this file as well as in the settings,
    /// and read them from it at launch: a scratch copy launched in a scratch home
    /// (`CFFIXED_USER_HOME`) keeps no settings between launches, for scripts/tabs-bench.sh.
    static var tabsFile: String? { value("PORTALS_DEBUG_TABS_FILE") }

    /// `<n>` or `<n>:<seconds>` in the switch `name`.
    private static func countAndGap(_ name: String, every seconds: Double) -> (count: Int, every: Duration)? {
        guard let parts = value(name)?.split(separator: ":"), let count = parts.first.flatMap({ Int($0) }), count > 0 else { return nil }
        let gap = parts.count > 1 ? Double(parts[1]) ?? seconds : seconds
        return (count, .milliseconds(Int(gap * 1000)))
    }

    /// `PORTALS_DEBUG_LOOK_EDITOR`: open the look editor for the agent with this name.
    static var lookEditorAgent: String? { value("PORTALS_DEBUG_LOOK_EDITOR") }

    /// `PORTALS_DEBUG_SIDEBAR`: open the sidebar once the app has started.
    static var opensSidebar: Bool { value("PORTALS_DEBUG_SIDEBAR") != nil }

    /// `PORTALS_DEBUG_UPDATE_NOTICE`: open what the sidebar's "Update available" opens, as a
    /// tap would, once a host says a later version is out (`HostUpdateButton`).
    static var opensUpdateNotice: Bool { value("PORTALS_DEBUG_UPDATE_NOTICE") != nil }

    /// `PORTALS_DEBUG_MOVE`: move a row of the sidebar as its menu would, once its
    /// host has listed its agents: `folder:notes:top` the folder of that name and
    /// `host:Mini:down` the Mac of that name (once every Mac has listed its agents), `up`,
    /// `down`, to the `top` or to the `bottom` among the rows like it. A name alone (an
    /// agent's, before the agents' rows went on 2026-10-23) moves nothing.
    static var move: (name: String, isFolder: Bool, isHost: Bool, step: SidebarMove)? {
        guard var parts = value("PORTALS_DEBUG_MOVE")?.split(separator: ":").map(String.init), parts.count >= 2,
              let step = SidebarMove(rawValue: parts.removeLast()) else { return nil }
        let kind = parts.count > 1 && ["folder", "host"].contains(parts[0]) ? parts[0] : nil
        return (parts.dropFirst(kind == nil ? 0 : 1).joined(separator: ":"), kind == "folder", kind == "host", step)
    }

    /// `PORTALS_DEBUG_FRAMES`: write how smoothly the app keeps up with the display to
    /// this file, a line a second (`FrameMeter`), for scripts/mac-scroll-bench.sh.
    static var framesPath: String? { value("PORTALS_DEBUG_FRAMES") }

    /// `PORTALS_DEBUG_NO_WATCHDOG`: leave the main thread's watchdog out (`AppWatchdog`),
    /// to measure what it costs.
    static var leavesOutWatchdog: Bool { value("PORTALS_DEBUG_NO_WATCHDOG") != nil }

    /// `PORTALS_DEBUG_WATCHDOG_COST`: write what the watchdog has cost so far to this
    /// file every ten seconds: `<seconds since launch> <looks> <CPU seconds> <entries>`.
    static var watchdogCostPath: String? { value("PORTALS_DEBUG_WATCHDOG_COST") }

    /// How `PORTALS_DEBUG_BUSY` keeps the main thread busy.
    struct Busy {
        /// In one turn of the run loop (a hang), or in short turns one after another (a
        /// loop of updates).
        var hangs: Bool
        var seconds: Double
    }

    /// `PORTALS_DEBUG_BUSY`: `turns:<seconds>` keeps the main thread busy in 30 ms turns,
    /// `hang:<seconds>` in one, five seconds after launch, for seeing the watchdog write.
    static var busyMainThread: Busy? {
        guard let text = value("PORTALS_DEBUG_BUSY") else { return nil }
        let parts = text.split(separator: ":")
        guard parts.count == 2, ["turns", "hang"].contains(parts[0]), let seconds = Double(parts[1]) else { return nil }
        return Busy(hangs: parts[0] == "hang", seconds: seconds)
    }

    /// `PORTALS_DEBUG_RETURN`: write what moves on screen, and what the app does, as it
    /// leaves and comes back to the front, to this file (`ReturnProbe`), for
    /// scripts/return-bench.sh.
    static var returnProbePath: String? { value("PORTALS_DEBUG_RETURN") }

    /// `PORTALS_DEBUG_WASH`: `calm`, `working` or `listening`: every wash behaves as in
    /// that mood, whatever its screen says (listening to a made-up voice), for measuring
    /// the wash on its own (scripts/wash-bench.sh). Read once: the wash asks on every frame.
    nonisolated static let washMood: AmbientMood? = switch value("PORTALS_DEBUG_WASH") {
    case "calm": .calm
    case "working": .working
    case "listening": .listening
    default: nil
    }

    /// `PORTALS_DEBUG_WASH_LIGHT`: `before`, `lighter` or `lightest`: the light wash as
    /// pale as that instead of as chosen (`WashPalette.Lightness`), to compare them. Read
    /// once: the wash's colours are worked out again when its look changes.
    nonisolated static let washLightness: WashPalette.Lightness? = value("PORTALS_DEBUG_WASH_LIGHT").flatMap(WashPalette.Lightness.init(rawValue:))

    /// `PORTALS_DEBUG_TOP_FADE=before`: the chat's fade under the header as it was before
    /// 2026-10-23, to compare: the header's own height on a phone and an iPad, and on a Mac
    /// the window bar's, with no blur (`ChatScreen.TopFade`).
    nonisolated static let topFadeAsBefore = value("PORTALS_DEBUG_TOP_FADE") == "before"

    /// `PORTALS_DEBUG_NEW_THREAD=before`: a new thread starts as it did before 2026-10-23,
    /// to compare: a line at the top of the chat under the header's avatar, rather than
    /// the avatar, the question and the project in the middle (`NewThreadStart`).
    nonisolated static let newThreadAsBefore = value("PORTALS_DEBUG_NEW_THREAD") == "before"

    /// `PORTALS_DEBUG_NO_ANCHOR`: the chat's turns as they were before 2026-10-26, to
    /// compare: built only as they touch the screen rather than twice `WidgetSizing.nearby`
    /// ahead of it, and nothing keeping what you read in place as a turn above it changes
    /// height (`TranscriptAnchor`). Read once, as each turn asks at every layout.
    nonisolated static let keepsNoAnchor = value("PORTALS_DEBUG_NO_ANCHOR") != nil

    /// `PORTALS_DEBUG_INK_LIGHT`: `rainbow`, `pearl`, `mist` or `greys` (as of 2026-10-22):
    /// Ink's wash in light mode so instead of as chosen (`WashPalette.InkLight`), to
    /// compare them. Read once, as the wash's lightness is.
    nonisolated static let inkLight: WashPalette.InkLight? = value("PORTALS_DEBUG_INK_LIGHT").flatMap(WashPalette.InkLight.init(rawValue:))

    /// `PORTALS_DEBUG_SIDEBAR_WIDTH`: the sidebar's width beside the chat, in points,
    /// instead of `WindowLayout`'s, to try others (200 to 600).
    nonisolated static let sidebarWidth: CGFloat? = value("PORTALS_DEBUG_SIDEBAR_WIDTH").flatMap(Double.init).map { CGFloat(min(max($0, 200), 600)) }

    /// `PORTALS_DEBUG_GROUPS`: `tighter`, `looser` or `before`: Needs you, Running and
    /// Recent spaced so instead of as chosen (`GroupSpacing`, a Mac's own or a touch
    /// screen's), to compare them. Read once, as the sidebar's measures are.
    nonisolated static let groupSpacing: GroupSpacing.Variant? = value("PORTALS_DEBUG_GROUPS").flatMap(GroupSpacing.Variant.init(rawValue:))

    /// `PORTALS_DEBUG_WASH_FRAMES`: write the frames the wash draws to this file, a line a
    /// second (`WashMeter`), for scripts/wash-bench.sh.
    nonisolated static let washFramesPath: String? = value("PORTALS_DEBUG_WASH_FRAMES")

    /// `PORTALS_DEBUG_WASH_FPS`: the frames a second the wash draws while it moves,
    /// instead of 30, for measuring what more would cost.
    nonisolated static var washFramesPerSecond: Int? { value("PORTALS_DEBUG_WASH_FPS").flatMap(Int.init) }

    /// `PORTALS_DEBUG_WASH_PIXELS`: the most pixels the wash's picture has on its long
    /// side, instead of 1024 on a Mac and the full resolution elsewhere; 0 is the full
    /// resolution.
    static var washPixels: Int? { value("PORTALS_DEBUG_WASH_PIXELS").flatMap(Int.init) }

    /// `PORTALS_DEBUG_STOP_AFTER`: press Stop this many seconds after the prompt is sent.
    static var stopAfter: Duration? {
        value("PORTALS_DEBUG_STOP_AFTER").flatMap(Double.init).map { .seconds($0) }
    }

    /// `PORTALS_DEBUG_SELECTION=off`: the chat's text held (right-clicked) for the copy menu,
    /// as before it was selected where it is (`ProseSelection`).
    nonisolated static var proseSelection: String? { value("PORTALS_DEBUG_SELECTION") }

    /// `PORTALS_DEBUG_PROSE_TYPE`: with `PORTALS_DEBUG_PROSE_SELECT`, this text typed into
    /// the selected text a second after it is copied, as keys would be (`ProseSelectProbe`).
    static let proseTyped: String? = value("PORTALS_DEBUG_PROSE_TYPE")

    /// `PORTALS_DEBUG_PROSE_SELECT=<start>,<length>`: the first run of a reply's prose
    /// long enough selects that range two seconds after it shows, and copies it a second
    /// later (`ProseSelectProbe`).
    static let proseSelectRange: NSRange? = value("PORTALS_DEBUG_PROSE_SELECT").flatMap { value in
        let parts = value.split(separator: ",").compactMap { Int($0) }
        return parts.count == 2 ? NSRange(location: parts[0], length: parts[1]) : nil
    }

    /// `PORTALS_DEBUG_COPY_LOG=<file>`: what is copied from a reply's prose, written
    /// there too, for a test to read.
    static let copyLogPath: String? = value("PORTALS_DEBUG_COPY_LOG")

    /// `PORTALS_DEBUG_SELECTION_LOG=<file>`: what the chat's text has selected, written
    /// there whenever it changes, for a test to read (`ProseCopyLog.selection`).
    static let selectionLogPath: String? = value("PORTALS_DEBUG_SELECTION_LOG")

    /// `PORTALS_DEBUG_PROSE_HEIGHTS=<file>`: the heights of the showcases' prose set both
    /// ways, written there once (`ProseHeightProbe`).
    static let proseHeightsPath: String? = value("PORTALS_DEBUG_PROSE_HEIGHTS")

    /// `PORTALS_DEBUG_PROSE_CHECKS=<file>`: once, what the chat's selectable text copies
    /// and keeps selected in a few set cases, "ok" or "FAIL" a line, written there
    /// (`ProseChecks`), for a UI test to read.
    static let proseChecksPath: String? = value("PORTALS_DEBUG_PROSE_CHECKS")
}

// MARK: - What the switches do

extension Fleet {
    /// What the switches ask of the app once the hosts are reachable: open a thread,
    /// send a message, change the model, say something more.
    func runDebugScript() {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if let path = DebugLaunch.framesPath { FrameMeter.start(writingTo: path) }
        TabsBench.listen(to: self)
        if DebugLaunch.opensLatestThread, let latest = allThreads.first {
            open(latest)
        }
        if let each = DebugLaunch.opensEachThread {
            openEachThread(each.count, every: each.every)
        }
        if let plan = DebugLaunch.openPlan {
            openPlannedThreads(plan.threads, every: plan.every)
        }
        if DebugLaunch.sendsMessage {
            sendDebugPrompt(DebugLaunch.prompt ?? "")
        }
        runDebugModelSwitch()
        #endif
    }

    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    private func openEachThread(_ count: Int, every gap: Duration) {
        Task { [weak self] in
            // The host's list may come a moment after its agents.
            for _ in 0..<120 {
                guard let self else { return }
                if allThreads.count >= count { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
            guard let records = self?.allThreads.prefix(count) else { return }
            for record in records {
                self?.open(record)
                try? await Task.sleep(for: gap)
            }
            if let first = records.first { self?.open(first) }
            AppLog.chat.notice("Opened each of \(records.count) threads")
        }
    }

    private func openPlannedThreads(_ ids: [String], every gap: Duration) {
        Task { [weak self] in
            // The host's list may come a moment after its agents.
            for _ in 0..<240 {
                guard let self else { return }
                let listed = Set(allThreads.map(\.id.rawValue))
                if ids.allSatisfy(listed.contains) { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            for id in ids {
                guard let record = self?.allThreads.first(where: { $0.id.rawValue == id }) else {
                    AppLog.chat.error("Open plan: no thread \(id, privacy: .public)")
                    continue
                }
                self?.open(record)
                try? await Task.sleep(for: gap)
            }
            AppLog.chat.notice("Open plan done")
            SidebarProbe.mark("open-plan-done")
            if DebugLaunch.makesNewTab {
                try? await Task.sleep(for: .seconds(1))
                self?.newTab()
                SidebarProbe.mark("new-tab")
                // `General` for the host's General folder, the one a scratch bridge starts a
                // new thread in (it lists none of its threads' folders).
                if let choice = DebugLaunch.newTabChoice, let self, let chat = self.chat,
                   let host = self.model(of: chat), let agent = host.agents.first(where: { $0.displayName == choice.agent }) {
                    let project = self.layout.spaces.first { $0.id == host.id }?.folders.first { $0.name == choice.folder }
                    chat.composer.text = "typed before the choice"
                    try? await Task.sleep(for: .seconds(1.5))
                    self.remakeNewThread(with: agent, in: project.map(Folder.init(project:)))
                    SidebarProbe.mark("new-tab-remade")
                }
                if let mac = DebugLaunch.newTabMac, let self, let chat = self.chat,
                   let host = self.hosts.first(where: { $0.host.name == mac }) {
                    if chat.composer.text.isEmpty { chat.composer.text = "typed before the choice" }
                    try? await Task.sleep(for: .seconds(1.5))
                    self.remakeNewThread(on: host.id)
                    SidebarProbe.mark("new-tab-moved", detail: self.chat?.agent.id.host == host.id ? "on \(mac)" : "not moved")
                }
                if let then = DebugLaunch.newTabThen, let self {
                    try? await Task.sleep(for: .seconds(1.5))
                    if then == "close" {
                        self.closeShownTab()
                        SidebarProbe.mark("new-tab-closed")
                    } else if then.hasPrefix("send:") {
                        self.chat?.send(String(then.dropFirst("send:".count)))
                        SidebarProbe.mark("new-tab-sent")
                    }
                }
            }
        }
    }

    private func sendDebugPrompt(_ prompt: String) {
        let pictures = DebugLaunch.imagePaths.compactMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) }
        let files = DebugLaunch.filePaths.compactMap { path in
            (try? Data(contentsOf: URL(fileURLWithPath: path))).map { FileAttachment(data: $0, filename: (path as NSString).lastPathComponent) }
        }
        if !pictures.isEmpty {
            Task {
                var images: [ImageAttachment] = []
                for (index, data) in pictures.enumerated() {
                    if let image = await ImageAttachment.prepared(from: data, name: "debug-\(index + 1)") { images.append(image) }
                }
                chat?.send(prompt, images: images, files: files)
            }
        } else {
            chat?.send(prompt, files: files)
        }
        if !DebugLaunch.whileBusy.isEmpty {
            Task { [weak self] in
                // Once the turn is under way, the messages that are to meet it.
                for _ in 0..<120 {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let chat = self?.chat else { return }
                    guard chat.isRunning, chat.thread != nil else { continue }
                    for message in DebugLaunch.whileBusy {
                        try? await Task.sleep(for: .milliseconds(400))
                        chat.send(message)
                    }
                    return
                }
            }
        }
        if let followUp = DebugLaunch.followUp {
            Task { [weak self] in
                // Wait for the agent to ask something, then talk over the question.
                for _ in 0..<240 {
                    try? await Task.sleep(for: .milliseconds(500))
                    guard let chat = self?.chat else { return }
                    if chat.pendingRequest != nil {
                        try? await Task.sleep(for: .seconds(2))
                        chat.send(followUp)
                        return
                    }
                }
            }
        }
        guard let delay = DebugLaunch.stopAfter else { return }
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.chat?.stop()
        }
    }

    /// Changes the model the way the picker would, then says something more.
    private func runDebugModelSwitch() {
        guard DebugLaunch.modelSwitch != nil || DebugLaunch.thenPrompt != nil else { return }
        Task { [weak self] in
            // After a first prompt: once its turn is over, change the model, then say
            // something more. Without one: choose for a thread that is not there yet.
            let startsFresh = !DebugLaunch.sendsMessage
            for _ in 0..<360 {
                try? await Task.sleep(for: .milliseconds(500))
                guard let chat = self?.chat else { return }
                if startsFresh {
                    guard chat.offerings.models != nil else { continue }
                } else {
                    guard let last = chat.turns.last, !last.isRunning, chat.thread != nil else { continue }
                }
                if let pick = DebugLaunch.modelSwitch {
                    chat.pickModel(pick.model, provider: pick.provider)
                    try? await Task.sleep(for: .seconds(3))
                    if let level = pick.level { chat.pickLevel(level) }
                    try? await Task.sleep(for: .seconds(2))
                }
                if let then = DebugLaunch.thenPrompt { chat.send(then) }
                return
            }
        }
    }
    #endif
}

extension View {
    /// Does to a view, a moment after it appears, what a tap would: for looking at a
    /// state that otherwise takes a finger to reach. Nothing in a build that reads no switches.
    func onDebugLaunch(_ isOn: Bool, after delay: Duration = .zero, _ action: @escaping @MainActor () async -> Void) -> some View {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        task {
            guard isOn else { return }
            try? await Task.sleep(for: delay)
            if !Task.isCancelled { await action() }
        }
        #else
        self
        #endif
    }
}
