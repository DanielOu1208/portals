import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import AgentCore

@Suite struct ImageTests {
    /// A PNG of one flat colour.
    private func png(width: Int, height: Int) throws -> Data {
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return output as Data
    }

    @Test func aLargePhotoIsScaledToTheLimitAndKeepsItsShape() throws {
        let jpeg = try #require(ImageDownscaler.jpeg(from: try png(width: 4000, height: 3000)))
        let size = try #require(ImageDownscaler.pixelSize(of: jpeg))
        #expect(size.width == 1568)
        #expect(size.height == 1176)
        // JPEG, whatever came in.
        #expect(jpeg.prefix(3) == Data([0xFF, 0xD8, 0xFF]))
    }

    @Test func aTallImageIsLimitedByItsHeight() throws {
        let jpeg = try #require(ImageDownscaler.jpeg(from: try png(width: 1000, height: 4000), maxPixel: 800))
        let size = try #require(ImageDownscaler.pixelSize(of: jpeg))
        #expect(size.height == 800)
        #expect(size.width == 200)
    }

    @Test func aSmallImageIsNotEnlarged() throws {
        let jpeg = try #require(ImageDownscaler.jpeg(from: try png(width: 120, height: 80)))
        let size = try #require(ImageDownscaler.pixelSize(of: jpeg))
        #expect(size.width == 120)
        #expect(size.height == 80)
    }

    @Test func whatIsNotAnImageIsRefused() {
        #expect(ImageDownscaler.jpeg(from: Data("not an image".utf8)) == nil)
        #expect(ImageDownscaler.jpeg(from: Data()) == nil)
    }

    @Test func aMessageKeepsItsImagesThroughASave() throws {
        let image = AttachedImage(filename: "photo.jpg")
        var state = ThreadState()
        state.messageSent("look", images: [image])
        let encoded = try JSONEncoder().encode(state.transcript)
        let decoded = try JSONDecoder().decode(Transcript.self, from: encoded)
        guard case let .user(message)? = decoded.turns.first?.items.first?.content else {
            Issue.record("expected the message")
            return
        }
        #expect(message.images == [image])
    }

    @Test func aTranscriptSavedBeforeImagesStillLoads() throws {
        let old = #"{"text":"hello","sentAt":0,"delivery":"started"}"#
        let message = try JSONDecoder().decode(UserMessage.self, from: Data(old.utf8))
        #expect(message.text == "hello")
        #expect(message.images.isEmpty)
        #expect(message.delivery == .started)
    }

    @Test func imagesAreStoredWithTheThreadAndErasedWithIt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-images-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ThreadStore(directory: directory)
        let thread = ThreadKey(host: HostID(rawValue: "mini"), id: ThreadRef.ID(rawValue: "t1"))
        let image = ImageAttachment(data: Data([1, 2, 3]), filename: "photo.jpg")

        store.saveImage(image.data, id: image.id)
        var state = ThreadState()
        state.messageSent("look", images: [image.reference])
        store.saveTranscript(state.transcript, for: thread)
        #expect(store.loadImage(image.id) == Data([1, 2, 3]))

        store.deleteTranscript(for: thread)
        #expect(store.loadImage(image.id) == nil)
        #expect(store.loadTranscript(for: thread) == nil)
    }
}
