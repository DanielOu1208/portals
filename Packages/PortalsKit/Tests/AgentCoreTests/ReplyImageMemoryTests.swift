import Foundation
import Testing
@testable import AgentCore

/// The images replies show, kept decoded in memory: by bytes as well as by count, so a
/// thread of screenshots cannot hold hundreds of MB on a phone.
@Suite struct ReplyImageMemoryTests {
    private let gigabyte: UInt64 = 1024 * 1024 * 1024
    private let megabyte = 1024 * 1024
    /// A phone's screenshot (1320 x 2868) decoded at 2048 pixels on its longer side, 4 bytes a pixel.
    private let screenshot = 943 * 2048 * 4

    @Test func aPhoneKeepsAboutADozenScreenshotsNotSixty() {
        for memory in [3, 4, 6, 8, 12] {
            let limit = ReplyImageMemory.costLimit(physicalMemory: UInt64(memory) * gigabyte, isMac: false)
            #expect(limit <= 128 * megabyte, "\(memory) GB")
            #expect(limit >= 32 * megabyte, "\(memory) GB")
            #expect(limit / screenshot < ReplyImageMemory.countLimit, "\(memory) GB")
            #expect(limit / screenshot >= 4, "\(memory) GB")
        }
        // The smallest keep a few, the largest no more than the cap.
        #expect(ReplyImageMemory.costLimit(physicalMemory: 1 * gigabyte, isMac: false) == 32 * megabyte)
        #expect(ReplyImageMemory.costLimit(physicalMemory: 3 * gigabyte, isMac: false) == Int(3 * gigabyte / 40))
        #expect(ReplyImageMemory.costLimit(physicalMemory: 16 * gigabyte, isMac: false) == 128 * megabyte)
    }

    @Test func aMacKeepsMoreButNotWithoutEnd() {
        #expect(ReplyImageMemory.costLimit(physicalMemory: 8 * gigabyte, isMac: true) == Int(8 * gigabyte / 40))
        #expect(ReplyImageMemory.costLimit(physicalMemory: 64 * gigabyte, isMac: true) == 256 * megabyte)
    }
}
