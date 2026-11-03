import Foundation

/// Who decided how an agent looks.
public enum LookOrigin: String, Codable, Hashable, Sendable {
    /// The app gave it, and can give another to tell agents apart.
    case assigned
    /// Chosen by hand. The app never changes it.
    case chosen
}

/// How an agent's avatar looks, as indices into the app's catalogues of body shapes,
/// resting faces and colours. Kept as indices so this stays free of drawing code.
public struct AgentLook: Codable, Hashable, Sendable {
    public var shape: Int
    public var face: Int
    public var tint: Int
    /// Whether a coding agent shows its maker's logo (`CodingAgentLogo`) in place of the
    /// avatar. nil is no choice, which shows the logo: an agent that has one wears it
    /// unless it was turned off by hand (`false`). Left out when nil; `true` is what
    /// looks saved before the logo was the default hold for an agent switched to it.
    /// Read it with `shows(_:)`.
    public var showsLogo: Bool?

    public init(shape: Int, face: Int, tint: Int, showsLogo: Bool? = nil) {
        self.shape = shape
        self.face = face
        self.tint = tint
        self.showsLogo = showsLogo
    }

    private enum CodingKeys: String, CodingKey {
        case shape, face, tint, showsLogo
    }

    /// Whether the agent is drawn as `logo` in place of its avatar: when it has a logo
    /// and the logo was not turned off. An agent with none (a Hermes agent) is
    /// always drawn as its avatar.
    public func shows(_ logo: CodingAgentLogo?) -> Bool {
        logo != nil && showsLogo != false
    }

    /// Reads looks saved by any version of the app. The list is decoded as a whole, so a
    /// logo setting this version cannot read counts as off instead of losing every look.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        shape = try container.decode(Int.self, forKey: .shape)
        face = try container.decode(Int.self, forKey: .face)
        tint = try container.decode(Int.self, forKey: .tint)
        showsLogo = (try? container.decodeIfPresent(Bool.self, forKey: .showsLogo)) ?? nil
    }

    /// How many of each the app's catalogues hold.
    public struct Catalogue: Hashable, Sendable {
        public var shapes: Int
        public var faces: Int
        public var tints: Int

        public init(shapes: Int, faces: Int, tints: Int) {
            self.shapes = max(shapes, 1)
            self.faces = max(faces, 1)
            self.tints = max(tints, 1)
        }
    }

    /// The look a name always gets: the same name gives the same look on every device
    /// and after every reinstall.
    public static func derived(from name: String, in catalogue: Catalogue) -> AgentLook {
        let hash = stableHash(name.lowercased())
        return AgentLook(
            shape: Int(hash % UInt64(catalogue.shapes)),
            face: Int((hash / 7) % UInt64(catalogue.faces)),
            tint: Int((hash / 61) % UInt64(catalogue.tints))
        )
    }

    /// Looks for a host's agents. Agents that already have one keep it. Each new agent
    /// starts from its derived look and, while another agent on the host has the same
    /// shape or colour, moves on to the next free one, so the agents of one host are
    /// told apart at a glance.
    public static func assign(
        to names: [String],
        keeping existing: [String: AgentLook],
        in catalogue: Catalogue
    ) -> [String: AgentLook] {
        var looks = existing.filter { names.contains($0.key) }
        // Name order, so the result does not depend on the order agents were listed in.
        for name in names.sorted() where looks[name] == nil {
            var look = derived(from: name, in: catalogue)
            let shapes = Set(looks.values.map(\.shape))
            let tints = Set(looks.values.map(\.tint))
            if shapes.count < catalogue.shapes {
                while shapes.contains(look.shape) { look.shape = (look.shape + 1) % catalogue.shapes }
            }
            if tints.count < catalogue.tints {
                while tints.contains(look.tint) { look.tint = (look.tint + 1) % catalogue.tints }
            }
            looks[name] = look
        }
        return looks
    }

    /// Looks for the agents of every host together, so that no two agents in the
    /// sidebar have both the same shape and the same colour while some pairing is still
    /// unused. `agents` is every host's, the hosts in the sidebar's order.
    ///
    /// - A look chosen by hand is never changed.
    /// - A look the app gave keeps its place unless an agent earlier in the sidebar (or
    ///   one whose look was chosen by hand) has the same shape and colour; then it gets a
    ///   new one. A look saved before origins were kept counts as the app's only when it
    ///   is exactly what the app gives that agent among its host's agents, so a chosen
    ///   one is never mistaken for it.
    /// - A new agent starts from its derived look and moves to the nearest one whose
    ///   shape and colour no other agent shares, keeping, as before, a shape and a colour
    ///   no other agent on its host has, and preferring a colour no agent anywhere has.
    ///
    /// Colours below `firstTint` are never given (the app's ink); they can be chosen.
    /// Returns a look for each of `agents`; those that differ from `saved` are the
    /// app's.
    public static func assign(
        to agents: [Agent.ID],
        keeping saved: [Agent.ID: AgentLook],
        origins: [Agent.ID: LookOrigin],
        in catalogue: Catalogue,
        firstTint: Int = 0
    ) -> [Agent.ID: AgentLook] {
        let first = min(max(firstTint, 0), catalogue.tints - 1)
        let given = Catalogue(shapes: catalogue.shapes, faces: catalogue.faces, tints: catalogue.tints - first)
        var hosts: [HostID] = []
        var names: [HostID: [String]] = [:]
        for agent in agents where names[agent.host]?.contains(agent.name) != true {
            if names[agent.host] == nil { hosts.append(agent.host) }
            names[agent.host, default: []].append(agent.name)
        }
        let ordered = hosts.flatMap { host in names[host, default: []].sorted().map { Agent.ID(host: host, name: $0) } }

        // What the app gives each agent among its host's, with no looks saved: what an
        // app that assigned looks per host gave them when it first saw them.
        var fresh: [HostID: [String: AgentLook]] = [:]
        func isFresh(_ look: AgentLook, for agent: Agent.ID) -> Bool {
            if fresh[agent.host] == nil {
                fresh[agent.host] = assign(to: names[agent.host, default: []], keeping: [:], in: given).mapValues {
                    AgentLook(shape: $0.shape, face: $0.face, tint: $0.tint + first)
                }
            }
            return fresh[agent.host]?[agent.name] == look
        }

        var looks: [Agent.ID: AgentLook] = [:]
        var taken = Set<Pairing>()
        var movable: [Agent.ID] = []
        for agent in ordered {
            guard let look = saved[agent] else { continue }
            switch origins[agent] {
            case .chosen?: break
            case .assigned?: movable.append(agent); continue
            case nil: if isFresh(look, for: agent) { movable.append(agent); continue }
            }
            looks[agent] = look
            taken.insert(Pairing(look))
        }
        for agent in movable {
            guard let look = saved[agent], !taken.contains(Pairing(look)) else { continue }
            looks[agent] = look
            taken.insert(Pairing(look))
        }

        for agent in ordered where looks[agent] == nil {
            let neighbours = looks.filter { $0.key.host == agent.host }.values
            let hostShapes = Set(neighbours.map(\.shape)), hostTints = Set(neighbours.map(\.tint))
            let usedTints = Set(looks.values.map(\.tint))
            let start = derived(from: agent.name, in: given)
            var best: (look: AgentLook, score: Int)?
            // Nearest first: colours after the derived one, and shapes after it within each.
            for tintStep in 0..<given.tints {
                for shapeStep in 0..<given.shapes {
                    let look = AgentLook(
                        shape: (start.shape + shapeStep) % given.shapes,
                        face: start.face,
                        tint: first + (start.tint + tintStep) % given.tints
                    )
                    let score = (taken.contains(Pairing(look)) ? 0 : 8) + (hostShapes.contains(look.shape) ? 0 : 4)
                        + (hostTints.contains(look.tint) ? 0 : 2) + (usedTints.contains(look.tint) ? 0 : 1)
                    if score > (best?.score ?? -1) { best = (look, score) }
                }
            }
            guard let look = best?.look else { continue }
            looks[agent] = look
            taken.insert(Pairing(look))
        }
        return looks
    }

    /// A shape and a colour: what tells two avatars apart at a glance.
    private struct Pairing: Hashable {
        var shape: Int
        var tint: Int

        init(_ look: AgentLook) {
            shape = look.shape
            tint = look.tint
        }
    }

    /// FNV-1a. Swift's own `hashValue` changes on every launch.
    static func stableHash(_ text: String) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash &*= 0x0000_0100_0000_01b3
        }
        return hash
    }
}
