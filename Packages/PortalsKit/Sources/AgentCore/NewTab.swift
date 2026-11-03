import Foundation

/// Where a new tab starts, from the tab bar's + or ⌘T: at once, as a browser's new tab
/// does, with the agent of the tab on screen and in the folder it works in (General when
/// it works in none); with nothing on screen, with the host's default agent in the first
/// folder its space lists. The agent and the folder are changed after, on the new
/// thread's own screen (2026-10-24: "try to find a better system for creating new
/// tabs ... The current system is a bit unintuitive").
public struct NewTabStart: Hashable, Sendable {
    public var agent: Agent.ID
    /// The folder it works in: nil for the host's General folder, or for no folder (an
    /// agent that is not asked for one).
    public var folder: Folder?

    public init(agent: Agent.ID, folder: Folder? = nil) {
        self.agent = agent
        self.folder = folder
    }

    /// Like the thread on screen (`shown`, its agent and its folder), or with nothing on
    /// screen, with `agent` in `firstFolder`. nil with neither.
    public static func like(
        shown: (agent: Agent.ID, folder: Folder?)?, otherwise agent: Agent.ID?, firstFolder: SidebarProject? = nil
    ) -> NewTabStart? {
        if let shown { return NewTabStart(agent: shown.agent, folder: shown.folder) }
        guard let agent else { return nil }
        return NewTabStart(agent: agent, folder: firstFolder.map(Folder.init(project:)))
    }

    /// The new thread on screen taken to another Mac, chosen with the Mac chip under its
    /// question (`NewThreadPickers`; 2026-10-24, of a new tab while the sidebar
    /// shows another Mac's space: "tabs mac but add a dropdown to pic device"): with that
    /// Mac's agent of the same name (the name its host knows it by, or else the one shown),
    /// else with its default agent; in the same folder where that Mac's space lists its
    /// path, else in its General folder, as is a new thread in General here. nil for a Mac
    /// with no agent.
    ///
    /// - Parameters:
    ///   - agent: the new thread's agent now.
    ///   - folder: the folder it is in now: nil, or a General folder, for General.
    ///   - agents: the other Mac's agents, in its sidebar's order.
    ///   - defaultAgent: the other Mac's default agent; its first when nil.
    ///   - folders: the folders the other Mac's space lists.
    public static func moved(
        _ agent: Agent, in folder: Folder?, toAgents agents: [Agent], defaultAgent: Agent.ID?, folders: [SidebarProject]
    ) -> NewTabStart? {
        let same = agents.first { $0.id.name == agent.id.name } ?? agents.first { $0.displayName == agent.displayName }
        guard let chosen = same?.id ?? defaultAgent ?? agents.first?.id else { return nil }
        let listed = folder.flatMap { folder in
            folder.isGeneral ? nil : folders.first { !$0.isGeneral && $0.id.path == folder.path }
        }
        return NewTabStart(agent: chosen, folder: listed.map(Folder.init(project:)))
    }
}

extension Folder {
    /// A folder the sidebar lists, for a new thread to start in.
    public init(project: SidebarProject) {
        self.init(path: project.id.path, name: project.name, isGeneral: project.isGeneral)
    }

    /// The folder `record` works in, for a new thread to start there too: the project it
    /// is listed under (a worktree's repository), nil for one with no folder or in the
    /// host's General folder (`general`), where a new thread starts anyway.
    public static func workedIn(by record: ThreadRecord, general: String?) -> Folder? {
        guard let project = SidebarProject.ID(of: record), project.path != general else { return nil }
        return Folder(path: project.path)
    }
}
