import Foundation

/// A tool's cumulative output and current progress. Missing fields leave earlier values alone.
public struct ToolProgress: Hashable, Sendable {
    public var id: String
    public var output: String?
    public var progress: String?
    public var outputTruncated: Bool?

    public init(id: String, output: String? = nil, progress: String? = nil, outputTruncated: Bool? = nil) {
        self.id = id
        self.output = output
        self.progress = progress
        self.outputTruncated = outputTruncated
    }
}

/// Display metadata, never a permission grant.
public struct ToolExecution: Codable, Hashable, Sendable {
    public var summary: String?
    public var riskLevel: String?
    public var background: Bool?
    public var timeout: Double?

    public init(summary: String? = nil, riskLevel: String? = nil, background: Bool? = nil, timeout: Double? = nil) {
        self.summary = summary
        self.riskLevel = riskLevel
        self.background = background
        self.timeout = timeout
    }
}
