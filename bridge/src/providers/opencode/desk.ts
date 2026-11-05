import { DeskRefused, type AdoptMode, type DeskAdoption, type DeskSession } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";
import { settingsOf } from "./session.ts";

export async function deskSessions(api: OpenCodeApi, wanted: number): Promise<DeskSession[]> {
  const [sessions, active] = await Promise.all([api.sessions(wanted), api.active()]);
  return Promise.all(sessions.filter((info) => !info.parentID && !info.time.archived && info.location?.directory).map(async (info): Promise<DeskSession> => {
    let state: DeskSession["state"] = "idle";
    if (active.has(info.id)) {
      const [permissions, forms] = await Promise.all([api.pendingPermissions(info.id), api.forms(info.id)]);
      state = permissions.length || forms.length ? "waiting" : "running";
    }
    return { id: info.id, title: info.title?.trim() || "OpenCode session", cwd: info.location!.directory, updated: info.time.updated, state };
  }));
}

export async function adopt(api: OpenCodeApi, id: string, mode: AdoptMode): Promise<DeskAdoption> {
  try {
    let info = await api.session(id);
    if (info.id !== id || info.parentID || info.time.archived || !info.location?.directory) throw new Error("Choose a top-level, non-archived OpenCode session with a working folder.");
    if (mode === "fork") info = await api.fork(id);
    if (!info.location?.directory) throw new Error("OpenCode did not say where this session runs.");
    return { id: info.id, cwd: info.location.directory, title: info.title || null, settings: settingsOf({ model: "", provider: "", reasoningEffort: "" }, info.model) };
  } catch (error) {
    throw new DeskRefused(`OpenCode could not ${mode === "fork" ? "fork" : "open"} this session: ${(error as Error).message}`);
  }
}
