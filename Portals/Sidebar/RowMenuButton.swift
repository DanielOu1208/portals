import AgentCore
import SwiftUI

#if targetEnvironment(macCatalyst)
import UIKit

/// The button a list's thread rows share on a Mac (`RowHoverView` puts it over the row a
/// hit lands on): a click opens the thread, a secondary click opens the row's menu, made as
/// it opens (a pull-down menu, as SwiftUI's menu button had, so macOS puts no "Ask Siri"
/// field at its top as it does in a context menu), and the pointer resting on the arrow of
/// a thread an agent started shows who did. Never the keyboard's focus, as the row was not;
/// the row, not the button, is what assistive apps reach.
final class RowMenuUIButton: UIButton, UIToolTipInteractionDelegate {
    var tip: (text: String, rect: CGRect)? {
        didSet {
            guard (tip == nil) != (toolTips == nil) else { return }
            if tip == nil {
                toolTips.map(removeInteraction)
                toolTips = nil
            } else {
                let interaction = UIToolTipInteraction()
                interaction.delegate = self
                addInteraction(interaction)
                toolTips = interaction
            }
        }
    }

    private var toolTips: UIToolTipInteraction?
    /// Its menu is on screen: the button stays over its row until it goes.
    private(set) var showsMenu = false

    override var canBecomeFocused: Bool { false }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration,
        animator: (any UIContextMenuInteractionAnimating)?
    ) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        showsMenu = true
        RowProbe.write("menu shown")
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
        animator: (any UIContextMenuInteractionAnimating)?
    ) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        showsMenu = false
        RowProbe.write("menu ended")
    }

    func toolTipInteraction(_ interaction: UIToolTipInteraction, configurationAt point: CGPoint) -> UIToolTipConfiguration? {
        guard let tip, tip.rect.contains(point) else { return nil }
        return UIToolTipConfiguration(toolTip: tip.text, in: tip.rect)
    }
}

/// A thread row's menu on a Mac, as UIKit's items: the same as `ThreadRow.menu` (iPhone
/// and iPad, and what SwiftUI made of it on a Mac before), in the same order and sections.
enum ThreadRowMenu {
    @MainActor
    static func items(
        for record: ThreadRecord, kind: AgentSidebar.ThreadRowKind, closing: String?, isTab: Bool, isBot: Bool,
        offersRemoval: Bool, fleet: Fleet, onRename: @escaping (ThreadRecord) -> Void
    ) -> [UIMenuElement] {
        var sections: [UIMenuElement] = []
        // Show in Its Folder not for one in no folder, under the thread that started it:
        // Take Over Thread, below, puts it in one.
        let showsFolder = kind == .apart && !fleet.isTucked(record)
        if isTab || showsFolder || closing != nil {
            var first: [UIMenuElement] = []
            // A row under Finished or Recent: what its × does (Dismiss), as the row's menu on an iPhone
            // or iPad offers it first.
            if let closing {
                first.append(action(closing, "xmark") { fleet.closeOrDismiss(record) })
            }
            if isTab {
                first.append(action("Close Tab", "xmark") { fleet.closeTab(record.key) })
            }
            if showsFolder {
                first.append(action(isBot ? "Show in Sidebar" : "Show in Its Folder", isBot ? "sidebar.leading" : "folder") {
                    fleet.revealedThread = record.key
                })
            }
            sections.append(UIMenu(options: .displayInline, children: first))
        }
        // Made in order, item by item as `ThreadRow.menu` is, so that an item offered only
        // at times keeps its place among the others whichever of them are offered.
        var second = [
            action(record.isPinned ? "Unpin" : "Pin", record.isPinned ? "pin.slash" : "pin") { fleet.setPinned(!record.isPinned, for: record) }
        ]
        // An agent's one ongoing conversation keeps the agent's name.
        if !record.ref.isOngoing {
            second.append(action("Rename…", "pencil") { onRename(record) })
        }
        if fleet.offersFork(record) {
            second.append(action("Fork thread", "arrow.triangle.branch", attributes: fleet.canFork(record) ? [] : .disabled) {
                fleet.fork(record)
            })
        }
        second.append(action(record.isArchived ? "Unarchive" : "Archive", record.isArchived ? "tray.and.arrow.up" : "archivebox") {
            fleet.setArchived(!record.isArchived, for: record)
        })
        if fleet.nestsUnderItsStarter(record) {
            second.append(action(record.isShared ? TakeOver.undoInMenu : TakeOver.nameInMenu, TakeOver.symbol) {
                fleet.setShared(!record.isShared, for: record)
            })
        }
        sections.append(UIMenu(title: ThreadRow.menuHeading(of: record) ?? "", options: .displayInline, children: second))
        if offersRemoval {
            sections.append(UIMenu(options: .displayInline, children: [
                action("Remove from Portals", "trash", attributes: .destructive) { fleet.delete(record) }
            ]))
        }
        return sections
    }

    private static func action(_ title: String, _ symbol: String, attributes: UIMenuElement.Attributes = [], _ handler: @escaping () -> Void) -> UIAction {
        UIAction(title: title, image: UIImage(systemName: symbol), identifier: UIAction.Identifier(title), attributes: attributes) { _ in handler() }
    }
}
#endif
