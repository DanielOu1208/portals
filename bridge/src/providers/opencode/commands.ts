import type { AgentCommand, Prompt } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";
import type { SkillInfo } from "./protocol.ts";

/** How long a message that names a skill waits for OpenCode's skills at most, before it goes without. */
const sendSkillsDeadline = 2000;

export type AdmissionKind = "prompt" | "compact" | "command";
interface Admission {
  id: string;
  current(kind: AdmissionKind): Promise<boolean>;
  /** Stop aborts it: a message still waiting for its skills is not sent. */
  signal?: AbortSignal;
}

export function commandCatalog(commands: { name: string; description?: string }[], select: (argument: string) => Promise<string>): AgentCommand[] {
  return [
    { name: "agent", description: "Show or select OpenCode's primary agent", usage: "[id]", skill: false, requiresWritable: true, execute: select },
    { name: "compact", description: "Summarize this conversation to free context", usage: "", skill: false },
    ...commands.filter((command) => command.name !== "agent" && command.name !== "compact").map((command) => ({ name: command.name, description: command.description || `Run OpenCode's /${command.name} command`, usage: "", skill: false })),
  ];
}

/**
 * OpenCode's skills as the app's commands. Left out: a name the app cannot send (`/name`
 * goes to the bridge lower cased, and is read up to the first space or second slash), and
 * one `taken`, a command of OpenCode's or the bridge's, already offers.
 */
export function skillCommands(skills: readonly SkillInfo[], taken: readonly string[]): AgentCommand[] {
  const seen = new Set(taken);
  return skills.flatMap((skill): AgentCommand[] => {
    const name = skill.name;
    if (typeof name !== "string" || name === "" || name !== name.toLowerCase() || /[\s/]/.test(name) || seen.has(name)) return [];
    seen.add(name);
    return [{ name, description: skill.description || "A skill of yours", usage: "[instructions]", skill: true }];
  });
}

/** The skill a message runs ("/name …"), when its first word names one. */
export function skillIn(text: string, skills: readonly SkillInfo[]): SkillInfo | null {
  const name = /^\/([^\s/]+)(\s|$)/.exec(text.trim())?.[1];
  return (name && skills.find((skill) => skill.name === name)) || null;
}

/**
 * A message whose first word is "/name": a command of OpenCode's, a skill, or words, as
 * `submit` finds when it sends it.
 */
export function slashed(text: string): boolean {
  return /^\/[^\s/]+(\s|$)/.test(text.trim());
}

/** Dedicated APIs run commands; ordinary slash-prefixed text remains a message. */
export async function submit(api: OpenCodeApi, id: string, directory: string, prompt: Prompt, files: { uri: string; name: string }[], admission?: Admission): Promise<{ id: string } | undefined> {
  const command = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(prompt.text.trim());
  if (command && prompt.images.length === 0 && !prompt.files?.length && command[1] === "compact") {
    if (command[2]?.trim()) throw new Error("OpenCode's /compact takes no extra instructions. Send /compact by itself.");
    if (admission && !await admission.current("compact")) return;
    return api.compact(id, admission?.id);
  }
  if (command && (await api.commands(directory)).some((entry) => entry.name === command[1])) {
    if (admission && !await admission.current("command")) return;
    await api.command(id, command[1], command[2] ?? "", files);
    return undefined;
  }
  // A skill is a message OpenCode runs with it, attached as its own input, as its own
  // apps send a skill picked from a menu.
  const skill = command ? skillIn(prompt.text, await api.skills(directory, admission?.signal, sendSkillsDeadline)) : null;
  if (admission && !await admission.current("prompt")) return;
  return api.prompt(id, prompt.text, files, { ...(admission ? { id: admission.id } : {}), ...(skill ? { skills: [{ id: skill.id, name: skill.name }] } : {}) });
}
