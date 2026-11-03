import { readFileSync } from "node:fs";

/** The bridge's version, from package.json. */
export const version: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
