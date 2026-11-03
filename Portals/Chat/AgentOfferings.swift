import AgentCore
import Observation

/// What an agent offers every thread: its models and personal-only command catalog.
/// Project commands are fetched separately and never stored in this shared answer.
@Observable
final class AgentOfferings {
    /// Nil until the host has said. The model chip stays hidden until then.
    var models: ModelCatalog?
    /// Empty until the host has said. The app's own commands work without.
    var commands = CommandCatalog()
}
