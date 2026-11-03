import AgentCore
import SwiftUI
import UniformTypeIdentifiers

extension View {
    /// The Mac's own folder dialog, for choosing where a new thread works on a host that
    /// is on this Mac (`HostModel.choosesFoldersOnThisMac`). The folder chosen is added
    /// on the host, which makes it a project in the sidebar, and `onPick` gets it as the
    /// host lists it; one the host does not take, or the dialog could not hand over, is
    /// said in an alert. Only the folder's path is used: the host's agents work there,
    /// not the app.
    ///
    /// A folder in a git worktree is never a project of its own: the host adds its
    /// repository's folder in its place (a bridge's `worktrees`), which an alert says, and
    /// `onPick` then gets the worktree's folder, where the new thread works, listed under
    /// the repository's project.
    func folderDialog(isPresented: Binding<Bool>, on host: HostModel?, onPick: @escaping (Folder) -> Void) -> some View {
        modifier(FolderDialog(isPresented: isPresented, host: host, onPick: onPick))
    }
}

struct FolderDialog: ViewModifier {
    @Binding var isPresented: Bool
    let host: HostModel?
    var onPick: (Folder) -> Void

    /// Why the host did not take the folder chosen.
    @State private var problem: String?
    /// A folder chosen in a git worktree, whose repository's folder the host added.
    @State private var worktree: Folder?

    func body(content: Content) -> some View {
        content
            .fileImporter(isPresented: $isPresented, allowedContentTypes: [.folder]) { result in
                guard let host else { return }
                switch result {
                case let .success(url):
                    Task {
                        do {
                            let added = try await host.addFolder(at: url.path(percentEncoded: false))
                            if added.worktree != nil {
                                worktree = added
                            } else {
                                onPick(added)
                            }
                        } catch {
                            problem = error.localizedDescription
                        }
                    }
                case let .failure(error):
                    problem = error.localizedDescription
                }
            }
            .alert(
                "That folder can't be used",
                isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }),
                presenting: problem
            ) { _ in
                Button("OK", role: .cancel) {}
            } message: { problem in
                Text(problem)
            }
            .alert(
                worktree.map { "\($0.name) is the project" } ?? "",
                isPresented: Binding(get: { worktree != nil }, set: { if !$0 { worktree = nil } }),
                presenting: worktree
            ) { added in
                Button("OK") {
                    if let path = added.worktree { onPick(Folder(path: path)) }
                }
            } message: { added in
                Text(Self.worktreeMessage(added))
            }
    }

    /// What the alert says of a folder chosen in a git worktree.
    static func worktreeMessage(_ added: Folder) -> String {
        let chosen = added.worktree.map { Folder(path: $0).name } ?? added.name
        return "\(chosen) is a git worktree of \(added.name), so \(added.name) was added to Projects. "
            + "The new thread works in \(chosen), and is listed under \(added.name) with its branch."
    }
}
