import Foundation
import Testing
@testable import AgentCore

/// Images an agent shows in a reply as a Markdown image of a file (feature file_read),
/// and the files a link or a tool row opens.
@Suite struct ReplyImageTests {
    private func image(_ block: MarkdownBlock) -> MarkdownImage? {
        if case let .image(image) = block.kind { image } else { nil }
    }

    @Test func anImageOnALineOfItsOwnIsABlockOfItsOwn() throws {
        let blocks = Markdown.blocks("Here it is:\n\n![Sales by month](/tmp/sales.png)\n\nThe rise is in March.")
        #expect(blocks.map(\.id) == [0, 1, 2])
        #expect(blocks[0].plainText == "Here it is:")
        #expect(image(blocks[1]) == MarkdownImage(path: "/tmp/sales.png", caption: "Sales by month"))
        #expect(blocks[1].text.characters.isEmpty)
        #expect(blocks[2].plainText == "The rise is in March.")
    }

    @Test func anImageInAParagraphCutsItInThree() throws {
        let blocks = Markdown.blocks("See ![the plot](out/plot.png) for the **shape**.")
        #expect(blocks.count == 3)
        #expect(blocks[0].plainText == "See")
        #expect(image(blocks[1]) == MarkdownImage(path: "out/plot.png", caption: "the plot"))
        #expect(blocks[2].plainText == "for the shape.")
        // Two on following lines: one block each, nothing between them.
        let two = Markdown.blocks("![a](/a.png)\n![b](/b.png)")
        #expect(two.compactMap(image) == [MarkdownImage(path: "/a.png", caption: "a"), MarkdownImage(path: "/b.png", caption: "b")])
        #expect(two.count == 2)
    }

    @Test func aPathWithSpacesBetweenAngleBracketsAndNoCaption() throws {
        let blocks = Markdown.blocks("![](</tmp/my chart.png>)")
        #expect(blocks.count == 1)
        #expect(image(blocks[0]) == MarkdownImage(path: "/tmp/my chart.png"))
        #expect(image(blocks[0])?.name == "[Image]")
        #expect(Markdown.blocks("![x](file:///tmp/a%20b.png)").compactMap(image) == [MarkdownImage(path: "/tmp/a b.png", caption: "x")])
    }

    @Test func aRemoteImageIsALinkAndNeverLoaded() throws {
        let blocks = Markdown.blocks("![Logo](https://example.com/logo.png)")
        #expect(blocks.map(\.kind) == [.paragraph])
        #expect(blocks[0].plainText == "Logo")
        #expect(blocks[0].text.runs.first?.link == URL(string: "https://example.com/logo.png"))
        #expect(blocks[0].text.runs.allSatisfy { $0.imageURL == nil })
    }

    @Test func anImageInAListOrAQuoteIsALinkThatOpensIt() throws {
        let blocks = Markdown.blocks("- the chart: ![chart](/w/chart.png)\n- ![](/w/two.png)")
        #expect(blocks.count == 2)
        let link = try #require(blocks[0].text.runs.compactMap(\.link).first)
        #expect(FileLocation(link: link) == FileLocation(path: "/w/chart.png", purpose: .image))
        // No caption: the file's name.
        #expect(blocks[1].plainText == "two.png")
        let quote = Markdown.blocks("> ![q](/w/q.png)")
        #expect(quote.map(\.kind) == [.quote])
        #expect(quote[0].text.runs.contains { $0.link?.scheme == MarkdownImage.linkScheme })
    }

    @Test func copiedTextNamesTheImage() {
        #expect(Markdown.plainText("Look:\n\n![Sales](/tmp/s.png)") == "Look:\n\n[Image: Sales]")
    }

    @Test func aStreamedReplyShowsTheImageOnceItsMarkdownIsWhole() {
        let whole = "Made it.\n\n![The chart](/tmp/chart.png)\n\nThat is all."
        var stream = MarkdownStream()
        var seen: [[MarkdownBlock]] = []
        for end in stride(from: 1, through: whole.count, by: 3) + [whole.count] {
            let text = String(whole.prefix(end))
            let blocks = stream.blocks(text)
            #expect(blocks == Markdown.blocks(text))
            seen.append(blocks)
        }
        // Half written, it is text; whole, an image.
        #expect(Markdown.blocks("![The chart](/tmp/ch").contains { image($0) == nil })
        #expect(seen.last?.compactMap(image) == [MarkdownImage(path: "/tmp/chart.png", caption: "The chart")])
    }

    @Test func aLinkToAFileOpensIt() throws {
        #expect(FileLocation(link: try #require(URL(string: "src/main.ts:12"))) == FileLocation(path: "src/main.ts", line: 12))
        #expect(FileLocation(link: try #require(URL(string: "src/main.ts:12:4"))) == FileLocation(path: "src/main.ts", line: 12))
        #expect(FileLocation(link: try #require(URL(string: "file:///w/a.swift#L5"))) == FileLocation(path: "/w/a.swift", line: 5))
        #expect(FileLocation(link: try #require(URL(string: "/w/README.md"))) == FileLocation(path: "/w/README.md"))
        #expect(FileLocation(link: try #require(URL(string: "https://example.com/a.ts"))) == nil)
        #expect(FileLocation(link: try #require(URL(string: "mailto:a@b.c"))) == nil)
        #expect(FileLocation(link: try #require(URL(string: "#usage"))) == nil)
        // A file at the folder's top with its line, which a URL reads as a scheme.
        #expect(FileLocation(link: try #require(URL(string: "README.md:12"))) == FileLocation(path: "README.md", line: 12))
        #expect(FileLocation(link: try #require(URL(string: "Package.swift:40:3"))) == FileLocation(path: "Package.swift", line: 40))
        #expect(FileLocation(link: try #require(URL(string: "tel:12345"))) == nil)
        #expect(FileLocation(link: try #require(URL(string: "com.example.app:/callback"))) == nil)
        let image = try #require(MarkdownImage(path: "/tmp/a b.png").linkURL)
        #expect(FileLocation(link: image) == FileLocation(path: "/tmp/a b.png", purpose: .image))
    }

    @Test func aToolRowOpensItsFileAtTheFirstLineItChanged() {
        let edit = ToolRun(id: "e", name: "patch", diff: "--- a/x.ts\n+++ b/x.ts\n@@ -10,3 +12,4 @@\n-a\n+b", path: "/w/x.ts")
        #expect(edit.fileLocation == FileLocation(path: "/w/x.ts", line: 12))
        #expect(ToolRun(id: "r", name: "read_file", path: "src/a.ts").fileLocation == FileLocation(path: "src/a.ts"))
        // A read of part of the file, where it began; an edit's own line comes first.
        #expect(ToolRun(id: "o", name: "read_file", path: "src/a.ts", startLine: 120).fileLocation == FileLocation(path: "src/a.ts", line: 120))
        #expect(ToolRun(id: "b", name: "patch", diff: "@@ -1 +7 @@\n-a\n+b", path: "src/a.ts", startLine: 120).fileLocation == FileLocation(path: "src/a.ts", line: 7))
        #expect(ToolRun(id: "t", name: "terminal", label: "ls").fileLocation == nil)
        #expect(ToolRun.firstChangedLine("@@ -0,0 +1,3 @@\n+a") == 1)
    }

    @Test func aFilesEncodedHashIsNotItsLinksFragment() throws {
        for address in ["src/a%23b.swift", "file:///w/a%23b.swift"] {
            let path = address.hasPrefix("file:") ? "/w/a#b.swift" : "src/a#b.swift"
            #expect(FileLocation(link: try #require(URL(string: address))) == FileLocation(path: path))
            #expect(FileLocation(link: try #require(URL(string: address + "#L12"))) == FileLocation(path: path, line: 12))
        }
        #expect(FileLocation(link: try #require(URL(string: "src/a%23b.swift:7"))) == FileLocation(path: "src/a#b.swift", line: 7))
        #expect(FileLocation(link: try #require(URL(string: "#L12"))) == nil)
    }
}
