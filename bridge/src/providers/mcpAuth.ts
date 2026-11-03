import { SettingRefused } from "./types.ts";

export const mcpAuthDeadlineMs = 10 * 60_000;

export class McpAuthSettling extends SettingRefused {
  constructor() { super("Droid is still ending the previous sign-in. Try again shortly."); }
}

/** Live sign-in state only. Never add these fields to a stored thread or transcript. */
export interface McpAuthCard {
  auth_id: string;
  server_name: string;
  status: "required" | "starting" | "waiting" | "completed" | "cancelled" | "failed";
  url?: string;
}

export interface McpAuthAction {
  action: "list" | "start" | "submit" | "cancel";
  server_name?: string;
  auth_id?: string;
  code?: string;
}
