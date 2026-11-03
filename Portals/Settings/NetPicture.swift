import SwiftUI

/// How this device reaches its hosts, as a picture at the top of Settings' Net, in the
/// app's one colour: this device at the foot, the hosts fanned out above it, each with its
/// name and state over it, and a line from this device into each host's tile: solid when
/// it is reached directly, dashed through the relay, dashed and running while connecting,
/// faint and dotted when offline (2026-10-26: "the arrows should point in to the
/// icon", "lines dont overlap", "better to not show all the portal devices after all").
/// The lines spread from one point and so never cross, and reach each tile from below,
/// where no words are. The other portals are the list under the picture.
///
/// A dot runs along each line that carries something while the picture is on screen;
/// with Reduce Motion or Low Power Mode, or out of sight, the lines stay still. Tap a host
/// to edit it; hold one for Remove.
struct NetPicture: View {
    struct Mac: Identifiable, Equatable {
        /// How this device reaches the host.
        enum Link: Equatable {
            case direct, relay, connecting, unreachable
        }

        let id: String
        let name: String
        let symbol: String
        let link: Link
    }

    let macs: [Mac]
    /// This device's kind, as a symbol.
    let deviceSymbol: String
    var onOpenMac: (Mac.ID) -> Void
    var onRemoveMac: (Mac.ID) -> Void

    @Environment(\.accessibilityReduceMotion) private var reducesMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isOutOfSight) private var isOutOfSight
    @State private var isInView = false
    @State private var isLowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    @State private var width: CGFloat = 360

    var body: some View {
        GeometryReader { proxy in
            let place = Placement(width: proxy.size.width, macs: macs.count)
            ZStack(alignment: .topLeading) {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animates)) { timeline in
                    Canvas { context, _ in
                        draw(in: &context, place: place, time: timeline.date.timeIntervalSinceReferenceDate)
                    }
                }
                .accessibilityHidden(true)

                ForEach(Array(macs.enumerated()), id: \.element.id) { index, mac in
                    MacNode(mac: mac, showsState: place.statesHosts, onOpen: { onOpenMac(mac.id) }, onRemove: { onRemoveMac(mac.id) })
                        .scaleEffect(place.macScale)
                        .position(place.macs[index])
                }
                ThisDevice(symbol: deviceSymbol)
                    .position(place.device)
            }
        }
        .frame(height: Placement.height(forWidth: width))
        // Its words keep to sizes the picture has room for.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onAppear { isInView = true }
        .onDisappear { isInView = false }
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
            isLowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(summary)
    }

    /// Something runs along a line now: a link that carries something, or one being tried.
    private var animates: Bool {
        isInView && !isOutOfSight && !reducesMotion && !isLowPower && scenePhase == .active && !WindowVisibility.shared.isHidden
            && macs.contains { $0.link != .unreachable }
    }

    private var summary: String {
        let reached = macs.filter { $0.link == .direct || $0.link == .relay }.count
        let hosts = macs.count == 1 ? "1 host" : "\(macs.count) hosts"
        return "\(Platform.thisDeviceCapitalized) reaches \(reached) of \(hosts)."
    }

    // MARK: Drawing

    private func draw(in context: inout GraphicsContext, place: Placement, time: TimeInterval) {
        let ink = Color.primary
        for (index, mac) in macs.enumerated() {
            let route = Route(from: place.device, to: place.macs[index], scale: place.macScale)
            switch mac.link {
            case .direct:
                context.stroke(route.path, with: .color(ink.opacity(0.5)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                pulse(on: route, in: &context, time: time)
            case .relay:
                context.stroke(route.path, with: .color(ink.opacity(0.5)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [5, 4]))
                pulse(on: route, in: &context, time: time)
            case .connecting:
                let phase = CGFloat((time * 12).truncatingRemainder(dividingBy: 9))
                context.stroke(
                    route.path, with: .color(ink.opacity(0.32)),
                    style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [5, 4], dashPhase: -phase)
                )
            case .unreachable:
                context.stroke(route.path, with: .color(ink.opacity(0.2)), style: StrokeStyle(lineWidth: 1.4, lineCap: .round, dash: [1.5, 4]))
            }
        }
    }

    /// A dot running from this device to the host, fading in and out at the ends.
    private func pulse(on route: Route, in context: inout GraphicsContext, time: TimeInterval) {
        guard animates else { return }
        let along = (time / 2.2).truncatingRemainder(dividingBy: 1)
        let point = route.point(at: along)
        var dot = context
        dot.opacity = 0.7 * sin(.pi * along)
        dot.fill(Path(ellipseIn: CGRect(x: point.x - 2.4, y: point.y - 2.4, width: 4.8, height: 4.8)), with: .color(.primary))
    }

    /// A line from this device's circle to the edge of a host's tile.
    private struct Route {
        let start: CGPoint
        let end: CGPoint

        init(from device: CGPoint, to host: CGPoint, scale: CGFloat) {
            let dx = host.x - device.x, dy = host.y - device.y
            let length = max(hypot(dx, dy), 1)
            let ux = dx / length, uy = dy / length
            start = CGPoint(x: device.x + ux * Node.deviceReach, y: device.y + uy * Node.deviceReach)
            // Where the line meets the tile, a little short of it.
            let halfWidth = Node.macSize.width / 2 * scale + 4, halfHeight = Node.macSize.height / 2 * scale + 4
            let into = min(abs(ux) > 0.001 ? halfWidth / abs(ux) : .infinity, abs(uy) > 0.001 ? halfHeight / abs(uy) : .infinity)
            end = CGPoint(x: host.x - ux * into, y: host.y - uy * into)
        }

        var path: Path {
            Path { path in
                path.move(to: start)
                path.addLine(to: end)
            }
        }

        /// The point `along` the way from this device (0) to the host (1).
        func point(at along: Double) -> CGPoint {
            CGPoint(x: start.x + (end.x - start.x) * along, y: start.y + (end.y - start.y) * along)
        }
    }
}

// MARK: Where things go

/// Where each node goes in a picture `width` wide: this device at the foot, and the hosts
/// on an arc above it, evenly over a fan that widens with their number: one straight
/// above, two either side of that, more round to the sides.
private struct Placement {
    let device: CGPoint
    let macs: [CGPoint]
    /// How large the hosts are drawn: smaller when there are many on the arc.
    let macScale: CGFloat
    /// Each host's state shows over it: not with so many that the words would meet, where
    /// the list under the picture says it.
    let statesHosts: Bool

    /// The arc's radii in a picture `width` wide.
    private static func radii(forWidth width: CGFloat) -> CGSize {
        let across = max(100, min(width / 2 - 58, 230))
        return CGSize(width: across, height: min(across * 0.8, 150))
    }

    /// The picture's height: the words over the highest host, the arc, and this device
    /// with its name under it.
    static func height(forWidth width: CGFloat) -> CGFloat {
        top + radii(forWidth: width).height + bottom
    }

    /// From the picture's top to the middle of the highest host: room for its words.
    private static let top: CGFloat = 74
    /// From this device's middle to the picture's foot: its circle and its name.
    private static let bottom: CGFloat = 48

    init(width: CGFloat, macs: Int) {
        let radii = Self.radii(forWidth: width)
        let device = CGPoint(x: width / 2, y: Self.top + radii.height)
        self.device = device
        self.macs = Self.angles(count: macs).map { degrees in
            let angle = degrees * .pi / 180
            return CGPoint(x: device.x + radii.width * cos(angle), y: device.y + radii.height * sin(angle))
        }
        macScale = macs <= 4 ? 1 : macs <= 6 ? 0.85 : 0.72
        statesHosts = macs <= 6
    }

    /// Each host's place on the arc, in degrees from the right, going down (270 is straight
    /// up): evenly over a fan of 70° for two, widening by 45° a host up to 170°.
    static func angles(count: Int) -> [Double] {
        guard count > 1 else { return count == 1 ? [270] : [] }
        let fan = min(170, 70 + 45 * Double(count - 2))
        return (0..<count).map { 270 - fan / 2 + Double($0) * fan / Double(count - 1) }
    }
}

// MARK: Nodes

private enum Node {
    static let macSize = CGSize(width: 54, height: 40)
    static let deviceSize: CGFloat = 38
    /// The most a host's name takes across: a longer one is cut in its middle.
    static let labelWidth: CGFloat = 104
    /// How far from its middle a line from this device starts.
    static let deviceReach: CGFloat = 23
}

/// A host on the arc: its kind of computer on a tile, its name and its state over it.
private struct MacNode: View {
    let mac: NetPicture.Mac
    let showsState: Bool
    let onOpen: () -> Void
    let onRemove: () -> Void

    var body: some View {
        Button(action: onOpen) {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Theme.cardFill)
                .overlay {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .strokeBorder(Color(uiColor: .separator), lineWidth: 0.75)
                }
                .overlay {
                    Image(systemName: mac.symbol)
                        .font(.system(size: 19))
                        .foregroundStyle(.secondary)
                }
                .frame(width: Node.macSize.width, height: Node.macSize.height)
                .opacity(mac.link == .unreachable ? 0.45 : 1)
                // Its words over it: the line from this device comes in from below.
                .overlay(alignment: .bottom) {
                    VStack(spacing: 1) {
                        Text(mac.name)
                            .font(.app.footnote.weight(.semibold))
                        if showsState {
                            Text(state)
                                .font(.app.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(width: Node.labelWidth)
                    .fixedSize(horizontal: false, vertical: true)
                    .offset(y: -(Node.macSize.height + 5))
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Edit", systemImage: "pencil", action: onOpen)
            Button("Remove", systemImage: "trash", role: .destructive, action: onRemove)
        }
        .accessibilityLabel("\(mac.name), host, \(state)")
        .accessibilityIdentifier("net-mac-\(mac.id)")
    }

    /// How this device reaches it, in a word or two.
    private var state: String {
        switch mac.link {
        case .direct: "Direct"
        case .relay: "Via relay"
        case .connecting: "Connecting"
        case .unreachable: "Offline"
        }
    }
}

/// This device at the foot: its kind in a ringed circle, its name under it.
private struct ThisDevice: View {
    let symbol: String

    var body: some View {
        Circle()
            .fill(Theme.cardFill)
            .overlay { Circle().strokeBorder(Color.primary, lineWidth: 1.5) }
            .overlay {
                Image(systemName: symbol)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
            }
            .frame(width: Node.deviceSize, height: Node.deviceSize)
            .overlay(alignment: .top) {
                Text(Platform.thisDeviceCapitalized)
                    .font(.app.footnote.weight(.semibold))
                    .lineLimit(1)
                    .fixedSize()
                    .offset(y: Node.deviceSize + 4)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Platform.thisDeviceCapitalized)
            .accessibilityIdentifier("net-this-device")
    }
}
