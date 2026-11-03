import Foundation
@testable import HermesBackend

/// Files under `Tests/HermesBackendTests/Fixtures`.
enum Fixtures {
    struct Missing: Error {
        var name: String
    }

    static func url(_ name: String) throws -> URL {
        guard let directory = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
            throw Missing(name: name)
        }
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { throw Missing(name: name) }
        return url
    }

    static func json(_ name: String) throws -> JSONValue {
        try JSONValue.parse(String(contentsOf: try url(name), encoding: .utf8))
    }

    /// The frames of a capture made with `portals-probe --capture`, in one direction
    /// (`"in"` from the gateway, `"out"` from the client).
    static func frames(_ name: String, direction: String) throws -> [JSONValue] {
        try String(contentsOf: try url(name), encoding: .utf8)
            .split(separator: "\n")
            .map { try JSONValue.parse(String($0)) }
            .filter { $0["dir"]?.stringValue == direction }
            .compactMap { $0["frame"] }
    }
}
