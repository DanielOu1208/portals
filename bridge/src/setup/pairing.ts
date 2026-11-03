import { encode, renderUnicodeCompact } from "uqr";

// The pairing link the app reads (docs/pairing-and-relay.md):
//
//   portals://pair?v=1&url=<address>&user=<user name>&password=<password>&name=<Mac name>
//
// shown as a QR code in the terminal: scanning it with the iPhone's Camera opens
// Portals with the Mac filled in. It holds the password, so it is only ever printed on
// this Mac, never logged or sent anywhere.

export interface Pairing {
  /** The address the phone uses, with scheme and port. */
  url: string;
  user: string;
  password: string;
  /** The Mac's name, shown as the host's name in the app. */
  name?: string;
}

export function pairingLink(pairing: Pairing): string {
  const parts = [["v", "1"], ["url", pairing.url], ["user", pairing.user], ["password", pairing.password]];
  if (pairing.name) parts.push(["name", pairing.name]);
  return "portals://pair?" + parts.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/**
 * `text` as a QR code, two rows of modules to a line. With `color`, each cell sets both
 * its colours (dark on white), so the code reads the same in a light or a dark
 * terminal; without, it is drawn in block characters for a dark one.
 */
export function qrCode(text: string, options: { color: boolean }): string {
  if (!options.color) return renderUnicodeCompact(text, { border: 2 });
  const { data } = encode(text, { border: 2 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    let line = "";
    for (let x = 0; x < data[y].length; x++) {
      const top = data[y][x];
      const bottom = y + 1 < data.length ? data[y + 1][x] : false;
      // The upper half block: its top half in the foreground colour, its bottom half in the background's.
      line += `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m▀`;
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}
