import AgentCore
import Foundation
import Testing

/// Sealed notifications (docs/pairing-and-relay.md), opened as the notification extension
/// opens them. The sealed value is the bridge's own, from bridge/test/seal.test.ts: the
/// two sides are held to one format.
struct SealedNotificationTests {
    /// The bytes 0 to 31, as in the bridge's test.
    private let key = Data((0 ..< 32).map { UInt8($0) })
    /// Made by the bridge's `seal()` with that key and the nonce A0 A1 … AB.
    private let sealed = "oKGio6SlpqeoqaqrnToIRDGnZ51YR8yydROuv1KAe2Pn1TYF6GJDpEWJM2iqVjOXygIxSDbwYOolWOGWI2JkckCHexA1LSsqy1D3xdqGpR1dhcmSksKdbeaiqJoviz+EqqqmWJPdbpQ9NtLgQHrNgz9YWfok"

    @Test func theBridgesSealOpensWithTheHostsKey() {
        #expect(SealedNotification.open(sealed, with: key) == SealedNotification(
            title: "Karina", subtitle: "Fix the build", body: "Wants to run: rm -rf build — ok?"
        ))
    }

    @Test func anythingElseOpensToNothing() {
        #expect(SealedNotification.open(sealed, with: Data(repeating: 7, count: 32)) == nil)
        #expect(SealedNotification.open(sealed, with: key.prefix(16)) == nil)
        var tampered = Data(base64Encoded: sealed)!
        tampered[20] ^= 1
        #expect(SealedNotification.open(tampered.base64EncodedString(), with: key) == nil)
        #expect(SealedNotification.open("not base64", with: key) == nil)
        #expect(SealedNotification.open("", with: key) == nil)
    }

    @Test func aPayloadIsOpenedWithTheKeyOfTheHostItNames() {
        let userInfo: [AnyHashable: Any] = ["aeriportal": ["thread": "t1", "kind": "approval", "host": "mbp16", "sealed": sealed]]
        var asked: [HostID] = []
        let words = SealedNotification.open(userInfo: userInfo) { host in
            asked.append(host)
            return host == HostID(rawValue: "mbp16") ? key : nil
        }
        #expect(words?.title == "Karina")
        #expect(asked == [HostID(rawValue: "mbp16")])

        // Another host's key, no host, or nothing sealed: nothing to show but what came.
        #expect(SealedNotification.open(userInfo: userInfo) { _ in Data(repeating: 1, count: 32) } == nil)
        #expect(SealedNotification.open(userInfo: ["aeriportal": ["thread": "t1", "sealed": sealed]]) { _ in key } == nil)
        #expect(SealedNotification.open(userInfo: ["aeriportal": ["thread": "t1", "host": "mbp16"]]) { _ in key } == nil)
        #expect(SealedNotification.open(userInfo: [:]) { _ in key } == nil)
    }
}
