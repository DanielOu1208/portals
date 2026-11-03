import AgentCore
import ImageIO
import SwiftUI
import UIKit

extension EnvironmentValues {
    /// Where the app keeps its copies of the images sent with messages.
    @Entry var imageStore = ThreadStore.standard
}

/// Decodes the app's saved images at the size they are shown, once each.
@MainActor
enum ImageThumbnails {
    private static let cache = NSCache<NSString, UIImage>()

    /// The saved image, no larger than `maxPixel` on its longer side. nil when the app
    /// has no copy (the thread was rebuilt from the host, which only names images).
    static func image(_ id: AttachedImage.ID, in store: ThreadStore, maxPixel: Int = 900) -> UIImage? {
        let key = "\(id.uuidString)-\(maxPixel)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let image = decode(contentsOf: store.imageURL(id), maxPixel: maxPixel) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// A thumbnail of an image about to be sent.
    static func image(of attachment: ImageAttachment, maxPixel: Int = 240) -> UIImage? {
        let key = "\(attachment.id.uuidString)-draft" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let source = CGImageSourceCreateWithData(attachment.data as CFData, nil),
              let image = thumbnail(source, maxPixel: maxPixel) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    private static func decode(contentsOf url: URL, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return thumbnail(source, maxPixel: maxPixel)
    }

    private static func thumbnail(_ source: CGImageSource, maxPixel: Int) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

/// The images sent with a message, above its text.
struct SentImages: View {
    let images: [AttachedImage]

    @Environment(\.imageStore) private var store

    var body: some View {
        // One image shows large; several share the row.
        let maxHeight: CGFloat = images.count == 1 ? 220 : 120
        HStack(spacing: Theme.grid / 2) {
            ForEach(images) { image in
                if let picture = ImageThumbnails.image(image.id, in: store) {
                    // Bounded in width by its shape as well as in height: the chat
                    // proposes no height, so with a height bound alone the image took
                    // the column's width and was drawn at the row's leading edge, away
                    // from your message. Rounded before it is framed, since in a row
                    // the frame is as tall as the tallest image.
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFit()
                        .clipShape(.rect(cornerRadius: 14))
                        .frame(maxWidth: maxHeight * Self.aspectRatio(of: picture), maxHeight: maxHeight)
                        .accessibilityLabel("Image you sent")
                } else {
                    // No copy on this device: the host has it, under this name.
                    Label(image.filename, systemImage: "photo")
                        .font(.app.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.horizontal, Theme.grid * 1.5)
                        .padding(.vertical, Theme.grid)
                        .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: 14))
                }
            }
        }
    }

    /// The image's width over its height.
    private static func aspectRatio(of picture: UIImage) -> CGFloat {
        picture.size.height > 0 ? picture.size.width / picture.size.height : 1
    }
}

/// The images and files about to be sent, in the composer above the text: each can be
/// taken out.
struct AttachmentStrip: View {
    @Binding var attachments: [ImageAttachment]
    @Binding var files: [FileAttachment]

    static let thumbnailSize: CGFloat = 64

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Theme.grid) {
                ForEach(attachments) { attachment in
                    thumbnail(attachment)
                }
                ForEach(files) { file in
                    tile(file)
                }
            }
            .padding(.horizontal, Theme.grid * 1.5)
            .padding(.top, Theme.grid)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("attachment-strip")
    }

    private func thumbnail(_ attachment: ImageAttachment) -> some View {
        Group {
            if let picture = ImageThumbnails.image(of: attachment) {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFill()
            } else {
                Color(uiColor: .tertiarySystemFill)
            }
        }
        .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
        .clipShape(.rect(cornerRadius: 12))
        .overlay(alignment: .topTrailing) {
            Button("Remove image", systemImage: "xmark.circle.fill") {
                withAnimation(.smooth(duration: 0.2)) {
                    attachments.removeAll { $0.id == attachment.id }
                }
            }
            .labelStyle(.iconOnly)
            .font(.app.body)
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, .black.opacity(0.6))
            .padding(2)
            .buttonStyle(.plain)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Image to send")
    }

    /// A file by its name, as tall as the thumbnails beside it.
    private func tile(_ file: FileAttachment) -> some View {
        FileChip(name: file.filename, size: file.data.count)
            .frame(maxWidth: 200)
            .frame(height: Self.thumbnailSize)
            .padding(.trailing, Theme.grid * 1.5)
            .overlay(alignment: .topTrailing) {
                Button("Remove file", systemImage: "xmark.circle.fill") {
                    withAnimation(.smooth(duration: 0.2)) {
                        files.removeAll { $0.id == file.id }
                    }
                }
                .labelStyle(.iconOnly)
                .font(.app.body)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .black.opacity(0.6))
                .padding(2)
                .buttonStyle(.plain)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("File to send: \(file.filename)")
    }
}

extension ImageAttachment {
    /// An image as it is sent: scaled down and re-encoded, off the main thread. nil
    /// when `data` is not an image.
    static func prepared(from data: Data, name: String = "photo") async -> ImageAttachment? {
        let jpeg = await Task.detached(priority: .userInitiated) { ImageDownscaler.jpeg(from: data) }.value
        return jpeg.map { ImageAttachment(data: $0, filename: "\(name).jpg") }
    }
}
