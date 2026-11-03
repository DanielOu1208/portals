import { basename } from "node:path";
import { withoutFromLine } from "../fleet/line.ts";
import { cutWhole } from "../json.ts";
import { splitFiles } from "../sessions/files.ts";

const titleLength = 80;

/**
 * What a message says, for a title: a message sent through Portals is titled by what it
 * says, not by who sent it; nor by the list of files the bridge put after it.
 */
function whatItSays(text: string): { text: string; paths: string[] } {
  return splitFiles(withoutFromLine(text));
}

/** What a message says, for an agent asked to title it: without the lines `titleFrom` passes over. */
export function titleSource(text: string): string {
  return whatItSays(text)
    .text.split("\n")
    .filter((line) => !line.trim().startsWith("@image:"))
    .join("\n")
    .trim();
}

/**
 * A new thread's title from its first message, for an agent that gives none: its first
 * line, cut short. A message of files alone is titled by the first file's name.
 */
export function titleFrom(text: string): string | null {
  const { text: said, paths } = whatItSays(text);
  const line = said.split("\n").map((part) => part.trim()).find((part) => part !== "" && !part.startsWith("@image:")) ?? (paths[0] ? basename(paths[0]) : undefined);
  if (!line) return null;
  // Not in the middle of an emoji, whose half the app cannot read (json.ts).
  return line.length > titleLength ? `${cutWhole(line, titleLength - 1).trimEnd()}…` : line;
}
