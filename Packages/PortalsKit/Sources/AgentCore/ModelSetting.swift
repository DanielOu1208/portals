import Foundation

/// How hard the model thinks before it answers. The raw values are what Hermes calls
/// the levels.
public enum ThinkingLevel: String, Codable, CaseIterable, Hashable, Sendable {
    case off = "none"
    case minimal, low, medium, high
    case extraHigh = "xhigh"
    case max, ultra

    public var title: String {
        switch self {
        case .off: "Off"
        case .minimal: "Minimal"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .extraHigh: "Extra high"
        case .max: "Max"
        case .ultra: "Ultra"
        }
    }

    /// The level a typed word stands for: Hermes's name for it ("xhigh") or the one
    /// shown ("extra high").
    public init?(named name: String) {
        let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let level = Self.allCases.first(where: { $0.rawValue == wanted || $0.title.lowercased() == wanted }) else {
            return nil
        }
        self = level
    }
}

/// A provider the host is signed in to, and the models it offers.
public struct ModelProvider: Identifiable, Hashable, Sendable {
    /// The provider's short name on the host ("openrouter").
    public var id: String
    public var name: String
    public var models: [String]

    public init(id: String, name: String, models: [String]) {
        self.id = id
        self.name = name
        self.models = models
    }
}

/// What a thread runs on: a model at a provider, and how hard it thinks.
public struct ModelSetting: Codable, Hashable, Sendable {
    public var model: String
    public var provider: String?
    /// nil when the host did not say.
    public var level: ThinkingLevel?

    public init(model: String, provider: String? = nil, level: ThinkingLevel? = nil) {
        self.model = model
        self.provider = provider
        self.level = level
    }

    /// The model's name without the vendor in front ("claude-fable-5.1").
    public var shortName: String {
        model.split(separator: "/").last.map(String.init) ?? model
    }

    /// Whether this is `name` at `provider`. A setting that does not say where its
    /// model is offered matches it anywhere.
    public func isModel(_ name: String, at provider: String) -> Bool {
        model == name && (self.provider == nil || self.provider == provider)
    }
}

/// The models an agent can run on, and what it runs on when nothing is chosen.
public struct ModelCatalog: Hashable, Sendable {
    public var providers: [ModelProvider]
    /// The agent's own setting. Choosing something else for a thread never changes it.
    public var agentDefault: ModelSetting
    /// The thinking levels each model takes, weakest first, for hosts that say (a
    /// Portals bridge). nil, or a model left out, takes every level; an empty list, none.
    public var levelsByModel: [String: [ThinkingLevel]]?
    /// What to call each model, for hosts whose ids are not names (a Portals bridge's
    /// Claude Code: `default` and `opus` are both "Opus 5.5"). nil, or a model left out,
    /// goes by its id. It can name models the list leaves out, which a thread can still
    /// be on.
    public var namesByModel: [String: String]?
    /// The level each model runs at when a thread chooses none, for hosts that say (an
    /// Portals bridge's Claude Code, where it differs by model). nil, or a model left
    /// out, runs at the agent's own level.
    public var defaultLevelsByModel: [String: ThinkingLevel]?
    /// For an agent whose threads take a mode (a coding agent on a bridge): a new
    /// thread's, following the agent's settings, with what they come to when known. nil
    /// for an agent without modes.
    public var defaultMode: ModeState?

    public init(
        providers: [ModelProvider], agentDefault: ModelSetting, levelsByModel: [String: [ThinkingLevel]]? = nil,
        namesByModel: [String: String]? = nil, defaultLevelsByModel: [String: ThinkingLevel]? = nil, defaultMode: ModeState? = nil
    ) {
        self.defaultMode = defaultMode
        self.providers = providers
        self.agentDefault = agentDefault
        self.levelsByModel = levelsByModel
        self.namesByModel = namesByModel
        self.defaultLevelsByModel = defaultLevelsByModel
    }

    /// What the list calls a model: the host's name for it, else its id.
    public func name(of model: String) -> String {
        namesByModel?[model] ?? model
    }

    /// What to call the model a setting names where there is little room (the composer's
    /// chip, a line in the thread): the host's name for it, else its id without the vendor.
    public func shortName(of setting: ModelSetting) -> String {
        namesByModel?[setting.model] ?? setting.shortName
    }

    /// Whether the list marks a model as the agent's own. Only where the host names it:
    /// there the agent's own is an alias shown by the name of the model it runs (Claude
    /// Code's `default`, "Opus 5.5"), and the mark says that a thread on it follows the
    /// agent's setting. Elsewhere the list stays as the host gives it.
    public func marksAsDefault(_ model: String, at provider: String) -> Bool {
        namesByModel?[agentDefault.model] != nil && isAgentModel(ModelSetting(model: model, provider: provider))
    }

    /// Whether a row of the list is what `setting` runs on: the model itself, or, for a
    /// model the host names but does not list (Claude Code's `opus` while its default
    /// runs the same model), the listed one of the same name.
    public func isCurrent(_ model: String, at provider: String, for setting: ModelSetting) -> Bool {
        if setting.isModel(model, at: provider) { return true }
        guard let name = namesByModel?[setting.model], namesByModel?[model] == name,
              setting.provider == nil || setting.provider == provider else { return false }
        return !providers.contains { offered in
            (setting.provider == nil || offered.id == setting.provider) && offered.models.contains(setting.model)
        }
    }

    /// The thinking levels to offer for `model`, weakest first: the ones the host lists
    /// for it, none for a model it lists with none (a bridge with `model_levels_none`:
    /// Cursor's Auto), else every level.
    public func levels(for model: String) -> [ThinkingLevel] {
        guard let listed = levelsByModel?[model] else { return ThinkingLevel.allCases }
        return ThinkingLevel.allCases.filter(listed.contains)
    }

    /// Whether `model` takes a thinking level at all.
    public func takesLevels(_ model: String) -> Bool {
        !levels(for: model).isEmpty
    }

    /// The providers with the one in use first, each narrowed to the models that
    /// match `query` (every model when it is empty).
    public func providers(matching query: String, current: ModelSetting?) -> [ModelProvider] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        let narrowed = providers.compactMap { provider -> ModelProvider? in
            guard !words.isEmpty else { return provider.models.isEmpty ? nil : provider }
            let models = provider.models.filter { model in
                let haystack = "\(model) \(name(of: model)) \(provider.name)".lowercased()
                return words.allSatisfy { haystack.contains($0) }
            }
            return models.isEmpty ? nil : ModelProvider(id: provider.id, name: provider.name, models: models)
        }
        guard let slug = current?.provider, let index = narrowed.firstIndex(where: { $0.id == slug }), index > 0 else {
            return narrowed
        }
        return [narrowed[index]] + narrowed[..<index] + narrowed[(index + 1)...]
    }

    /// What a thread runs on, given what was chosen for it: the choice, with whatever
    /// it leaves out taken from the model's own level where the host says, else from the
    /// agent's own setting. No choice is the agent's own.
    public func setting(for chosen: ModelSetting?) -> ModelSetting {
        guard let chosen else {
            return ModelSetting(model: agentDefault.model, provider: agentDefault.provider, level: agentDefault.level ?? defaultLevelsByModel?[agentDefault.model])
        }
        return ModelSetting(
            model: chosen.model,
            provider: chosen.provider ?? (chosen.model == agentDefault.model ? agentDefault.provider : nil),
            level: chosen.level ?? defaultLevelsByModel?[chosen.model] ?? agentDefault.level
        )
    }

    /// Whether a setting names the agent's own model. One that does not say where the
    /// model is offered means where the agent gets it.
    public func isAgentModel(_ setting: ModelSetting) -> Bool {
        setting.model == agentDefault.model && (setting.provider ?? agentDefault.provider) == agentDefault.provider
    }

    /// The one model a typed name stands for, by its full name, its short one or the
    /// host's name for it. A model the host names but does not list (Claude Code's
    /// `opus` while its default runs the same model) stands for the listed one of its
    /// name. When several providers offer it, the one at `provider`; without that it is
    /// not clear which is meant, and the answer is nil.
    public func model(named name: String, preferring provider: String?) -> (model: String, provider: String)? {
        let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { return nil }
        var matches = listed {
            $0.lowercased() == wanted || ModelSetting(model: $0).shortName.lowercased() == wanted
                || namesByModel?[$0]?.lowercased() == wanted
        }
        if matches.isEmpty, let unlisted = namesByModel?.first(where: { $0.key.lowercased() == wanted })?.value {
            matches = listed { namesByModel?[$0] == unlisted }
        }
        return matches.count == 1 ? matches[0] : matches.first { $0.provider == provider }
    }

    /// Every listed model that passes `test`, with where it is offered.
    private func listed(where test: (String) -> Bool) -> [(model: String, provider: String)] {
        providers.flatMap { offered in offered.models.filter(test).map { (model: $0, provider: offered.id) } }
    }
}

/// How much of the model's context window a thread has filled.
public struct ContextUsage: Codable, Hashable, Sendable {
    /// Tokens in the context now.
    public var used: Int
    /// Tokens the model can hold.
    public var limit: Int
    /// The host estimated the context rather than measuring it.
    public var estimated: Bool

    public init(used: Int, limit: Int, estimated: Bool = false) {
        self.used = used
        self.limit = limit
        self.estimated = estimated
    }

    private enum CodingKeys: String, CodingKey { case used, limit, estimated }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        used = try values.decode(Int.self, forKey: .used)
        limit = try values.decode(Int.self, forKey: .limit)
        estimated = try values.decodeIfPresent(Bool.self, forKey: .estimated) ?? false
    }

    /// From 0 (empty) to 1 (full).
    public var fraction: Double {
        limit > 0 ? min(max(Double(used) / Double(limit), 0), 1) : 0
    }

    /// "48k of 400k", for a line that says it in numbers.
    public var summary: String {
        "\(Self.short(used)) of \(Self.short(limit))"
    }

    /// "950", "12k", "1.2M".
    static func short(_ tokens: Int) -> String {
        switch tokens {
        case ..<1_000: "\(tokens)"
        case ..<1_000_000: "\(Int((Double(tokens) / 1_000).rounded()))k"
        default: String(format: "%.1fM", Double(tokens) / 1_000_000).replacing(".0M", with: "M")
        }
    }
}

/// What the host did with a request to change a thread's model.
public enum ModelChange: Hashable, Sendable {
    /// Done. `note` is something the host wants said about it.
    case applied(note: String?)
    /// The host wants a yes first (an expensive model): ask, then send again confirmed.
    case needsConfirmation(String)
}

/// A backend whose threads can be moved to another model or thinking level. A change
/// applies to that thread only.
public protocol ModelSelecting: Sendable {
    func modelCatalog(for agent: Agent.ID) async throws -> ModelCatalog
    func setModel(_ model: String, provider: String?, in thread: ThreadRef.ID, confirmed: Bool) async throws -> ModelChange
    func setThinkingLevel(_ level: ThinkingLevel, in thread: ThreadRef.ID) async throws
}
