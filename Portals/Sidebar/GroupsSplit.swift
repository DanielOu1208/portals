import AgentCore
import SwiftUI
import UIKit

/// Needs you, Running and Recent, and the divider under them, dragged up or down to share
/// the room with the Mac's space below (2026-11-02: "can u make the sidebar split
/// resizeable? like between running and folders that split"). How they share it is
/// `SidebarSplit`: not set, the groups hug their rows; set, the divider stays where it was
/// put. A double click or double tap on it sets it back.
///
/// Its own view, so that a drag costs little: the height being dragged is this view's and
/// is read only by its small body. The groups come here made, so neither their rows nor
/// the sidebar are worked out again for it, and the spaces below are laid out but not worked
/// out again; what is kept is written only as the drag ends (docs/perf-sidebar.md).
struct GroupsSplit<Groups: View>: View {
    let split: SidebarSplit
    /// What the groups' rows and drafts need; nil with none, when they go, and the divider.
    let rows: CGFloat?
    /// How the groups' height moves as their rows come and go.
    let animation: Animation?
    /// What a step of an assistive app's adjusting moves the divider.
    let step: CGFloat
    @ViewBuilder let groups: Groups

    @AppStorage(SidebarSplit.settingKey) private var share: Double?
    /// The groups' height as a drag began, not read by the body; nil outside one.
    @State private var dragStart: CGFloat?
    /// The groups' height the drag has come to; nil outside one.
    @State private var dragged: CGFloat?
    /// Whether a drag is under way, which the system sets back however the drag ends: a
    /// drag called off (no `onEnded`) leaves the divider where it was kept.
    @GestureState private var isDragging = false
    @State private var isHovered = false
    /// When the handle was last pressed and let go without moving, not read by the body.
    @State private var lastTap: Date?

    /// The handle's hit area, centred on the line: a pointer's on a Mac, more for a finger.
    /// The Macs' tabs below come after it and stay on top where they meet; it is on top of
    /// the last row above by half of this, less the room over the line.
    private static var hitHeight: CGFloat { Platform.isMac ? 12 : 22 }
    /// How far a press moves to be a drag, and not a click or tap with a shaky hand: on
    /// touch as far as the Macs' tabs' drag (`MacTabs`), for a finger's wobble.
    private static var dragDistance: CGFloat { Platform.isMac ? 2 : 6 }
    /// How soon a second click or tap comes to be a double one.
    private static var doubleTapTime: TimeInterval { 0.5 }

    var body: some View {
        let resting = split.height(share: share, rows: rows)
        VStack(alignment: .leading, spacing: 0) {
            groups
                // Only rows coming and going move the height in this animation, as they
                // did before the divider could be dragged: not a drag's height, which goes
                // straight to the frame, nor a resized window's room, step by step.
                .frame(height: rows == nil ? 0 : dragged.map(split.clamped) ?? resting)
                .accessibilityIdentifier("sidebar-groups")
                .clipped()
                .animation(animation, value: rows)
            if rows != nil {
                handle(from: resting)
                    .transition(.opacity)
            }
        }
        .onChange(of: isDragging) { _, now in
            if !now { endDrag() }
        }
        // The rows went during a drag, and the handle with them.
        .onChange(of: rows == nil) { endDrag() }
    }

    private func handle(from resting: CGFloat) -> some View {
        Divider()
            .overlay(Color.primary.opacity(isHovered || isDragging ? 0.35 : 0.1))
            .frame(height: 1)
            .padding(.horizontal, RowMetrics.inset + RowMetrics.padding)
            .overlay {
                SplitHitArea()
                    .frame(height: Self.hitHeight)
                    .gesture(drag(from: resting))
                    .simultaneousGesture(TapGesture(count: 2).onEnded(setBack))
                    .onContinuousHover { phase in
                        switch phase {
                        case .active:
                            if !isHovered {
                                isHovered = true
                                WindowMover.setMovable(false)
                            }
                            SplitCursor.show()
                        case .ended:
                            isHovered = false
                            if !isDragging { pointerLeft() }
                        }
                    }
                    // Its hovering is not heard to end as it goes, and this view outlives it.
                    .onDisappear {
                        isHovered = false
                        pointerLeft()
                    }
                    .accessibilityElement()
                    .accessibilityLabel("Resize Running and folders")
                    .accessibilityValue(Text(split.room > 0 ? resting / split.room : 0, format: .percent.precision(.fractionLength(0))))
                    .accessibilityAdjustableAction { direction in
                        switch direction {
                        case .increment: adjust(from: resting, by: step)
                        case .decrement: adjust(from: resting, by: -step)
                        @unknown default: break
                        }
                    }
                    .accessibilityAction(named: "Set back", setBack)
                    .accessibilityIdentifier("sidebar-split")
            }
            .padding(.top, Theme.grid / 2)
    }

    /// The divider follows the pointer or the finger from where it is, up or down. Measured
    /// in the window's space, as the Macs' tabs are: the handle moves with the drag, and
    /// in its own space the pointer's way would seem shorter by however far it had moved. A
    /// mostly sideways swipe here moves nothing. This gesture tells a double click or double
    /// tap too, as the `TapGesture` beside it does not hear an iPad pointer's; and that one
    /// is there as this one does not hear the second of two quick taps.
    private func drag(from resting: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .updating($isDragging) { _, isDragging, _ in isDragging = true }
            .onChanged { value in
                if dragStart == nil {
                    let moved = value.translation
                    guard abs(moved.height) >= Self.dragDistance, abs(moved.height) >= abs(moved.width) else { return }
                    dragStart = resting
                    WindowMover.setMovable(false)
                }
                if let dragStart {
                    dragged = split.clamped(dragStart + value.translation.height)
                }
                SplitCursor.show()
            }
            .onEnded { value in
                if let dragStart {
                    if let kept = split.share(of: dragStart + value.translation.height) { share = kept }
                } else if max(abs(value.translation.width), abs(value.translation.height)) < Self.dragDistance {
                    let isSecond = lastTap.map { value.time.timeIntervalSince($0) < Self.doubleTapTime } ?? false
                    lastTap = isSecond ? nil : value.time
                    if isSecond { setBack() }
                }
                endDrag()
            }
    }

    private func endDrag() {
        dragStart = nil
        dragged = nil
        if !isHovered { pointerLeft() }
    }

    private func pointerLeft() {
        WindowMover.setMovable(true)
        SplitCursor.hide()
    }

    /// Back to hugging the rows.
    private func setBack() {
        withAnimation(.smooth(duration: 0.25)) { share = nil }
    }

    /// A step of an assistive app's: the same as a drag, kept at once.
    private func adjust(from resting: CGFloat, by distance: CGFloat) {
        guard let kept = split.share(of: resting + distance) else { return }
        withAnimation(.smooth(duration: 0.25)) { share = kept }
    }
}

#if targetEnvironment(macCatalyst)
/// The handle's hit area on a Mac, which has its cursor from `SplitCursor`.
private struct SplitHitArea: View {
    var body: some View {
        Color.clear.contentShape(.rect)
    }
}

/// AppKit's cursor for moving a divider up and down, reached by name from Catalyst, as
/// `WindowMover` reaches its window (SwiftUI's `pointerStyle` is not on Catalyst), set as
/// the pointer moves over the handle, as the system would put its own back otherwise.
/// Nothing if AppKit does not answer.
private enum SplitCursor {
    static func show() { set("rowResizeCursor") }
    static func hide() { set("arrowCursor") }

    private static func set(_ name: String) {
        guard let cursors = NSClassFromString("NSCursor") as? NSObject.Type,
              class_respondsToSelector(object_getClass(cursors), NSSelectorFromString(name)),
              let cursor = cursors.value(forKey: name) as? NSObject else { return }
        cursor.perform(NSSelectorFromString("set"))
    }
}
#else
/// The handle's hit area on an iPhone and iPad, where it is a view of UIKit's: an iPad's
/// pointer takes arrows up and down over it (`UIPointerInteraction`).
private struct SplitHitArea: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.addInteraction(UIPointerInteraction(delegate: context.coordinator))
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIPointerInteractionDelegate {
        func pointerInteraction(_ interaction: UIPointerInteraction, styleFor region: UIPointerRegion) -> UIPointerStyle? {
            let style = UIPointerStyle.system()
            style.accessories = [.arrow(.top), .arrow(.bottom)]
            return style
        }
    }
}

/// An iPhone and iPad have no such cursor (`SplitHitArea`).
private enum SplitCursor {
    static func show() {}
    static func hide() {}
}
#endif
