import fs from "node:fs";
import { dirname, join } from "node:path";
import type { ServiceSpec } from "./service.ts";

/** A changed definition is kept reversible until its service has restarted. */
export interface DefinitionUpdate {
  changed: boolean;
  commit(): void;
  rollback(): Promise<void>;
}

/** A custom definition the current template cannot safely round-trip. Leave it alone. */
export class UnsupportedServiceDefinition extends Error {}

/** Do not erase custom directives that setup's current template does not know. */
export function checkDefinitionFields(before: string, next: string, format: "plist" | "unit"): void {
  const fields = (text: string): string[] => {
    if (format === "plist") return plistFields(readPlist(text));
    let section = "";
    return text.split("\n").flatMap((raw) => {
      const line = raw.trim();
      if (/^\[.*\]$/.test(line)) section = line;
      const key = /^([A-Za-z][A-Za-z0-9]*)\s*=/.exec(line)?.[1];
      return key ? [`${section} ${key}`] : [];
    });
  };
  const supported = new Set(fields(next));
  if (fields(before).some((key) => !supported.has(key))) throw new UnsupportedServiceDefinition("the service definition has custom directives");
}

/**
 * Replace in the same folder, atomically. A failed write never cuts the old file
 * short. Keep its exact bytes and mode until restart succeeds; on recovery failure
 * leave the backup in place rather than lose the last working definition.
 */
export async function replaceDefinition(file: string, next: string, reload: () => Promise<void> = async () => {}): Promise<DefinitionUpdate> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new UnsupportedServiceDefinition("the service definition is not a plain file");
  const before = fs.readFileSync(file, "utf8");
  if (before === next) return { changed: false, commit() {}, async rollback() {} };
  const folder = fs.mkdtempSync(join(dirname(file), ".portals-service-update-"));
  const backup = join(folder, "previous");
  const staged = join(folder, "next");
  const clean = () => fs.rmSync(folder, { recursive: true, force: true });
  let replaced = false;
  const restore = async () => {
    if (replaced) {
      fs.writeFileSync(staged, before, { mode: stat.mode & 0o777 });
      fs.chmodSync(staged, stat.mode & 0o777);
      fs.renameSync(staged, file);
      await reload();
      replaced = false;
    }
    clean();
  };
  const rollback = async () => {
    try {
      await restore();
    } catch (error) {
      throw new Error(`Could not restore the service definition; its backup is ${backup}: ${(error as Error).message}`, { cause: error });
    }
  };
  try {
    fs.writeFileSync(backup, before, { mode: stat.mode & 0o777 });
    fs.writeFileSync(staged, next, { mode: stat.mode & 0o777 });
    fs.chmodSync(staged, stat.mode & 0o777);
    fs.renameSync(staged, file);
    replaced = true;
    await reload();
  } catch (error) {
    try {
      await rollback();
    } catch (recovery) {
      throw new AggregateError([error, recovery], (recovery as Error).message);
    }
    throw error;
  }
  return { changed: true, commit: clean, rollback };
}

function unxml(value: string): string {
  const entityPattern = /&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
  if (value.replace(entityPattern, "").includes("&")) throw new UnsupportedServiceDefinition("the service plist has an unsupported XML entity");
  return value.replace(entityPattern, (_whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity];
  });
}

type PlistValue = string | number | boolean | PlistValue[] | PlistDictionary;
interface PlistDictionary { [key: string]: PlistValue }

function dictionary(value: PlistValue): value is PlistDictionary {
  return typeof value === "object" && !Array.isArray(value);
}

/** Only the XML subset setup writes. Other syntax is custom, so update leaves it alone. */
function readPlist(text: string): PlistDictionary {
  const body = /^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<plist version="1\.0">([\s\S]*)<\/plist>\s*$/.exec(text)?.[1];
  const tokens = body?.match(/<key>[^<]*<\/key>|<string>[^<]*<\/string>|<integer>-?\d+<\/integer>|<(?:true|false)\/>|<\/?(?:dict|array)>|\S+/g) ?? [];
  let at = 0;
  const unsupported = () => new UnsupportedServiceDefinition("the service plist has unsupported XML");
  const read = (): PlistValue => {
    const token = tokens[at++];
    if (token === "<dict>") {
      const entries = new Map<string, PlistValue>();
      while (tokens[at] !== "</dict>") {
        const key = /^<key>([^<]*)<\/key>$/.exec(tokens[at++] ?? "")?.[1];
        if (key === undefined || entries.has(unxml(key))) throw unsupported();
        entries.set(unxml(key), read());
      }
      at++;
      return Object.fromEntries(entries);
    }
    if (token === "<array>") {
      const values: PlistValue[] = [];
      while (tokens[at] !== "</array>") values.push(read());
      at++;
      return values;
    }
    if (token === "<true/>") return true;
    if (token === "<false/>") return false;
    const string = /^<string>([^<]*)<\/string>$/.exec(token ?? "")?.[1];
    if (string !== undefined) return unxml(string);
    const integer = /^<integer>(-?\d+)<\/integer>$/.exec(token ?? "")?.[1];
    if (integer !== undefined) return Number(integer);
    throw unsupported();
  };
  const value = read();
  if (!dictionary(value) || at !== tokens.length) throw unsupported();
  return value;
}

function plistFields(value: PlistValue, path: string[] = []): string[] {
  const kind = Array.isArray(value) ? "array" : typeof value;
  const fields = [`${JSON.stringify(path)} ${kind}`];
  if (dictionary(value)) {
    for (const [key, child] of Object.entries(value)) fields.push(...plistFields(child, [...path, key]));
  } else if (Array.isArray(value)) {
    for (const child of value) fields.push(...plistFields(child, path));
  }
  return fields;
}

/** Read setup's string-valued plist fields, not values from the updating shell. */
export function specFromPlist(text: string, label: string): ServiceSpec {
  const fields = readPlist(text);
  const string = (key: string) => {
    const value = fields[key];
    if (typeof value !== "string") throw new UnsupportedServiceDefinition(`the service plist has no string for ${key}`);
    return value;
  };
  if (string("Label") !== label) throw new UnsupportedServiceDefinition("the service plist names another label");
  const args = fields.ProgramArguments;
  if (!Array.isArray(args) || args.length !== 2 || args.some((value) => typeof value !== "string")) throw new UnsupportedServiceDefinition("the service plist has an unsupported command");
  const dict = fields.EnvironmentVariables;
  if (!dict || !dictionary(dict) || Object.values(dict).some((value) => typeof value !== "string")) throw new UnsupportedServiceDefinition("the service plist has unsupported environment values");
  const environment = { ...dict } as Record<string, string>;
  const path = environment.PATH;
  if (path === undefined) throw new UnsupportedServiceDefinition("the service plist has no PATH");
  delete environment.PATH;
  const log = string("StandardOutPath");
  if (string("StandardErrorPath") !== log) throw new UnsupportedServiceDefinition("the service plist uses separate output logs");
  return { label, node: args[0] as string, script: args[1] as string, workingDirectory: string("WorkingDirectory"), path, log, environment };
}

function unspecify(value: string): string {
  if (value.replace(/%%/g, "").includes("%")) throw new UnsupportedServiceDefinition("the service unit uses systemd specifiers");
  return value.replace(/%%/g, "%");
}

/** The quoted words setup writes; unsupported custom syntax is left alone, never guessed. */
function words(value: string): string[] {
  const word = /"((?:[^"\\]|\\["\\])*)"/g;
  const found = [...value.matchAll(word)];
  if (value.replace(word, "").trim()) throw new UnsupportedServiceDefinition("the service unit has unsupported quoting");
  return found.map((match) => unspecify(match[1].replace(/\\(["\\])/g, "$1")));
}

export function specFromUnit(text: string, label: string): ServiceSpec {
  const fields = new Map<string, string[]>();
  let service = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { service = line === "[Service]"; continue; }
    if (!service || !line || /^\s*[#;]/.test(line)) continue;
    const at = line.indexOf("=");
    if (at < 1) throw new UnsupportedServiceDefinition("the service unit has an unsupported line");
    const key = line.slice(0, at).trim();
    fields.set(key, [...(fields.get(key) ?? []), line.slice(at + 1).trim()]);
  }
  const one = (key: string) => {
    const values = fields.get(key);
    if (values?.length !== 1) throw new UnsupportedServiceDefinition(`the service unit must have one ${key}`);
    return values[0];
  };
  const exec = one("ExecStart");
  const args = exec.startsWith(":") ? words(exec.slice(1)) : [];
  if (args.length !== 2) throw new UnsupportedServiceDefinition("the service unit has an unsupported command");
  const environment = Object.fromEntries((fields.get("Environment") ?? []).flatMap(words).map((value) => {
    const at = value.indexOf("=");
    if (at < 1) throw new UnsupportedServiceDefinition("the service unit has an invalid environment value");
    return [value.slice(0, at), value.slice(at + 1)];
  }));
  if (fields.get("Environment")?.some((value) => !value.trim())) throw new UnsupportedServiceDefinition("the service unit resets its environment");
  const path = environment.PATH;
  if (path === undefined) throw new UnsupportedServiceDefinition("the service unit has no PATH");
  delete environment.PATH;
  const out = one("StandardOutput");
  if (!out.startsWith("append:") || one("StandardError") !== out) throw new UnsupportedServiceDefinition("the service unit has unsupported output logs");
  return { label, node: args[0], script: args[1], workingDirectory: unspecify(one("WorkingDirectory")), path, log: unspecify(out.slice(7)), environment };
}
