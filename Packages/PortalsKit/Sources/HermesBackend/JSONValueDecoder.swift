import Foundation

// Reading a typed answer fast. A thread's history comes as one frame (2.3 MB for 120 long
// turns), and its typed answer was read by writing the frame's `JSONValue` out as JSON
// again and decoding that once more: 38 ms on a Mac, about as long as parsing the frame
// (OpenBenchmarksWire). The answer is read from the value as it is instead, its
// `JSONValue` parts taken over whole: under a millisecond.

/// Reads a `Decodable` value straight from a `JSONValue`, as `JSONDecoder` with its
/// default strategies would from the same JSON: a `Date` from its seconds since 2001, `Data`
/// from base64 text, a `URL` from its text, whole numbers into integer types only when they
/// fit, with the same errors. A `JSONValue` inside is taken whole (`JSONValue.init(from:)`).
/// What `JSONDecoder` reads from a number's text rather than its value (a `Decimal`, a
/// `Float`, a whole number past 2^53) is read from that text, as before (`fromText`).
struct JSONValueDecoder: Decoder {
    let value: JSONValue
    var codingPath: [any CodingKey] = []
    var userInfo: [CodingUserInfoKey: Any] { [:] }

    func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> {
        guard case let .object(members) = value else { throw mismatch([String: JSONValue].self, value, codingPath) }
        return KeyedDecodingContainer(Keyed(members: members, codingPath: codingPath))
    }

    func unkeyedContainer() throws -> any UnkeyedDecodingContainer {
        guard case let .array(items) = value else { throw mismatch([JSONValue].self, value, codingPath) }
        return Unkeyed(items: items, codingPath: codingPath)
    }

    func singleValueContainer() throws -> any SingleValueDecodingContainer {
        Single(value: value, codingPath: codingPath)
    }

    static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue, at path: [any CodingKey]) throws -> T {
        // The types `JSONDecoder` reads its own way, as it does with default strategies.
        if type == JSONValue.self { return value as! T }
        if type == Data.self {
            guard case let .string(text) = value else { throw mismatch(String.self, value, path) }
            guard let data = Data(base64Encoded: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: path, debugDescription: "Expected base64 text."))
            }
            return data as! T
        }
        if type == URL.self {
            guard case let .string(text) = value else { throw mismatch(String.self, value, path) }
            guard let url = URL(string: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: path, debugDescription: "Invalid URL text."))
            }
            return url as! T
        }
        // Read from the number's text by `JSONDecoder`, its own keyed form elsewhere.
        if type == Decimal.self { return try fromText(type, value, at: path) }
        return try T(from: JSONValueDecoder(value: value, codingPath: path))
    }

    /// As `decode` used to read any value: written out as JSON and read by `JSONDecoder`,
    /// with the errors placed at `path`. For the few readings that depend on a number's
    /// text and not only its value; none is on the way of a thread's history.
    static func fromText<T: Decodable>(_ type: T.Type, _ value: JSONValue, at path: [any CodingKey]) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
        } catch let error as DecodingError {
            throw placed(error, at: path)
        }
    }

    private struct Keyed<Key: CodingKey>: KeyedDecodingContainerProtocol {
        let members: [String: JSONValue]
        let codingPath: [any CodingKey]

        var allKeys: [Key] { members.keys.compactMap(Key.init(stringValue:)) }

        func contains(_ key: Key) -> Bool { members[key.stringValue] != nil }

        private func member(_ key: Key) throws -> JSONValue {
            guard let value = members[key.stringValue] else {
                throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "No value for \(key.stringValue)."))
            }
            return value
        }

        func decodeNil(forKey key: Key) throws -> Bool { try member(key) == .null }

        func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T {
            try JSONValueDecoder.decode(type, from: member(key), at: codingPath + [key])
        }

        func decode(_ type: Bool.Type, forKey key: Key) throws -> Bool { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: String.Type, forKey key: Key) throws -> String { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Double.Type, forKey key: Key) throws -> Double { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Float.Type, forKey key: Key) throws -> Float { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Int.Type, forKey key: Key) throws -> Int { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Int8.Type, forKey key: Key) throws -> Int8 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Int16.Type, forKey key: Key) throws -> Int16 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Int32.Type, forKey key: Key) throws -> Int32 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Int64.Type, forKey key: Key) throws -> Int64 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: UInt.Type, forKey key: Key) throws -> UInt { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: UInt8.Type, forKey key: Key) throws -> UInt8 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: UInt16.Type, forKey key: Key) throws -> UInt16 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: UInt32.Type, forKey key: Key) throws -> UInt32 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: UInt64.Type, forKey key: Key) throws -> UInt64 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: Int128.Type, forKey key: Key) throws -> Int128 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }
        func decode(_ type: UInt128.Type, forKey key: Key) throws -> UInt128 { try Single(value: member(key), codingPath: codingPath + [key]).decode(type) }

        func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws -> KeyedDecodingContainer<NestedKey> {
            try JSONValueDecoder(value: member(key), codingPath: codingPath + [key]).container(keyedBy: type)
        }

        func nestedUnkeyedContainer(forKey key: Key) throws -> any UnkeyedDecodingContainer {
            try JSONValueDecoder(value: member(key), codingPath: codingPath + [key]).unkeyedContainer()
        }

        func superDecoder() throws -> any Decoder {
            JSONValueDecoder(value: members["super"] ?? .null, codingPath: codingPath + [Name("super")])
        }

        func superDecoder(forKey key: Key) throws -> any Decoder {
            JSONValueDecoder(value: members[key.stringValue] ?? .null, codingPath: codingPath + [key])
        }
    }

    private struct Unkeyed: UnkeyedDecodingContainer {
        let items: [JSONValue]
        let codingPath: [any CodingKey]
        var currentIndex = 0

        init(items: [JSONValue], codingPath: [any CodingKey]) {
            self.items = items
            self.codingPath = codingPath
        }

        var count: Int? { items.count }
        var isAtEnd: Bool { currentIndex >= items.count }

        private struct Index: CodingKey {
            var intValue: Int?
            var stringValue: String { "Index \(intValue ?? 0)" }
            init(_ index: Int) { intValue = index }
            init?(stringValue: String) { nil }
            init?(intValue: Int) { self.intValue = intValue }
        }

        /// The next element, which a read that succeeds moves past: one that fails leaves it
        /// to be read another way, as with `JSONDecoder`.
        private func peek() throws -> (JSONValue, [any CodingKey]) {
            guard !isAtEnd else {
                throw DecodingError.valueNotFound(JSONValue.self, .init(codingPath: codingPath, debugDescription: "Unkeyed container is at end."))
            }
            return (items[currentIndex], codingPath + [Index(currentIndex)])
        }

        mutating func decodeNil() throws -> Bool {
            guard !isAtEnd else {
                throw DecodingError.valueNotFound(JSONValue.self, .init(codingPath: codingPath, debugDescription: "Unkeyed container is at end."))
            }
            if items[currentIndex] == .null {
                currentIndex += 1
                return true
            }
            return false
        }

        mutating func decode<T: Decodable>(_ type: T.Type) throws -> T {
            let (value, path) = try peek()
            let decoded = try JSONValueDecoder.decode(type, from: value, at: path)
            currentIndex += 1
            return decoded
        }

        // Not left to the protocol's own, which `JSONDecoder` does not leave them to either.
        mutating func decode(_ type: Int128.Type) throws -> Int128 {
            let (value, path) = try peek()
            let decoded = try Single(value: value, codingPath: path).decode(type)
            currentIndex += 1
            return decoded
        }

        mutating func decode(_ type: UInt128.Type) throws -> UInt128 {
            let (value, path) = try peek()
            let decoded = try Single(value: value, codingPath: path).decode(type)
            currentIndex += 1
            return decoded
        }

        mutating func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type) throws -> KeyedDecodingContainer<NestedKey> {
            let (value, path) = try peek()
            let container = try JSONValueDecoder(value: value, codingPath: path).container(keyedBy: type)
            currentIndex += 1
            return container
        }

        mutating func nestedUnkeyedContainer() throws -> any UnkeyedDecodingContainer {
            let (value, path) = try peek()
            let container = try JSONValueDecoder(value: value, codingPath: path).unkeyedContainer()
            currentIndex += 1
            return container
        }

        mutating func superDecoder() throws -> any Decoder {
            let (value, path) = try peek()
            currentIndex += 1
            return JSONValueDecoder(value: value, codingPath: path)
        }
    }

    private struct Single: SingleValueDecodingContainer {
        let value: JSONValue
        let codingPath: [any CodingKey]

        func decodeNil() -> Bool { value == .null }

        func decode(_ type: Bool.Type) throws -> Bool {
            guard case let .bool(flag) = value else { throw mismatch(type, value, codingPath) }
            return flag
        }

        func decode(_ type: String.Type) throws -> String {
            guard case let .string(text) = value else { throw mismatch(type, value, codingPath) }
            return text
        }

        func decode(_ type: Double.Type) throws -> Double {
            guard case let .number(number) = value else { throw mismatch(type, value, codingPath) }
            return number
        }

        func decode(_ type: Float.Type) throws -> Float {
            guard case .number = value else { throw mismatch(type, value, codingPath) }
            // Rounded from the number's text, and refused out of a Float's range.
            return try JSONValueDecoder.fromText(type, value, at: codingPath)
        }

        private func whole<T: BinaryInteger & Decodable>(_ type: T.Type) throws -> T {
            guard case let .number(number) = value else { throw mismatch(type, value, codingPath) }
            // Past 2^53 a number's text and its value part ways, and `JSONDecoder` reads the
            // text.
            guard abs(number) < 9_007_199_254_740_992 else { return try JSONValueDecoder.fromText(type, value, at: codingPath) }
            guard let whole = T(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number \(number) does not fit in \(type)."))
            }
            return whole
        }

        func decode(_ type: Int.Type) throws -> Int { try whole(type) }
        func decode(_ type: Int8.Type) throws -> Int8 { try whole(type) }
        func decode(_ type: Int16.Type) throws -> Int16 { try whole(type) }
        func decode(_ type: Int32.Type) throws -> Int32 { try whole(type) }
        func decode(_ type: Int64.Type) throws -> Int64 { try whole(type) }
        func decode(_ type: UInt.Type) throws -> UInt { try whole(type) }
        func decode(_ type: UInt8.Type) throws -> UInt8 { try whole(type) }
        func decode(_ type: UInt16.Type) throws -> UInt16 { try whole(type) }
        func decode(_ type: UInt32.Type) throws -> UInt32 { try whole(type) }
        func decode(_ type: UInt64.Type) throws -> UInt64 { try whole(type) }
        func decode(_ type: Int128.Type) throws -> Int128 { try whole(type) }
        func decode(_ type: UInt128.Type) throws -> UInt128 { try whole(type) }

        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            try JSONValueDecoder.decode(type, from: value, at: codingPath)
        }
    }
}

/// A key by name, for a coding path.
private struct Name: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ name: String) { stringValue = name }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// The error `JSONDecoder` gives for a value of another kind: null is a value not found.
private func mismatch(_ type: Any.Type, _ value: JSONValue, _ path: [any CodingKey]) -> DecodingError {
    if value == .null {
        return .valueNotFound(type, .init(codingPath: path, debugDescription: "Expected \(type), found null."))
    }
    let found = switch value {
    case .null: "null"
    case .bool: "a boolean"
    case .number: "a number"
    case .string: "text"
    case .array: "a list"
    case .object: "an object"
    }
    return .typeMismatch(type, .init(codingPath: path, debugDescription: "Expected \(type), found \(found)."))
}

/// `error`, from a value read on its own, placed at `path` in what is read.
private func placed(_ error: DecodingError, at path: [any CodingKey]) -> DecodingError {
    func moved(_ context: DecodingError.Context) -> DecodingError.Context {
        .init(codingPath: path + context.codingPath, debugDescription: context.debugDescription, underlyingError: context.underlyingError)
    }
    switch error {
    case let .typeMismatch(type, context): return .typeMismatch(type, moved(context))
    case let .valueNotFound(type, context): return .valueNotFound(type, moved(context))
    case let .keyNotFound(key, context): return .keyNotFound(key, moved(context))
    case let .dataCorrupted(context): return .dataCorrupted(moved(context))
    @unknown default: return error
    }
}
