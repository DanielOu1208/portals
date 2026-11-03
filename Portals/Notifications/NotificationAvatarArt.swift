import AgentCore
import os
import SwiftUI
import UIKit

/// Each agent's avatar as the picture on its notifications, saved where the app's
/// notification extension finds it (`NotificationAvatars`).
///
/// The rest pose in white on a square of the agent's colour, lighter at the top, as a
/// contact's monogram is; an agent drawn in ink gets a near-black one. The system shows
/// it in a circle, so the body sits well inside. A coding agent's picture wears its logo
/// in a badge, as its avatar does, or is the logo on a light square when its look says
/// so.
enum NotificationAvatarArt {
    /// The picture's side in points, drawn at 3x.
    static let side: CGFloat = 120

    /// The looks already saved this launch, by file name.
    private static var saved: [String: AgentAvatarStyle] = [:]

    /// Saves a picture for each agent under the names a notification may use
    /// (`NotificationAvatars.files`), and removes every other picture. So it is given
    /// every host's agents at once. A look already saved this launch is not drawn again.
    static func save(_ styles: [Agent.ID: AgentAvatarStyle]) {
        guard let avatars = NotificationAvatars.shared else { return }
        let files = FileManager.default
        let wanted = NotificationAvatars.files(for: Array(styles.keys))
        do {
            try files.createDirectory(at: avatars.directory, withIntermediateDirectories: true)
            for old in try files.contentsOfDirectory(at: avatars.directory, includingPropertiesForKeys: nil)
                where wanted[old.lastPathComponent] == nil
            {
                try? files.removeItem(at: old)
                saved[old.lastPathComponent] = nil
            }
            // An agent filed under two names is drawn once.
            var drawn: [AgentAvatarStyle: Data] = [:]
            for (name, agent) in wanted {
                guard let style = styles[agent], saved[name] != style else { continue }
                guard let picture = drawn[style] ?? picture(of: style) else { continue }
                drawn[style] = picture
                // Readable after the first unlock: notifications arrive on a locked phone.
                try picture.write(to: avatars.directory.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                saved[name] = style
            }
        } catch {
            AppLog.push.error("Could not save the agents' notification pictures: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The picture as PNG.
    static func picture(of style: AgentAvatarStyle) -> Data? {
        let renderer = ImageRenderer(content: NotificationAvatarPicture(style: style).frame(width: side, height: side))
        renderer.scale = 3
        return renderer.uiImage?.pngData()
    }
}

/// What `NotificationAvatarArt` draws.
struct NotificationAvatarPicture: View {
    var style: AgentAvatarStyle

    /// How much of the side the body's widest reach takes, so the body stays clear of the
    /// circle the system cuts the picture to.
    private static let bodyShare = 0.58
    /// The logo's badge, as a share of the side. It sits on the lower-LEFT, inside the
    /// circle: iOS puts the app's icon on the lower-right of a message's picture, which
    /// would cover it there.
    private static let badgeShare = 0.24
    private static let badgeGap = 0.025
    private static let badgeCentre = CGPoint(x: 0.5 - 0.24, y: 0.5 + 0.24)
    /// The logo in place of the avatar, as a share of the side.
    private static let logoShare = 0.5

    var body: some View {
        let frame = AgentAvatarDirector.frozen(.idle, at: Bloub.poseTimes[.idle] ?? 1, style: style)
        let colour = style.tint ?? Color(white: 0.16)
        let logo = style.logo?.image
        let showsLogo = style.showsLogo
        Canvas { context, size in
            let side = min(size.width, size.height)
            if let logo, showsLogo {
                // The logo alone, on a light frost tinted like the app's glass buttons
                // (a picture cannot hold live glass), lighter at the top.
                context.fill(
                    Path(CGRect(origin: .zero, size: size)),
                    with: .linearGradient(
                        Gradient(colors: [Color(red: 0.98, green: 0.99, blue: 1), Color(red: 0.86, green: 0.91, blue: 0.98)]),
                        startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)
                    )
                )
                let length = side * Self.logoShare
                context.draw(context.resolve(logo), in: CGRect(x: (size.width - length) / 2, y: (size.height - length) / 2,
                                                               width: length, height: length))
                return
            }
            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .linearGradient(
                    Gradient(colors: [colour.mix(with: .white, by: 0.22), colour]),
                    startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)
                )
            )
            let badge = CGRect(x: Self.badgeCentre.x * size.width - side * Self.badgeShare / 2,
                               y: Self.badgeCentre.y * size.height - side * Self.badgeShare / 2,
                               width: side * Self.badgeShare, height: side * Self.badgeShare)
            // In a layer of its own, so the eyes, which are holes, show the colour under it.
            context.drawLayer { layer in
                let reach = frame.body.map { max(abs($0.x), abs($0.y)) }.max() ?? 1
                AgentAvatarRenderer.paint(frame, in: layer, size: size, extent: reach / Self.bodyShare,
                                         ink: .color(.white), ringGap: style.ringGap)
                // The badge's gap, so it stands clear of the body.
                if logo != nil {
                    layer.blendMode = .destinationOut
                    layer.fill(Path(ellipseIn: badge.insetBy(dx: -side * Self.badgeGap, dy: -side * Self.badgeGap)), with: .color(.black))
                }
            }
            if let logo {
                context.fill(Path(ellipseIn: badge), with: .color(.white))
                let length = badge.width * AgentLogoArt.logoInBadge
                context.draw(context.resolve(logo), in: CGRect(x: badge.midX - length / 2, y: badge.midY - length / 2,
                                                               width: length, height: length))
            }
        }
        // One picture for both appearances: the logos as on a light page.
        .environment(\.colorScheme, .light)
    }
}

#Preview("Notification pictures") {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 64))]) {
        ForEach(AgentLookCatalogue.tints.indices, id: \.self) { tint in
            NotificationAvatarPicture(style: AgentLookCatalogue.style(for: AgentLook(shape: tint % 8, face: 0, tint: tint)))
                .frame(width: 60, height: 60)
                .clipShape(.circle)
        }
        ForEach(CodingAgentLogo.allCases, id: \.self) { logo in
            ForEach([false, true], id: \.self) { shows in
                NotificationAvatarPicture(style: AgentLookCatalogue.style(for: AgentLook(shape: 1, face: 0, tint: 6, showsLogo: shows), logo: logo))
                    .frame(width: 60, height: 60)
                    .clipShape(.circle)
            }
        }
    }
    .padding()
}
