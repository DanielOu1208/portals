import Testing
@testable import AgentCore

/// Models that go by the host's names for them (`ModelCatalog.namesByModel`), as an
/// Portals bridge offers Claude Code's: `default` named after the model it runs and
/// marked as the agent's own, `opus`, which runs the same model, named but not listed.
@Suite struct ModelNameTests {
    private let claude = ModelCatalog(
        providers: [ModelProvider(id: "anthropic", name: "Claude", models: ["default", "fable", "sonnet", "claude-opus-4-6", "claude-new"])],
        agentDefault: ModelSetting(model: "default", provider: "anthropic", level: .high),
        levelsByModel: ["default": [.low, .medium, .high, .extraHigh, .max], "opus": [.low, .medium, .high, .extraHigh, .max], "claude-opus-4-6": [.low, .medium, .high, .max]],
        namesByModel: ["default": "Opus 5.5", "opus": "Opus 5.5", "fable": "Fable 5.1", "sonnet": "Sonnet 5.5", "claude-opus-4-6": "Opus 4.6"]
    )

    /// Hermes's kind of list: ids only.
    private let hermes = ModelCatalog(
        providers: [ModelProvider(id: "openrouter", name: "OpenRouter", models: ["anthropic/claude-fable-5.1", "z-ai/glm-5.3"])],
        agentDefault: ModelSetting(model: "anthropic/claude-fable-5.1", provider: "openrouter", level: .high)
    )

    @Test func modelsGoByTheHostsNamesElseByTheirIds() {
        #expect(claude.name(of: "default") == "Opus 5.5")
        #expect(claude.name(of: "claude-opus-4-6") == "Opus 4.6")
        #expect(claude.name(of: "claude-new") == "claude-new")
        // A thread that never picked a model is on the agent's, under the name of what it runs.
        #expect(claude.shortName(of: claude.setting(for: nil)) == "Opus 5.5")
        #expect(claude.shortName(of: ModelSetting(model: "sonnet", provider: "anthropic")) == "Sonnet 5.5")
        #expect(claude.shortName(of: ModelSetting(model: "vendor/claude-new")) == "claude-new")

        #expect(hermes.name(of: "z-ai/glm-5.3") == "z-ai/glm-5.3")
        #expect(hermes.shortName(of: hermes.agentDefault) == "claude-fable-5.1")
    }

    @Test func theAgentsOwnModelIsMarkedOnlyWhereTheHostNamesIt() {
        #expect(claude.marksAsDefault("default", at: "anthropic"))
        #expect(!claude.marksAsDefault("fable", at: "anthropic"))
        #expect(!claude.marksAsDefault("default", at: "elsewhere"))
        // Hermes's list stays as it was.
        #expect(!hermes.marksAsDefault("anthropic/claude-fable-5.1", at: "openrouter"))
    }

    @Test func aThreadIsCheckedOnTheRowItRunsOn() {
        let rows = { (setting: ModelSetting) in
            claude.providers[0].models.filter { claude.isCurrent($0, at: "anthropic", for: setting) }
        }
        #expect(rows(claude.setting(for: nil)) == ["default"])
        #expect(rows(ModelSetting(model: "sonnet", provider: "anthropic")) == ["sonnet"])
        // A thread put on `opus` before the list left it out: its row is the default's, of
        // the same name, and its levels are still its own.
        let opus = claude.setting(for: ModelSetting(model: "opus", provider: "anthropic", level: .max))
        #expect(rows(opus) == ["default"])
        #expect(claude.shortName(of: opus) == "Opus 5.5")
        #expect(claude.levels(for: opus.model) == [.low, .medium, .high, .extraHigh, .max])
        // One the host neither lists nor names is on no row.
        #expect(rows(ModelSetting(model: "claude-gone", provider: "anthropic")).isEmpty)
        #expect(hermes.isCurrent("z-ai/glm-5.3", at: "openrouter", for: ModelSetting(model: "z-ai/glm-5.3")))
        #expect(!hermes.isCurrent("z-ai/glm-5.3", at: "openrouter", for: hermes.agentDefault))
    }

    @Test func aModelIsFoundByItsNameToo() {
        #expect(claude.providers(matching: "opus 5.5", current: nil).flatMap(\.models) == ["default"])
        #expect(claude.providers(matching: "4.6", current: nil).flatMap(\.models) == ["claude-opus-4-6"])
        #expect(claude.providers(matching: "sonnet", current: nil).flatMap(\.models) == ["sonnet"])

        #expect(claude.model(named: "Fable 5.1", preferring: nil)?.model == "fable")
        #expect(claude.model(named: " opus 5.5 ", preferring: nil)?.model == "default")
        #expect(claude.model(named: "sonnet", preferring: nil)?.model == "sonnet")
        // Named but not listed: the listed model of its name, the default.
        #expect(claude.model(named: "opus", preferring: nil)?.model == "default")
        #expect(claude.model(named: "default", preferring: nil)?.model == "default")
        // Neither listed nor named.
        #expect(claude.model(named: "gone", preferring: nil) == nil)
        #expect(hermes.model(named: "glm-5.3", preferring: nil)?.model == "z-ai/glm-5.3")
    }
}
