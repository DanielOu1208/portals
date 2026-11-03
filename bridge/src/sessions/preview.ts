import { basename } from "node:path";
import { withoutFromLine } from "../fleet/line.ts";
import type { StoredMessage } from "../providers/types.ts";
import { splitFiles } from "./files.ts";

// A thread's preview: the line under its title in every device's list (feature
// thread_sync). Worded as the app words its own (ThreadController.preview): the first
// line of the last message sent into the thread (one that opened a turn, or was handed
// to the running one), at most 140 characters, or "Image" for a message of images
// alone. A message sent through the fleet is shown without the line that says who it is
// from, and a line of nothing but spaces is passed over, which the app is to do too
// (docs/sync-plan.md, Previews).

const longest = 140;
const segmenter = new Intl.Segmenter();

/**
 * The preview of a message as stored (`storedUserText`: its text with the paths of any
 * files after it, then an `@image:` line per image); undefined for an empty one. A
 * message of attachments alone is "Image", "3 images", the file's name, "2 files", or
 * "3 attachments" for both.
 */
export function previewOf(stored: string): string | undefined {
  const lines = withoutFromLine(stored).split("\n");
  const images = lines.filter((line) => line.startsWith("@image:")).length;
  const { text, paths } = splitFiles(lines.filter((line) => !line.startsWith("@image:")).join("\n"));
  const first = text.split(/[\r\n\v\f\u0085\u2028\u2029]/).find((line) => line.trim() !== "");
  if (first === undefined) {
    if (images > 0 && paths.length > 0) return `${images + paths.length} attachments`;
    if (paths.length > 0) return paths.length === 1 ? basename(paths[0]) : `${paths.length} files`;
    if (images === 0) return undefined;
    return images === 1 ? "Image" : `${images} images`;
  }
  // By characters as a person sees them, as Swift counts: an emoji is never cut in two.
  if (first.length <= longest) return first;
  return Array.from(segmenter.segment(first), (piece) => piece.segment)
    .slice(0, longest)
    .join("");
}

/**
 * The preview of a conversation: of its last message that the person, a device or the
 * fleet said. The lines an agent opens its own turns with are not one (`display_kind`
 * other than a steered message's), nor is a message with nothing to show.
 */
export function lastPreview(messages: readonly StoredMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (message.display_kind !== undefined && message.display_kind !== "steer" && message.display_kind !== "skill_invocation") continue;
    const preview = previewOf(message.text);
    if (preview) return preview;
  }
  return undefined;
}
