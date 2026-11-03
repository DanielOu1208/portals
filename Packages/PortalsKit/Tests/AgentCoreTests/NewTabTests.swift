import Foundation
import Testing
@testable import AgentCore

/// Where a new tab starts (`NewTabStart`): with the agent and in the folder of the tab on
/// screen, as a browser's new tab; with nothing on screen, with the host's default agent
/// in the first folder of its space.
@Suite struct NewTabTests {
    private static let mac = HostID(rawValue: "mac")
    private static let claude = Agent.ID(host: mac, name: "claude")
    private static let codex = Agent.ID(host: mac, name: "codex")
    private static let general = "/Users/me/General"

    private static func record(in folder: String?, repo: String? = nil) -> ThreadRecord {
        var record = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: "t"), agent: codex, workingDirectory: folder))
        record.repo = repo
        return record
    }

    @Test func aNewTabHasTheAgentAndTheFolderOfTheTabOnScreen() {
        let portals = Folder(path: "/Users/me/Portals")
        let start = NewTabStart.like(shown: (Self.codex, portals), otherwise: Self.claude)
        #expect(start == NewTabStart(agent: Self.codex, folder: portals))
        // In General, or no folder: none is named, and the host starts it in General.
        #expect(NewTabStart.like(shown: (Self.codex, nil), otherwise: Self.claude) == NewTabStart(agent: Self.codex))
    }

    @Test func withNothingOnScreenItHasTheDefaultAgentInTheFirstFolderListed() {
        let project = SidebarProject(
            id: SidebarProject.ID(host: Self.mac, path: "/Users/me/Portals"), name: "Portals", threads: []
        )
        let start = NewTabStart.like(shown: nil, otherwise: Self.claude, firstFolder: project)
        #expect(start?.agent == Self.claude)
        #expect(start?.folder?.path == "/Users/me/Portals")
        #expect(start?.folder?.name == "Portals")
        #expect(start?.folder?.isGeneral == false)
        // A space that lists no folder: General.
        #expect(NewTabStart.like(shown: nil, otherwise: Self.claude) == NewTabStart(agent: Self.claude))
        // No agent at all: no new tab.
        #expect(NewTabStart.like(shown: nil, otherwise: nil) == nil)
    }

    // MARK: Another Mac, from the new thread's Mac chip

    private static let mini = HostID(rawValue: "mini")

    private static func project(_ path: String, on host: HostID = mini, isGeneral: Bool = false) -> SidebarProject {
        var project = SidebarProject(
            id: SidebarProject.ID(host: host, path: path), name: (path as NSString).lastPathComponent, threads: []
        )
        project.isGeneral = isGeneral
        return project
    }

    @Test func onAnotherMacItKeepsTheAgentOfTheSameNameAndTheFolderOfTheSamePath() {
        let codexHere = Agent(id: Self.codex, displayName: "Codex")
        let there = [
            Agent(id: Agent.ID(host: Self.mini, name: "claude"), displayName: "Claude Code", isDefault: true),
            Agent(id: Agent.ID(host: Self.mini, name: "codex"), displayName: "Codex"),
        ]
        let folders = [Self.project("/Users/me/Notes"), Self.project("/Users/me/Portals")]
        let start = NewTabStart.moved(
            codexHere, in: Folder(path: "/Users/me/Portals"), toAgents: there, defaultAgent: there[0].id, folders: folders
        )
        #expect(start?.agent == Agent.ID(host: Self.mini, name: "codex"))
        #expect(start?.folder?.path == "/Users/me/Portals")
        #expect(start?.folder?.name == "Portals")
        #expect(start?.folder?.isGeneral == false)
    }

    @Test func onAnotherMacAnAgentOfAnotherIdButTheSameShownNameIsKept() {
        let here = Agent(id: Agent.ID(host: Self.mac, name: "work"), displayName: "Aeri")
        let there = [
            Agent(id: Agent.ID(host: Self.mini, name: "claude"), displayName: "Claude Code", isDefault: true),
            Agent(id: Agent.ID(host: Self.mini, name: "default"), displayName: "Aeri"),
        ]
        let start = NewTabStart.moved(here, in: nil, toAgents: there, defaultAgent: there[0].id, folders: [])
        #expect(start?.agent == Agent.ID(host: Self.mini, name: "default"))
    }

    @Test func onAnotherMacWithoutTheAgentItIsTheDefaultAgentInGeneral() {
        let cursor = Agent(id: Agent.ID(host: Self.mac, name: "cursor"), displayName: "Cursor")
        let there = [
            Agent(id: Agent.ID(host: Self.mini, name: "codex"), displayName: "Codex"),
            Agent(id: Agent.ID(host: Self.mini, name: "claude"), displayName: "Claude Code", isDefault: true),
        ]
        // A folder that Mac does not list: its General folder, named by none.
        let start = NewTabStart.moved(
            cursor, in: Folder(path: "/Users/me/Portals"), toAgents: there, defaultAgent: there[1].id,
            folders: [Self.project("/Users/me/Notes")]
        )
        #expect(start == NewTabStart(agent: Agent.ID(host: Self.mini, name: "claude")))
        // No default agent said: its first.
        let first = NewTabStart.moved(cursor, in: nil, toAgents: there, defaultAgent: nil, folders: [])
        #expect(first == NewTabStart(agent: Agent.ID(host: Self.mini, name: "codex")))
        // No agent at all: it cannot go there.
        #expect(NewTabStart.moved(cursor, in: nil, toAgents: [], defaultAgent: nil, folders: []) == nil)
    }

    @Test func fromGeneralItIsGeneralThereWhateverThePaths() {
        let claude = Agent(id: Self.claude, displayName: "Claude Code")
        let there = [Agent(id: Agent.ID(host: Self.mini, name: "claude"), displayName: "Claude Code")]
        // Here's General, at a path the other Mac lists as a folder of its own: General there.
        let general = Folder(path: Self.general, name: Folder.generalName, isGeneral: true)
        let start = NewTabStart.moved(
            claude, in: general, toAgents: there, defaultAgent: nil, folders: [Self.project(Self.general)]
        )
        #expect(start == NewTabStart(agent: there[0].id))
        // A folder here at the path of the other Mac's General: its General, named by none.
        let atItsGeneral = NewTabStart.moved(
            claude, in: Folder(path: "/Users/other/General"), toAgents: there, defaultAgent: nil,
            folders: [Self.project("/Users/other/General", isGeneral: true)]
        )
        #expect(atItsGeneral == NewTabStart(agent: there[0].id))
    }

    @Test func theFolderAThreadWorksInIsItsProjectNotGeneralNorAWorktree() {
        #expect(Folder.workedIn(by: Self.record(in: "/Users/me/Portals"), general: Self.general)?.path == "/Users/me/Portals")
        // A worktree's thread: its repository's folder, which the sidebar lists it under.
        let worktree = Self.record(in: "/Users/me/portals-n10", repo: "/Users/me/Portals")
        #expect(Folder.workedIn(by: worktree, general: Self.general)?.path == "/Users/me/Portals")
        #expect(Folder.workedIn(by: Self.record(in: Self.general), general: Self.general) == nil)
        #expect(Folder.workedIn(by: Self.record(in: nil), general: Self.general) == nil)
    }
}
