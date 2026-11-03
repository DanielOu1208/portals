import Foundation
import Testing
@testable import AgentCore

/// A link as the bridge's setup writes one, with these values percent-encoded.
private func link(_ parameters: KeyValuePairs<String, String>) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let query = parameters.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }
    return "portals://pair?" + query.joined(separator: "&")
}

private let address = "https://mbp16.tailnet.ts.net:10010"

@Suite struct PairingLinkTests {
    @Test func everyPartIsRead() throws {
        let pairing = try PairingLink(parsing: link(["v": "1", "url": address, "user": "dana", "password": "s3cret", "name": "MacBook Pro"]))
        #expect(pairing.url.absoluteString == address)
        #expect(pairing.username == "dana")
        #expect(pairing.password == "s3cret")
        #expect(pairing.name == "MacBook Pro")
    }

    @Test func valuesArePercentDecoded() throws {
        let pairing = try PairingLink(parsing: link(["v": "1", "url": address, "user": "da na", "password": "p@ss+w&rd=%/?#", "name": "Dana’s Mac"]))
        #expect(pairing.username == "da na")
        #expect(pairing.password == "p@ss+w&rd=%/?#")
        #expect(pairing.name == "Dana’s Mac")
        // Written by hand, with the address's own characters left as they are.
        let typed = try PairingLink(parsing: "portals://pair?v=1&url=https://mac.example.ts.net:10010/&user=me&password=a%2Bb+c")
        #expect(typed.url.absoluteString == "https://mac.example.ts.net:10010")
        #expect(typed.password == "a+b+c")
    }

    @Test func theNameAndTheVersionMayBeLeftOut() throws {
        let pairing = try PairingLink(parsing: link(["url": address, "user": "dana", "password": "s3cret"]))
        #expect(pairing.name == nil)
        #expect(try PairingLink(parsing: link(["url": address, "user": "dana", "password": "s3cret", "name": "  "])).name == nil)
    }

    @Test func unknownPartsAreIgnoredAndTheFirstOfANameCounts() throws {
        let pairing = try PairingLink(parsing: link([
            "v": "1", "relay": "abc", "url": address, "user": "dana", "user": "other", "password": "s3cret", "colour": "blue",
        ]))
        #expect(pairing.username == "dana")
        #expect(pairing.password == "s3cret")
    }

    @Test func spaceAroundTheLinkAndCapitalsInItsSchemeAreFine() throws {
        let text = "  " + link(["v": "1", "url": address, "user": "dana", "password": "s3cret"]).replacingOccurrences(of: "portals://pair", with: "PORTALS://Pair") + "\n"
        #expect(try PairingLink(parsing: text).username == "dana")
    }

    @Test func aNewerLinkIsRefused() {
        #expect(throws: PairingLink.Problem.newerVersion) {
            try PairingLink(parsing: link(["v": "2", "url": address, "user": "dana", "password": "s3cret"]))
        }
        #expect(throws: PairingLink.Problem.newerVersion) {
            try PairingLink(parsing: link(["v": "two", "url": address, "user": "dana", "password": "s3cret"]))
        }
        #expect(PairingLink.Problem.newerVersion.localizedDescription == "Update Portals to add this host.")
    }

    @Test func aLinkMissingAPartSaysWhich() {
        #expect(throws: PairingLink.Problem.missing(.address)) {
            try PairingLink(parsing: link(["v": "1", "user": "dana", "password": "s3cret"]))
        }
        #expect(throws: PairingLink.Problem.missing(.address)) {
            try PairingLink(parsing: link(["v": "1", "url": " ", "user": "dana", "password": "s3cret"]))
        }
        #expect(throws: PairingLink.Problem.missing(.username)) {
            try PairingLink(parsing: link(["v": "1", "url": address, "password": "s3cret"]))
        }
        #expect(throws: PairingLink.Problem.missing(.password)) {
            try PairingLink(parsing: link(["v": "1", "url": address, "user": "dana", "password": ""]))
        }
        #expect(throws: PairingLink.Problem.badAddress) {
            try PairingLink(parsing: link(["v": "1", "url": "ftp://mac.example", "user": "dana", "password": "s3cret"]))
        }
    }

    @Test func otherCodesAreNotLinks() {
        for text in ["https://example.com", "portals://open?thread=1", "portals://pair/extra?v=1", "hello", ""] {
            #expect(throws: PairingLink.Problem.notALink) { try PairingLink(parsing: text) }
        }
    }

    @Test func aNewMacIsCalledWhatItCallsItself() throws {
        let named = try PairingLink(parsing: link(["url": address, "user": "dana", "password": "s3cret", "name": "Studio"]))
        let added = named.host(updating: [])
        #expect(added.name == "Studio")
        #expect(added.url.absoluteString == address)
        #expect(added.username == "dana")
        let unnamed = try PairingLink(parsing: link(["url": address, "user": "dana", "password": "s3cret"]))
        #expect(unnamed.host(updating: []).name == "mbp16")
    }

    @Test func aMacAlreadyAddedIsUpdatedNotAddedAgain() throws {
        let saved = HostConfig(
            id: HostID(rawValue: "macbook"), name: "My laptop", url: URL(string: "https://MBP16.tailnet.ts.net:10010/")!, username: "old",
            kind: .bridge, generalFolder: "/Users/dana/Portals"
        )
        let other = HostConfig(id: HostID(rawValue: "mini"), name: "Mini", url: URL(string: "https://mini.tailnet.ts.net:10008")!, username: "dana")
        let pairing = try PairingLink(parsing: link(["url": address, "user": "dana", "password": "new", "name": "MacBook Pro"]))
        #expect(pairing.match(in: [other, saved])?.id == saved.id)
        let updated = pairing.host(updating: [other, saved])
        #expect(updated.id == saved.id)
        #expect(updated.name == "My laptop")
        #expect(updated.username == "dana")
        #expect(updated.kind == .bridge)
        #expect(updated.generalFolder == "/Users/dana/Portals")
        // Another port is another bridge.
        let elsewhere = try PairingLink(parsing: link(["url": "https://mbp16.tailnet.ts.net:10011", "user": "dana", "password": "s3cret"]))
        #expect(elsewhere.match(in: [saved]) == nil)
    }

    @Test func addressesAreComparedAsPlaces() {
        let same = { (one: String, other: String) in HostConfig.isSameAddress(URL(string: one)!, URL(string: other)!) }
        #expect(same("https://Mac.Example.ts.net", "https://mac.example.ts.net:443/"))
        #expect(same("http://127.0.0.1:9119", "HTTP://127.0.0.1:9119"))
        #expect(!same("http://mac.example.ts.net", "https://mac.example.ts.net"))
        #expect(!same("https://mac.example.ts.net:10010", "https://mac.example.ts.net:10011"))
        #expect(!same("https://mac.example.ts.net/a", "https://mac.example.ts.net/b"))
    }
}
