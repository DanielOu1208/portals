import type { AgentCommand, Prompt } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";

export type AdmissionKind = "prompt" | "compact" | "command";
interface Admission {
  id: string;
  current(kind: AdmissionKind): Promise<boolean>;
}

export function commandCatalog(commands: { name: string; description?: string }[], select: (argument: string) => Promise<string>): AgentCommand[] {
  return [
    { name: "agent", description: "Show or select OpenCode's primary agent", usage: "[id]", skill: false, requiresWritable: true, execute: select },
    { name: "compact", description: "Summarize this conversation to free context", usage: "", skill: false },
    ...commands.filter((command) => command.name !== "agent" && command.name !== "compact").map((command) => ({ name: command.name, description: command.description || `Run OpenCode's /${command.name} command`, usage: "", skill: false })),
  ];
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
  if (admission && !await admission.current("prompt")) return;
  return api.prompt(id, prompt.text, files, admission ? { id: admission.id } : {});
}
