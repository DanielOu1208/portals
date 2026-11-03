// pointer-sweep <x> <y> <width> <height> <seconds> [moves a second]: moves the REAL pointer
// up and down over a rectangle of the screen (global points, top-left origin), as a hand
// going over a list would: down and back up every 2 s, drifting from side to side, 120
// moves a second unless told. Puts the pointer back where it was at the end, and prints how
// many moves it made. Part of scripts/tabs-bench.sh's hover scenario, which runs it only
// with HOVER_OK=1: the pointer is the user's, and an event goes to whatever is under it.
import CoreGraphics
import Foundation

let numbers = CommandLine.arguments.dropFirst().compactMap(Double.init)
guard numbers.count >= 5 else {
    print("usage: pointer-sweep <x> <y> <width> <height> <seconds> [moves a second]")
    exit(2)
}
let area = CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
let seconds = numbers[4]
let rate = numbers.count > 5 ? numbers[5] : 120
let start = CGEvent(source: nil)?.location ?? CGPoint(x: area.midX, y: area.midY)

func move(to point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

let began = Date()
var moves = 0
while true {
    let time = Date().timeIntervalSince(began)
    if time >= seconds { break }
    // Down the area in 1 s and back up in the next, across it a little each way.
    let phase = time.truncatingRemainder(dividingBy: 2) / 2
    let down = phase < 0.5 ? phase * 2 : 2 - phase * 2
    let across = 0.5 + 0.4 * sin(time * 1.3)
    move(to: CGPoint(x: area.minX + area.width * across, y: area.minY + area.height * down))
    moves += 1
    usleep(useconds_t(1_000_000 / rate))
}
move(to: start)
print(moves)
