import AgentCore
import SwiftUI
import UIKit

/// The thought the agent streams, in three lines under the status line, when "Show
/// thinking" is on (2026-10-20: one line was too fast to read; three lines, without
/// the chat jumping around). The room is three lines tall from the first thought of the
/// work under way, and stays so until the agent says something: between thoughts, while a
/// tool call runs, it is empty rather than gone, so the chat does not move at each step. A
/// thought's words come in at the even pace `ThoughtPace` gives, a word at a time, in the
/// footnote size and the secondary colour; when they take a new line, the lines slide up
/// and the oldest goes out at the top. A thought ends faded out; the next starts the room
/// anew. Nothing runs between pieces, off screen or in the background; with Reduce Motion
/// nothing slides, and the newest words are put in place at most once a second. VoiceOver
/// passes over it: the whole thought is read in the status line opened.
struct ThoughtWindow: UIViewRepresentable {
    /// The thought streaming now; nil between thoughts, when the room stays, empty.
    let reasoning: Reasoning?
    /// Its item's id: each thought starts the room anew.
    let id: UUID?
    /// The bold titles a GPT model opens each part of its thought with are left out: the
    /// status line above says the newest (`StatusHeadline`; 2026-10-26.
    var dropsTitles = false

    /// The setting's key (Settings, "Show thinking while agents work"), off by default.
    static let settingKey = "chat.showsThinking"
    /// How many lines the room is tall.
    static let lines = 3

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Its chat is kept out of sight behind the one on screen (`ChatScreen.isShown`).
    @Environment(\.isOutOfSight) private var isOutOfSight

    func makeUIView(context: Context) -> ThoughtWindowView {
        ThoughtWindowView(font: Self.font(at: dynamicTypeSize))
    }

    func updateUIView(_ view: ThoughtWindowView, context: Context) {
        view.reducesMotion = reduceMotion
        view.font = Self.font(at: dynamicTypeSize)
        view.isOutOfSight = isOutOfSight
        view.dropsTitles = dropsTitles
        view.show(reasoning, id: id)
    }

    /// As wide as it is offered, three lines of its type tall, whatever it shows.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: ThoughtWindowView, context: Context) -> CGSize? {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 0
        return CGSize(width: width, height: view.roomHeight)
    }

    static func dismantleUIView(_ view: ThoughtWindowView, coordinator: ()) {
        view.stop()
    }

    /// The footnote size as a UIKit font, at the reader's text size.
    static func font(at size: DynamicTypeSize) -> UIFont {
        if let points = AppTextStyles.fixedSize(of: .footnote) { return .systemFont(ofSize: points) }
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
        return .preferredFont(forTextStyle: .footnote, compatibleWith: traits)
    }
}

/// The view under `ThoughtWindow`: a label holding the thought's newest words, wrapped,
/// filling the room from the top, then its last line kept at the bottom of the room; what
/// is above the room is cut, faded at the top. Words are put in as the pace reaches them, from a display link that runs only
/// while words are still to come.
final class ThoughtWindowView: UIView {
    /// Reduce Motion: nothing slides, words are put in place calmly.
    var reducesMotion = false
    /// Titles are left out of the words, from the next thought on (`ThoughtLine.dropsTitles`).
    var dropsTitles = false
    /// Its chat is kept out of sight behind the one on screen: nothing runs, as off screen,
    /// and the words are put in place as it comes back.
    var isOutOfSight = false {
        didSet {
            guard isOutOfSight != oldValue else { return }
            if isOutOfSight {
                stopLink()
                calmWait?.cancel()
                calmWait = nil
            } else if shownID != nil {
                pace.settle(line.total, at: CACurrentMediaTime())
                render(upTo: Double(line.total), sliding: false)
            }
        }
    }
    var font: UIFont {
        didSet {
            guard font != oldValue else { return }
            label.font = font
            // The same words, laid out again in the new size.
            setNeedsLayout()
        }
    }

    /// The room: three lines of the type, in points.
    var roomHeight: CGFloat { ceil(font.lineHeight) * CGFloat(ThoughtWindow.lines) }

    private let label = UILabel()
    private let fade = CAGradientLayer()
    private var line = ThoughtLine()
    private var pace = ThoughtPace()
    /// The thought shown, by its item's id.
    private var shownID: UUID?
    /// Whether this thought was looked at yet: one well under way when first drawn shows
    /// its end at once.
    private var started = false
    /// The text in the label, and the words it was cut from.
    private var rendered: String?
    private var renderedWords: String?
    private var link: CADisplayLink?
    /// Reduce Motion: when the words were last put in place, and the putting in place
    /// waiting for its time.
    private var lastCalm: TimeInterval?
    private var calmWait: DispatchWorkItem?

    private static let slideKey = "slide"

    init(font: UIFont) {
        self.font = font
        super.init(frame: .zero)
        // A picture only: taps go to the status line, VoiceOver reads the line.
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        clipsToBounds = true
        label.font = font
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        addSubview(label)
        fade.colors = [UIColor.clear.cgColor, UIColor.black.cgColor, UIColor.black.cgColor]
        fade.startPoint = CGPoint(x: 0.5, y: 0)
        fade.endPoint = CGPoint(x: 0.5, y: 1)
        layer.mask = fade
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The thought as it is now, or none between thoughts.
    func show(_ reasoning: Reasoning?, id: UUID?) {
        guard let reasoning, let id else {
            // Between thoughts: the room stays, its words fade out.
            guard shownID != nil else { return }
            shownID = nil
            stopLink()
            calmWait?.cancel()
            calmWait = nil
            fadeOut()
            return
        }
        if id != shownID {
            // A new thought: from nothing.
            shownID = id
            started = false
            line = ThoughtLine(dropsTitles: dropsTitles)
            pace.reset()
            label.layer.removeAllAnimations()
            label.alpha = 1
            renderedWords = nil
            put("")
        }
        let change = line.read(reasoning.text)
        let now = CACurrentMediaTime()
        if !started {
            started = true
            // A thought well under way when the room is first drawn (a thread opened in the
            // middle of one, the turn made again as it comes back into view) shows its end
            // at once, as a reply does.
            if Date.now.timeIntervalSince(reasoning.startedAt) > 1 {
                pace.settle(line.total, at: now)
                render(upTo: Double(line.total), sliding: false)
                return
            }
        }
        switch change {
        case .none: return
        case .startedOver: pace.reset()
        case .added: break
        }
        // Out of sight: put in place as it comes back (`isOutOfSight`).
        if isOutOfSight { return }
        if reducesMotion {
            putInPlaceCalmly()
            return
        }
        guard pace.heard(line.total, at: now) != nil else { return }
        startLink()
    }

    /// Stops what is under way: the view is going.
    func stop() {
        stopLink()
        calmWait?.cancel()
        calmWait = nil
        label.layer.removeAllAnimations()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            // Nothing runs off screen; the words are put in place when it is back.
            stopLink()
            calmWait?.cancel()
            calmWait = nil
        } else if shownID != nil {
            pace.settle(line.total, at: CACurrentMediaTime())
            render(upTo: Double(line.total), sliding: false)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = bounds
        CATransaction.commit()
        placeLabel()
    }

    // MARK: Putting words in

    private func startLink() {
        guard link == nil, window != nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        // A word every so often needs no more than this.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick() {
        let now = CACurrentMediaTime()
        let shown = pace.shown(at: now)
        render(upTo: shown, sliding: true)
        if shown >= Double(pace.target) { stopLink() }
    }

    /// Shows the thought up to `shown` characters of it (counted from its start), cut back
    /// to the last whole word while more is still to come.
    private func render(upTo shown: Double, sliding: Bool) {
        let text = line.text
        let before = line.total - text.count
        let reach = min(text.count, max(0, Int(shown.rounded(.down)) - before))
        var upTo = text.prefix(reach)
        if reach < text.count, let space = upTo.lastIndex(of: " ") {
            upTo = upTo[..<space]
        } else if reach < text.count {
            upTo = ""
        }
        put(String(upTo), sliding: sliding)
    }

    /// Puts `words` in the label (only as much as can show, from a word's start), its last
    /// line at the bottom of the room; words that take a new line slide the lines above up.
    private func put(_ words: String, sliding: Bool = false) {
        let kept = trimmed(words)
        guard kept != rendered else { return }
        // How far the words added push the lines up: once the room is full, by what they
        // add below it, the same text without them, from the same start, laid out as it was.
        // Until then the lines fill the room from the top and nothing moves.
        var grown: CGFloat = 0
        if sliding, !reducesMotion, let before = renderedWords, words.count > before.count, words.hasPrefix(before) {
            let added = words.count - before.count
            if kept.count > added {
                let room = bounds.height
                let overflow = { (height: CGFloat) in max(0, height - room) }
                grown = overflow(height(of: kept)) - overflow(height(of: String(kept.dropLast(added))))
            }
        }
        rendered = kept
        renderedWords = words
        UIView.performWithoutAnimation { label.text = kept }
        placeLabel()
        if grown > font.lineHeight / 2 {
            // Drawn where the lines were, then slid up to where they are.
            let slide = CABasicAnimation(keyPath: "position.y")
            slide.isAdditive = true
            slide.fromValue = grown
            slide.toValue = 0
            slide.duration = 0.22
            slide.timingFunction = CAMediaTimingFunction(name: .easeOut)
            label.layer.add(slide, forKey: Self.slideKey)
        }
    }

    /// How tall `text` is, wrapped in the room's width.
    private func height(of text: String) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        let box = (text as NSString).boundingRect(
            with: CGSize(width: max(bounds.width, 1), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil
        )
        return ceil(box.height)
    }

    /// The words' end, as much as a few more lines than the room holds, from a word's
    /// start: the label never lays out more than can be seen.
    private func trimmed(_ words: String) -> String {
        let perLine = max(20, Int(max(bounds.width, 200) / (font.pointSize * 0.45)))
        let most = perLine * (ThoughtWindow.lines + 2)
        guard words.count > most else { return words }
        let end = words.suffix(most)
        guard let space = end.firstIndex(of: " ") else { return String(end) }
        return String(end[end.index(after: space)...])
    }

    /// The label as wide as the room, as tall as its words: at the room's top while they
    /// fit in it (the first line on the first row), its bottom at the room's once they do
    /// not (2026-10-20: "dont start streaming from the 3rd line").
    private func placeLabel() {
        let width = max(bounds.width, 1)
        let height = (rendered ?? "").isEmpty ? 0 : ceil(label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
        UIView.performWithoutAnimation {
            label.frame = CGRect(x: 0, y: min(0, bounds.height - height), width: width, height: height)
        }
        // Once the lines go out at the top, the top line's upper part fades, so a line going
        // out does not end at a hard edge; until then the first line is whole.
        let fadeTo = height > bounds.height ? min(0.3, ceil(font.lineHeight) * 0.35 / max(bounds.height, 1)) : 0
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.locations = [0, NSNumber(value: Double(fadeTo)), 1]
        CATransaction.commit()
    }

    private func fadeOut() {
        UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState]) {
            self.label.alpha = 0
        } completion: { [weak self] _ in
            guard let self, self.shownID == nil else { return }
            self.renderedWords = nil
            self.put("")
            self.label.alpha = 1
        }
    }

    /// Reduce Motion: the newest words put in place, at most once every `ThoughtPace.calm`.
    private func putInPlaceCalmly() {
        let now = CACurrentMediaTime()
        let wait = ThoughtPace.calmDelay(since: lastCalm, at: now)
        guard wait <= 0 else {
            guard calmWait == nil, window != nil else { return }
            let work = DispatchWorkItem { [weak self] in
                self?.calmWait = nil
                self?.putInPlaceCalmly()
            }
            calmWait = work
            DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
            return
        }
        lastCalm = now
        pace.settle(line.total, at: now)
        render(upTo: Double(line.total), sliding: false)
    }
}
