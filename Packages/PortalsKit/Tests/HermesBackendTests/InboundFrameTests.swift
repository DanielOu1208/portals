import Foundation
import Testing
@testable import HermesBackend

/// `JSONValue` tries text first when it reads a value, where it used to try true or
/// false, then a number, then text. A value is of one kind only, so it must read the
/// same, sooner.
@Suite struct ValueReadingTests {
    /// A value read in the order `JSONValue` used to try the kinds in.
    private indirect enum InTheOldOrder: Decodable {
        case value(JSONValue)

        init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() {
                self = .value(.null)
            } else if let value = try? container.decode(Bool.self) {
                self = .value(.bool(value))
            } else if let value = try? container.decode(Double.self) {
                self = .value(.number(value))
            } else if let value = try? container.decode(String.self) {
                self = .value(.string(value))
            } else if let value = try? container.decode([InTheOldOrder].self) {
                self = .value(.array(value.map(\.read)))
            } else {
                self = .value(.object(try container.decode([String: InTheOldOrder].self).mapValues(\.read)))
            }
        }

        var read: JSONValue {
            switch self {
            case let .value(value): value
            }
        }
    }

    /// What a text reads as now and in the old order: its value, or nil when refused.
    private func both(_ text: String) -> (now: JSONValue?, before: JSONValue?) {
        (try? JSONValue.parse(text), (try? JSONDecoder().decode(InTheOldOrder.self, from: Data(text.utf8)))?.read)
    }

    /// Bit for bit, which == does not say of a number.
    private func bits(_ value: JSONValue?) -> String {
        switch value {
        case nil: "refused"
        case .null?: "null"
        case let .bool(value)?: "bool \(value)"
        case let .number(value)?: "number \(value.bitPattern)"
        case let .string(value)?: "string \(Array(value.utf8))"
        case let .array(values)?: "[" + values.map { bits($0) }.joined(separator: ",") + "]"
        case let .object(members)?: "{" + members.keys.sorted().map { "\(Array($0.utf8)):\(bits(members[$0]))" }.joined(separator: ",") + "}"
        }
    }

    @Test func everyRecordedFrameReadsAsItDid() throws {
        let directory = try Fixtures.url("handshake-profiles.jsonl").deletingLastPathComponent()
        let captures = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".jsonl") || $0.hasSuffix(".json") }
        #expect(captures.count > 40)
        var lines = 0
        for capture in captures {
            let text = try String(contentsOf: directory.appendingPathComponent(capture), encoding: .utf8)
            // A capture is a frame a line; any other fixture is one document.
            for line in capture.hasSuffix(".jsonl") ? text.split(separator: "\n").map(String.init) : [text] {
                let read = both(line)
                #expect(read.now != nil, "\(capture): \(line.prefix(120))")
                #expect(bits(read.now) == bits(read.before), "\(capture): \(line.prefix(120))")
                lines += 1
            }
        }
        #expect(lines > 2000)
    }

    @Test func oddAndBrokenTextReadsAsItDid() {
        let deep = String(repeating: "[", count: 600) + String(repeating: "]", count: 600)
        let texts = [
            // Values of every kind, at the top and inside.
            #"{"a":null,"b":true,"c":false,"d":0,"e":-0,"f":1,"g":-1,"h":1.5,"i":"","j":[],"k":{}}"#,
            #"[null,true,false,0,1,"x",[],{}]"#, #"{}"#, #"[]"#, #"[[[[]]]]"#, #"{"a":{"a":{"a":{}}}}"#,
            "null", "true", "false", "0", "1", "-1", "3.25", #""text""#, #""""#, " 7 ", "\n{\"a\":1}\n",
            // Text that says a number, true, false or nothing stays text.
            #"["0","1","1.5","-1","1e5","true","false","null","NaN","Infinity","[]","{}"]"#,
            // Numbers at the edges of what a Double and a whole number hold.
            "[0.1,0.2,0.30000000000000004,1e-7,1E5,1e+5,-0.0,0.0,5e-324,2.2250738585072011e-308,1.7976931348623157e308]",
            "[9007199254740991,9007199254740992,9007199254740993,-9007199254740993,9223372036854775807,-9223372036854775808]",
            "[9223372036854775808,18446744073709551615,18446744073709551616,123456789012345678901234567890]",
            "[1791324000.123,1791324000.5,1791818324.815,0.1234567890123456789,123456789.123456789123456789]",
            "[1e400]", "[-1e400]", "[1e-400]", "[1e999999]", #"{"a":[1,{"b":1e400}]}"#,
            "[01]", "[1.]", "[.5]", "[+1]", "[0x10]", "[1e]", "[--1]", "[NaN]", "[Infinity]", "[-Infinity]", "[nan]",
            // Text: escapes, pairs, halves of pairs, what is not ASCII, a zero.
            #"["\" \\ \/ \b \f \n \r \t"]"#, #"["\u00e9 \u4fee\u6b63 \ud83d\ude80 café 修正 🚀"]"#, #"["\u0000 and after"]"#,
            #"["\ud83d"]"#, #"["\ude80"]"#, #"["\ud83d x"]"#, #"["\ud83d\u0041"]"#, #"["\uZZZZ"]"#, #"["\x41"]"#, #"["a\qb"]"#,
            "[\"a\tb\"]", "[\"a\nb\"]", "[\"\u{7f}\"]", "[\"\u{feff}\"]", "\u{feff}{\"a\":1}",
            // The same key twice, keys that differ by case or by how they are written.
            #"{"a":1,"a":2}"#, #"{"a":1,"A":2}"#, #"{"\u0061":1,"a":2}"#, #"{"é":1,"e\u0301":2}"#, #"{"":1}"#,
            #"{"a":true,"a":"x"}"#, #"{"a":[1],"a":{"b":2}}"#,
            // Not JSON.
            "", " ", "{", "}", "[", "]", "{]", #"{"a"}"#, #"{"a":}"#, #"{"a":1,}"#, "[1,]", "[,1]", "[1 2]", #"{a:1}"#, #"{'a':1}"#,
            "['a']", "tru", "nul", "True", "None", "undefined", #"{"a":1} x"#, #"{"a":1}{"b":2}"#, "[1]//x", "/*x*/[1]", "[1,\n#x\n2]",
            #""unfinished"#, #"{"a":"unfinished}"#, "\u{0}", "[\u{1}]",
            deep, #"{"deep":\#(deep)}"#,
        ]
        var read = 0
        for text in texts {
            let both = both(text)
            #expect(bits(both.now) == bits(both.before), "\(text.prefix(80))")
            if both.now != nil { read += 1 }
        }
        // About a third of them are read, the others refused, either way.
        #expect(read > 30 && read < texts.count - 30)
    }

    @Test func numbersReadAsTheyDid() throws {
        // Times and sizes as hosts send them, and numbers of every size, each written
        // the short way a host writes it and the long way.
        var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> UInt64 {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return seed
        }
        var numbers: [String] = []
        for _ in 0..<2000 {
            let random = next()
            let any = Double(bitPattern: random)
            if any.isFinite { numbers += ["\(any)", String(format: "%.17g", any)] }
            let time = 1_700_000_000 + Double(random % 100_000_000_000) / 1000
            numbers += ["\(time)", String(format: "%.3f", time), String(format: "%.6f", time)]
            numbers.append("\(Int64(bitPattern: next()))")
            numbers.append("\(next() % 10_000_000)")
        }
        for chunk in stride(from: 0, to: numbers.count, by: 500) {
            let text = "[" + numbers[chunk..<min(chunk + 500, numbers.count)].joined(separator: ",") + "]"
            let read = both(text)
            #expect(read.now?.arrayValue?.count == min(500, numbers.count - chunk))
            #expect(bits(read.now) == bits(read.before))
        }
    }

    /// What reading a value asks its decoder for, in order: the reason a frame is read
    /// sooner. Each kind asked for in vain is an error made and dropped.
    @Test func textIsAskedForFirstThenTrueOrFalseThenANumber() throws {
        for (given, asked) in [
            (Asked.Given.text("x"), ["nil", "String"]),
            (.flag(true), ["nil", "String", "Bool"]),
            (.number(1.5), ["nil", "String", "Bool", "Double"]),
            (.nothing, ["nil"]),
        ] {
            let decoder = Asked(given)
            let value = try JSONValue(from: decoder)
            #expect(decoder.log.asked == asked)
            switch given {
            case let .text(text): #expect(value == .string(text))
            case let .flag(flag): #expect(value == .bool(flag))
            case let .number(number): #expect(value == .number(number))
            case .nothing: #expect(value == .null)
            }
        }
    }

    /// A decoder that holds one plain value and keeps what it was asked for.
    private struct Asked: Decoder, SingleValueDecodingContainer {
        enum Given {
            case text(String), flag(Bool), number(Double), nothing
        }

        final class Log {
            var asked: [String] = []
        }

        let given: Given
        let log = Log()
        var codingPath: [any CodingKey] { [] }
        var userInfo: [CodingUserInfoKey: Any] { [:] }

        init(_ given: Given) {
            self.given = given
        }

        private func mismatch<T>(_ type: T.Type) -> DecodingError {
            DecodingError.typeMismatch(type, .init(codingPath: [], debugDescription: "another kind of value"))
        }

        func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> { throw mismatch([String: String].self) }
        func unkeyedContainer() throws -> any UnkeyedDecodingContainer { throw mismatch([String].self) }
        func singleValueContainer() throws -> any SingleValueDecodingContainer { self }

        func decodeNil() -> Bool {
            log.asked.append("nil")
            if case .nothing = given { return true }
            return false
        }

        func decode(_ type: Bool.Type) throws -> Bool {
            log.asked.append("Bool")
            guard case let .flag(flag) = given else { throw mismatch(type) }
            return flag
        }

        func decode(_ type: String.Type) throws -> String {
            log.asked.append("String")
            guard case let .text(text) = given else { throw mismatch(type) }
            return text
        }

        func decode(_ type: Double.Type) throws -> Double {
            log.asked.append("Double")
            guard case let .number(number) = given else { throw mismatch(type) }
            return number
        }

        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            log.asked.append("\(type)")
            throw mismatch(type)
        }

        func decode(_ type: Float.Type) throws -> Float { throw mismatch(type) }
        func decode(_ type: Int.Type) throws -> Int { throw mismatch(type) }
        func decode(_ type: Int8.Type) throws -> Int8 { throw mismatch(type) }
        func decode(_ type: Int16.Type) throws -> Int16 { throw mismatch(type) }
        func decode(_ type: Int32.Type) throws -> Int32 { throw mismatch(type) }
        func decode(_ type: Int64.Type) throws -> Int64 { throw mismatch(type) }
        func decode(_ type: UInt.Type) throws -> UInt { throw mismatch(type) }
        func decode(_ type: UInt8.Type) throws -> UInt8 { throw mismatch(type) }
        func decode(_ type: UInt16.Type) throws -> UInt16 { throw mismatch(type) }
        func decode(_ type: UInt32.Type) throws -> UInt32 { throw mismatch(type) }
        func decode(_ type: UInt64.Type) throws -> UInt64 { throw mismatch(type) }
    }
}

@Suite struct InboundFrameTests {
    @Test func resultResponse() throws {
        let frame = try InboundFrame.parse(#"{"jsonrpc":"2.0","id":"r1","result":{"ok":true}}"#)
        #expect(frame == .response(id: "r1", outcome: .success(["ok": true])))
    }

    @Test func nullResultIsStillAResponse() throws {
        let frame = try InboundFrame.parse(#"{"jsonrpc":"2.0","id":"r2","result":null}"#)
        #expect(frame == .response(id: "r2", outcome: .success(.null)))
    }

    @Test func errorResponse() throws {
        let frame = try InboundFrame.parse(
            #"{"jsonrpc":"2.0","id":"r3","error":{"code":4000,"message":"unknown param","data":{"key":"x"}}}"#
        )
        #expect(frame == .response(
            id: "r3",
            outcome: .failure(JSONRPCError(code: 4000, message: "unknown param", data: ["key": "x"]))
        ))
    }

    @Test func heartbeatPongIsAResponse() throws {
        let frame = try InboundFrame.parse(#"{"jsonrpc": "2.0", "result": {"ok": true}, "id": "heartbeat-1"}"#)
        #expect(frame == .response(id: "heartbeat-1", outcome: .success(["ok": true])))
    }

    @Test func event() throws {
        let frame = try InboundFrame.parse(
            #"{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"s1","seq":42,"payload":{"text":"hi"}}}"#
        )
        #expect(frame == .event(GatewayEvent(type: "message.delta", sessionID: "s1", seq: 42, payload: ["text": "hi"])))
    }

    @Test func connectionWideEventHasNoSession() throws {
        let frame = try InboundFrame.parse(
            #"{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"replay_epoch":"e1"}}}"#
        )
        #expect(frame == .event(GatewayEvent(type: "gateway.ready", payload: ["replay_epoch": "e1"])))
    }

    @Test func serverRequest() throws {
        let frame = try InboundFrame.parse(
            #"{"jsonrpc":"2.0","id":"srq-7","method":"approval","params":{"session_id":"s1","command":"rm -rf build"}}"#
        )
        #expect(frame == .serverRequest(ServerRequest(
            id: "srq-7",
            method: "approval",
            params: ["session_id": "s1", "command": "rm -rf build"]
        )))
    }

    @Test func unrecognizedShapes() throws {
        #expect(try InboundFrame.parse("[1,2,3]") == .unrecognized)
        #expect(try InboundFrame.parse(#"{"jsonrpc":"2.0","method":"event","params":{}}"#) == .unrecognized)
        #expect(try InboundFrame.parse(#"{"jsonrpc":"2.0","id":"r9"}"#) == .unrecognized)
    }

    @Test func malformedJSONThrows() {
        #expect(throws: (any Error).self) { try InboundFrame.parse("{not json") }
    }
}

@Suite struct JSONValueTests {
    @Test func wholeNumbersSerializeAsIntegers() throws {
        #expect(try JSONValue.object(["last_seen": 42]).serialized() == #"{"last_seen":42}"#)
        #expect(try JSONValue.number(1.5).serialized() == "1.5")
    }

    @Test func roundTrip() throws {
        let text = #"{"a":[1,2.5,"x",null,true],"b":{"c":"d"}}"#
        #expect(try JSONValue.parse(text).serialized() == text)
    }

    @Test func boolAndNumberStayDistinct() throws {
        #expect(try JSONValue.parse("true") == .bool(true))
        #expect(try JSONValue.parse("1") == .number(1))
        #expect(JSONValue.number(1).boolValue == nil)
        #expect(JSONValue.number(1.5).intValue == nil)
        #expect(JSONValue.number(7).intValue == 7)
    }
}
