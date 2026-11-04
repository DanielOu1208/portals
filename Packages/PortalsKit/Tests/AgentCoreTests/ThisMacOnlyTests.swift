import Foundation
import Testing
@testable import AgentCore

/// A Mac set up without Tailscale (2026-11-03): setup gives its host 127.0.0.1 as its address.
@Suite struct ThisMacOnlyTests {
    @Test func loopbackAddressesAreTheOnesOnlyTheComputerItselfAnswersAt() throws {
        // The same two lists as in the host's this-mac-only.test.ts: the host and the app must agree.
        for text in ["http://127.0.0.1:9120", "http://127.1.2.3:80", "http://127.1:9120", "http://2130706433:9120", "http://0x7f.0.0.1:9120", "http://017700000001:80", "http://127.0.0.1.:80", "http://localhost:9120", "http://LOCALHOST", "http://[::1]:9120", "http://[0:0:0:0:0:0:0:1]:9120"] {
            #expect(try #require(URL(string: text)).isLoopback, "\(text)")
        }
        for text in ["https://mac.tailnet.ts.net:10010", "http://100.64.0.1:9120", "http://192.168.1.5:9120", "http://128.0.0.1:80", "http://126.255.255.255:80", "http://0.0.0.0:80", "http://127.0.0.1.example.com", "http://127.0.0.1000:80", "http://localhost.:80", "http://[::2]:80", "http://[::ffff:127.0.0.1]:80"] {
            #expect(try !#require(URL(string: text)).isLoopback, "\(text)")
        }
    }

    /// As the host panel has the address: `URL.host()`, an IPv6 one with no brackets.
    @Test func aHostAloneIsReadTheSameWay() {
        for host in ["127.0.0.1", "127.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"] {
            #expect(URL.isLoopback(host: host), "\(host)")
        }
        for host in ["mac.tailnet.ts.net", "100.64.0.1", "::2", "", "not an address"] {
            #expect(!URL.isLoopback(host: host), "\(host)")
        }
    }

    private func mac(_ id: String, _ address: String?, removed: Bool = false) -> NetMember {
        NetMember(id: id, kind: .mac, name: id, url: address.flatMap(URL.init(string:)), removed: removed)
    }

    private func membership(_ members: [NetMember]) -> NetMembership {
        var membership = NetMembership()
        membership.net = "0123456789abcdef"
        membership.members = members
        return membership
    }

    @Test func aNetIsOnItsOwnMacOnlyWhileEveryHostOfItIs() {
        let phone = NetMember(id: "phone", kind: .device, name: "iPhone", platform: "ios")
        #expect(membership([mac("here", "http://127.0.0.1:9120"), phone]).isOnlyOnItsOwnMac)
        #expect(!membership([mac("here", "https://mac.tailnet.ts.net:10010"), phone]).isOnlyOnItsOwnMac)
        #expect(!membership([mac("here", "http://127.0.0.1:9120"), mac("mini", "https://mini.tailnet.ts.net:10010")]).isOnlyOnItsOwnMac)
        // One taken out of the net no longer counts; with no host at all, nothing is said.
        #expect(membership([mac("here", "http://127.0.0.1:9120"), mac("mini", "https://mini.tailnet.ts.net:10010", removed: true)]).isOnlyOnItsOwnMac)
        #expect(!membership([phone]).isOnlyOnItsOwnMac)
        #expect(!NetMembership().isOnlyOnItsOwnMac)
    }
}
