import Foundation
import ImageIO
import UniformTypeIdentifiers

/// An image on its way to an agent with a message.
public struct ImageAttachment: Identifiable, Hashable, Sendable {
    public var id: UUID
    /// The encoded image (JPEG once it has been through `ImageDownscaler`).
    public var data: Data
    public var filename: String

    public init(id: UUID = UUID(), data: Data, filename: String) {
        self.id = id
        self.data = data
        self.filename = filename
    }

    /// What the transcript keeps: enough to find the app's own copy again.
    public var reference: AttachedImage { AttachedImage(id: id, filename: filename) }
}

/// An image that was sent with a message. The transcript holds only this; the pixels
/// are a file the app keeps (`ThreadStore.imageURL`), since the host's history does
/// not hand images back.
public struct AttachedImage: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var filename: String

    public init(id: UUID = UUID(), filename: String) {
        self.id = id
        self.filename = filename
    }
}

/// Makes a photo small enough to send: at most `maxPixel` on its longer side, turned
/// upright, as JPEG. A phone photo goes from several megabytes to a few hundred
/// kilobytes, and models gain nothing from more.
public enum ImageDownscaler {
    public static let defaultMaxPixel = 1568

    /// nil when `data` is not an image.
    public static func jpeg(from data: Data, maxPixel: Int = defaultMaxPixel, quality: Double = 0.8) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            // Always redrawn, so the result is never larger than asked for and the
            // camera's orientation is baked in rather than left as metadata.
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    /// The pixel size of an encoded image.
    public static func pixelSize(of data: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return (width, height)
    }
}
