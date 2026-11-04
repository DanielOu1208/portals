import type { AgentCommand } from "../types.ts";
import type { CodexCalls } from "./session.ts";

// Codex's skills in the app's slash menu. Codex lists them for a folder (`skills/list`:
// the folder's own, the user's, and those Codex comes with), and a message runs one when
// it carries the skill as an input of its own (`{type: "skill", name, path}`) beside its
// text, as Codex's own apps send a skill picked from their menus. The app sends a skill as
// the message "/name what to do", which goes to Codex as it is, with the skill beside it.

/** One skill as `skills/list` gives it (0.166; the copied types are older and have no `skills/list`). */
interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: { shortDescription?: string } | null;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
}

interface SkillsListResponse {
  data: { cwd: string; skills: SkillMetadata[]; errors: unknown[] }[];
}

/** How long the menu waits for Codex to list them: it has them cached, and the menu does without. */
const listTimeoutMs = 5_000;

/**
 * The skills Codex would use in `cwd`, those turned off left out. Without a folder (an
 * agent's menu before a thread has one), only those that are not a folder's own.
 */
export async function listSkills(client: Pick<CodexCalls, "call">, cwd?: string): Promise<SkillMetadata[]> {
  const response: SkillsListResponse = await client.call("skills/list", cwd ? { cwds: [cwd] } : {}, listTimeoutMs);
  const skills = (response?.data ?? []).flatMap((entry) => (Array.isArray(entry?.skills) ? entry.skills : []));
  return skills.filter((skill) => skill?.enabled !== false && typeof skill?.name === "string" && typeof skill.path === "string" && (cwd || skill.scope !== "repo"));
}

/**
 * The skills as the app's commands. Left out: a name the app cannot send (it sends names
 * in lower case, and reads a name up to the first space or second slash), one listed
 * twice (a folder's own first, as Codex lists it), and one in `taken`, Codex's commands
 * the bridge carries out.
 */
export function skillCommands(skills: readonly SkillMetadata[], taken: readonly string[]): AgentCommand[] {
  const seen = new Set(taken);
  return skills.flatMap((skill): AgentCommand[] => {
    const name = skill.name;
    if (name === "" || name !== name.toLowerCase() || /[\s/]/.test(name) || seen.has(name)) return [];
    seen.add(name);
    const description = skill.interface?.shortDescription || skill.shortDescription || skill.description || "";
    return [{ name, description: typeof description === "string" ? description : "", usage: "", skill: true }];
  });
}

/** The skill a message runs ("/name …"), when its first word names one of `skills`. */
export function skillIn(text: string, skills: readonly SkillMetadata[]): { name: string; path: string } | null {
  const name = /^\/([^\s/]+)(\s|$)/.exec(text.trim())?.[1];
  const skill = name ? skills.find((entry) => entry.name === name) : undefined;
  return skill ? { name: skill.name, path: skill.path } : null;
}
