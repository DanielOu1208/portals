import Foundation

/// Any JSON value.
///
/// Hermes event payloads are open-ended (the contract marks them
/// `additionalProperties: true`), so the wire layer keeps them as values and the
/// typed views in `HermesWire` read only the fields they need.
public enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

// MARK: Reading

extension JSONValue {
    /// The member `key` of an object; nil for anything else.
    public subscript(key: String) -> JSONValue? {
        if case let .object(members) = self { members[key] } else { nil }
    }

    public var stringValue: String? {
        if case let .string(value) = self { value } else { nil }
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { value } else { nil }
    }

    public var doubleValue: Double? {
        if case let .number(value) = self { value } else { nil }
    }

    /// A whole number, or nil when the value is not a number or has a fraction.
    public var intValue: Int? {
        guard case let .number(value) = self, value.rounded() == value, abs(value) < 9.0e15 else { return nil }
        return Int(value)
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(value) = self { value } else { nil }
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(value) = self { value } else { nil }
    }

    public var isNull: Bool { self == .null }
}

// MARK: Codable

extension JSONValue: Codable {
    /// A value is of one kind only, so the order the kinds are tried in changes nothing
    /// but the time: each kind tried in vain costs an error made and dropped, and a frame
    /// with every thread holds tens of thousands of values. Text is tried first, being
    /// most of what a frame holds, and an object before a list.
    public init(from decoder: any Decoder) throws {
        // Read from a value already (`JSONValueDecoder`): that value, whole.
        if let direct = decoder as? JSONValueDecoder {
            self = direct.value
            return
        }
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            // Whole numbers go out as integers: Hermes validates `int` params strictly.
            if let whole = Int64(exactly: value) {
                try container.encode(whole)
            } else {
                try container.encode(value)
            }
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

// MARK: Text and typed conversion

extension JSONValue {
    /// Parses one JSON document.
    public static func parse(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    /// The value as compact JSON text with sorted keys.
    public func serialized() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(self), as: UTF8.self)
    }

    /// The JSON an `Encodable` value produces.
    public init(encoding value: some Encodable) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    /// Decodes a typed view of this value, as `JSONDecoder` would from its JSON
    /// (`JSONValueDecoder`).
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONValueDecoder.decode(type, from: self, at: [])
    }
}

// MARK: Literals

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
}
