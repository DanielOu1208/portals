import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { readHidden } from "./ui.ts";

// The sign-in password. Setup makes one nobody has to type (the phone gets it from the
// pairing QR code), keeps it in `password.txt` so `portals-host pair` can show it
// again, and puts only its hash in config.json (`hashPassword`, src/http/auth.ts).

/** 32 random characters, letters, digits, `-` and `_` (192 bits). */
export function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Writes the password with no newline after it (a pasted newline fails the sign-in), owner only. */
export function savePassword(path: string, password: string): void {
  writeFileSync(path, password, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The saved password, or null when there is none. */
export function readSavedPassword(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * A password from `$PORTALS_PASSWORD` (as the probe reads it; `$AERIPORTAL_PASSWORD`, its
 * name before the rename, too), else from standard input: typed without echo at a terminal
 * (the prompt on standard error), or piped.
 */
export async function readPassword(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnvironment = env.PORTALS_PASSWORD || env.AERIPORTAL_PASSWORD;
  if (fromEnvironment) return fromEnvironment;
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  return readHidden("Password: ", process.stderr);
}
