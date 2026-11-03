import Foundation
import Testing
@testable import HermesBackend

/// `JSONValue.decode` reads a typed value straight from the value, where it used to write
/// the value out as JSON and decode that with `JSONDecoder`. It must read the same, and
/// fail where that failed.
@Suite struct JSONValueDecoderTests {
    /// As `decode` used to read.
    private func before<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    private struct Everything: Decodable, Equatable {
        enum Kind: String, Decodable { case one, two }
        struct Inner: Decodable, Equatable {
            var name: String
            var size: Int?
        }

        var text: String
        var flag: Bool
        var whole: Int
        var small: Int8
        var big: Int64
        var unsigned: UInt32
        var fraction: Double
        var single: Float
        var kind: Kind
        var missing: String?
        var null: Int?
        var list: [Int]
        var nested: [[String]]
        var inner: Inner
        var inners: [Inner]
        var map: [String: Double]
        var anything: JSONValue
        var anyList: [JSONValue]
        var anyMap: [String: JSONValue]?
        var when: Date
        var bytes: Data
        var link: URL
    }

    private let everything: JSONValue = [
        "text": "café 修正 🚀", "flag": true, "whole": 42, "small": -8, "big": 9_007_199_254_740_991, "unsigned": 4_000_000_000,
        "fraction": 0.30000000000000004, "single": 1.5, "kind": "two", "null": nil, "list": [1, 2, 3],
        "nested": [["a"], [], ["b", "c"]], "inner": ["name": "x"], "inners": [["name": "y", "size": 3], ["name": "z", "size": nil]],
        "map": ["a": 1, "b": -2.5], "anything": ["deep": [1, "two", nil, true, ["k": 1.25]]], "anyList": [1, "a", nil],
        "anyMap": ["x": ["y": []]], "when": 1_791_324_000.5, "bytes": "aGVsbG8=", "link": "https://example.com/a?b=c",
        "extra": "ignored",
    ]

    @Test func everyKindReadsAsBefore() throws {
        let now = try everything.decode(Everything.self)
        #expect(now == (try before(Everything.self, everything)))
        #expect(now.anything == everything["anything"])
        #expect(now.bytes == Data("hello".utf8))
    }

    /// What `JSONDecoder` refused is refused.
    @Test func whatFailedFails() {
        func fails<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> (now: Bool, before: Bool) {
            ((try? value.decode(type)) == nil, (try? before(type, value)) == nil)
        }
        let cases: [(Bool, Bool)] = [
            fails(Int.self, 1.5), fails(Int8.self, 300), fails(UInt.self, -1), fails(Int.self, "1"), fails(String.self, 1),
            fails(Bool.self, 1), fails(Double.self, "1.5"), fails(Bool.self, nil), fails([Int].self, ["a": 1]),
            fails([String: Int].self, [1, 2]), fails(Everything.Inner.self, ["size": 1]), fails(Everything.Inner.self, ["name": nil]),
            fails(Everything.Kind.self, "three"), fails(Data.self, "not base64!"), fails(Int.self, nil),
        ]
        for (index, (now, before)) in cases.enumerated() {
            #expect(now && before, "case \(index)")
        }
    }

    /// What `JSONDecoder` reads from a number's text and not its value reads as before: a
    /// `Decimal` (its own keyed form anywhere else), a `Float` rounded from the text and
    /// refused out of its range, a whole number past 2^53.
    @Test func numbersReadFromTheirTextReadAsBefore() throws {
        struct Amounts: Decodable, Equatable {
            var price: Decimal
            var prices: [Decimal]
            var maybe: Decimal?
        }
        let amounts: JSONValue = ["price": 1.5, "prices": [0.1, 2, 1e-7], "maybe": 3.25]
        #expect(try amounts.decode(Amounts.self) == before(Amounts.self, amounts))
        #expect(try JSONValue.number(1.5).decode(Decimal.self) == before(Decimal.self, .number(1.5)))

        #expect(try JSONValue.number(1.0000000596046448).decode(Float.self) == before(Float.self, .number(1.0000000596046448)))
        #expect(try JSONValue.array([.number(0.1)]).decode([Float].self) == before([Float].self, .array([.number(0.1)])))
        for outOfRange in [1e40, -1e40] {
            #expect((try? JSONValue.number(outOfRange).decode(Float.self)) == nil)
            #expect((try? before(Float.self, .number(outOfRange))) == nil)
        }
        let underflow = (now: try? JSONValue.number(1e-300).decode(Float.self), before: try? before(Float.self, .number(1e-300)))
        #expect(underflow.now == underflow.before)

        for big in [9.223372036854776e18, 1.8e19, 9_007_199_254_740_992, 1e17] {
            #expect((try? JSONValue.number(big).decode(UInt64.self)) == (try? before(UInt64.self, .number(big))), "UInt64 \(big)")
            #expect((try? JSONValue.number(big).decode(Int64.self)) == (try? before(Int64.self, .number(big))), "Int64 \(big)")
            #expect((try? JSONValue.number(-big).decode(Int.self)) == (try? before(Int.self, .number(-big))), "Int -\(big)")
        }
        for whole in [1e15, 123_456_789_012_345, -0.0, 4_294_967_295] {
            #expect(try JSONValue.number(whole).decode(Int.self) == before(Int.self, .number(whole)))
        }
    }

    /// 128-bit whole numbers read as before, wherever they are.
    @Test func wholeNumbersOf128BitsReadAsBefore() throws {
        struct Wide: Decodable, Equatable {
            var signed: Int128
            var unsigned: UInt128
            var maybe: Int128?
            var list: [UInt128]
            var map: [String: Int128]
        }
        let wide: JSONValue = ["signed": -42, "unsigned": 7, "maybe": 3, "list": [1, 2, 9_007_199_254_740_991], "map": ["a": -1]]
        #expect(try wide.decode(Wide.self) == before(Wide.self, wide))
        for number in [1.0, -1, 0, 1.5, 9_007_199_254_740_991, 9.223372036854776e18, 1e20, -1e20, 1e40] {
            #expect((try? JSONValue.number(number).decode(Int128.self)) == (try? before(Int128.self, .number(number))), "Int128 \(number)")
            #expect((try? JSONValue.number(number).decode(UInt128.self)) == (try? before(UInt128.self, .number(number))), "UInt128 \(number)")
        }
        #expect(try JSONValue.number(1).decode(Int128.self) == 1)
    }

    /// A read that fails in a list leaves its element to be read another way, as before.
    @Test func aFailedReadInAListLeavesTheElement() throws {
        struct Loose: Decodable, Equatable {
            var parts: [String]
            init(from decoder: any Decoder) throws {
                var list = try decoder.unkeyedContainer()
                parts = []
                while !list.isAtEnd {
                    if let number = try? list.decode(Int.self) {
                        parts.append("#\(number)")
                    } else if let inner = try? list.nestedContainer(keyedBy: Name.self), let name = try? inner.decode(String.self, forKey: .name) {
                        parts.append("{\(name)}")
                    } else if var nested = try? list.nestedUnkeyedContainer() {
                        parts.append("[\(nested.count ?? 0)]")
                        while !nested.isAtEnd { _ = try nested.decode(JSONValue.self) }
                    } else {
                        parts.append(try list.decode(String.self))
                    }
                }
            }

            enum Name: String, CodingKey { case name }
        }
        let value: JSONValue = ["hello", 123, ["name": "x"], [1, 2], "end"]
        let now = try value.decode(Loose.self)
        #expect(now == (try before(Loose.self, value)))
        #expect(now.parts == ["hello", "#123", "{x}", "[2]", "end"])
    }

    /// The errors are of the kinds `JSONDecoder` gives, at the same place.
    @Test func errorsAreOfTheSameKindsAtTheSamePlaces() {
        func kind<T: Decodable>(_ read: () throws -> T) -> String {
            do {
                _ = try read()
                return "read"
            } catch let DecodingError.typeMismatch(_, context) {
                return "typeMismatch " + context.codingPath.map(\.stringValue).joined(separator: ".")
            } catch let DecodingError.valueNotFound(_, context) {
                return "valueNotFound " + context.codingPath.map(\.stringValue).joined(separator: ".")
            } catch let DecodingError.keyNotFound(key, context) {
                return "keyNotFound \(key.stringValue) " + context.codingPath.map(\.stringValue).joined(separator: ".")
            } catch DecodingError.dataCorrupted {
                // Where: `JSONDecoder` gives none for a number that does not fit; this says.
                return "dataCorrupted"
            } catch {
                return "other"
            }
        }
        func same<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> Bool {
            let now = kind { try value.decode(type) }
            let then = kind { try before(type, value) }
            if now != then { Issue.record("\(type) from \(value): now \(now), before \(then)") }
            return now == then
        }
        struct Holder: Decodable {
            var count: Int
            var bytes: Data?
            var link: URL?
            var price: Decimal?
            var ratio: Float?
        }
        #expect(same(Int.self, nil))
        #expect(same(String.self, nil))
        #expect(same([Int].self, nil))
        #expect(same([String: Int].self, nil))
        #expect(same(Data.self, 1))
        #expect(same(Data.self, nil))
        #expect(same(URL.self, 1))
        #expect(same(Holder.self, ["count": nil]))
        #expect(same(Holder.self, ["count": 1, "bytes": 2]))
        #expect(same(Holder.self, ["count": 1, "link": true]))
        #expect(same(Holder.self, ["count": 1, "price": "x"]))
        #expect(same(Holder.self, ["count": 1, "ratio": 1e40]))
        #expect(same(Holder.self, ["count": 1.5]))
    }

    /// A class's `super` part is read from the "super" key, and says so in its path.
    @Test func aSuperDecoderIsAtTheSuperKey() throws {
        final class Base: Decodable {
            let path: [String]
            let size: Int
            init(from decoder: any Decoder) throws {
                path = decoder.codingPath.map(\.stringValue)
                size = try decoder.container(keyedBy: Keys.self).decode(Int.self, forKey: .size)
            }

            enum Keys: String, CodingKey { case size }
        }
        struct Derived: Decodable {
            let base: Base
            init(from decoder: any Decoder) throws {
                base = try Base(from: try decoder.container(keyedBy: Base.Keys.self).superDecoder())
            }
        }
        let value: JSONValue = ["super": ["size": 3]]
        let now = try value.decode(Derived.self)
        let then = try before(Derived.self, value)
        #expect(now.base.size == then.base.size)
        #expect(now.base.path == then.base.path)
    }

    /// Every answer recorded from Hermes and the bridge reads as before.
    @Test func everyRecordedAnswerReadsAsBefore() throws {
        let directory = try Fixtures.url("handshake-profiles.jsonl").deletingLastPathComponent()
        let captures = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".jsonl") }
        var resumes = 0
        for capture in captures {
            let text = try String(contentsOf: directory.appendingPathComponent(capture), encoding: .utf8)
            for line in text.split(separator: "\n") {
                guard let frame = try? JSONValue.parse(String(line)), let result = frame["result"] ?? frame["frame"]?["result"],
                      result["session_id"] != nil else { continue }
                #expect(try result.decode(HermesWire.SessionResumeResult.self) == before(HermesWire.SessionResumeResult.self, result))
                resumes += 1
            }
        }
        #expect(resumes > 10)
    }
}
