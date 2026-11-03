import { SettingsLevel } from "@factory/droid-sdk/node";
import type { DroidHandle } from "./sdk.ts";
import { SettingRefused } from "../types.ts";

type Change = { kind: "skill" | "server" | "tool"; name: string; server?: string; enabled: boolean };
const usage = 'Use /skills, /skills on|off <name>, /mcp, /mcp tools [server], /mcp on|off <server>, or /mcp tool on|off <server> <tool>. Quote names containing spaces.';
const quote = (value: string) => JSON.stringify(value);
const oneLine = (value: string) => value.replace(/[\r\n\t]/g, " ");

/** Host controls: first describe a Droid-wide change, then accept that exact confirmation for five minutes. */
export class DroidControls {
  private pending: { key: string; at: number } | undefined;

  async run(kind: "skills" | "mcp", argument: string, handle: DroidHandle, now: number): Promise<string> {
    const words = tokens(argument);
    if (words.length === 0) return kind === "skills" ? this.skills(handle) : this.servers(handle);
    if (kind === "mcp" && words[0] === "tools") {
      if (words.length > 2) throw new SettingRefused(usage);
      const tools = await handle.listMcpTools();
      const shown = tools.filter((tool) => !words[1] || tool.serverName === words[1]);
      return ["Droid MCP tools", ...shown.map((tool) => `${quote(tool.serverName)} ${quote(tool.name)}: ${tool.isEnabled ? "on" : "off"}`),
        ...(shown.length ? [] : ["No matching MCP tools."]), usage].join("\n");
    }
    const tool = kind === "mcp" && words[0] === "tool";
    const confirmed = words.length === (tool ? 5 : 3) && words.at(-1) === "confirm";
    if (confirmed) words.pop();
    if (tool) words.shift();
    const action = words.shift();
    if ((action !== "on" && action !== "off") || words.length !== (tool ? 2 : 1)) throw new SettingRefused(usage);
    const change: Change = { kind: kind === "skills" ? "skill" : tool ? "tool" : "server",
      name: words.at(-1)!, ...(tool ? { server: words[0] } : {}), enabled: action === "on" };
    // Lists are read again at confirmation, so a removed or policy-blocked item is never changed.
    if (change.kind === "skill") {
      const { skills } = await handle.listSkills();
      if (!skills.some((skill) => skill.name === change.name)) throw new SettingRefused("Droid did not list that skill.");
    } else {
      const { servers } = await handle.listMcpServers();
      const server = servers.find((server) => server.name === (change.server ?? change.name));
      if (!server) throw new SettingRefused("Droid did not list that MCP server.");
      if (server.isManaged || server.blockedByPolicy) throw new SettingRefused("This MCP server is managed by your organization. Change it in Droid itself.");
      // Droid's server RPC accepts only user scope; tool toggles write the source config with no scope choice.
      if (server.source !== SettingsLevel.User) throw new SettingRefused("This MCP server does not come from your user settings. Change it in Droid itself.");
      if (tool && !(await handle.listMcpTools()).some((item) => item.serverName === change.server && item.name === change.name)) {
        throw new SettingRefused("Droid did not list that MCP tool.");
      }
    }
    const key = JSON.stringify(change);
    const command = kind === "skills" ? `/skills ${action} ${quote(change.name)} confirm`
      : tool ? `/mcp tool ${action} ${quote(change.server!)} ${quote(change.name)} confirm`
      : `/mcp ${action} ${quote(change.name)} confirm`;
    const subject = change.kind === "tool" ? `MCP tool ${quote(change.name)} on ${quote(change.server!)}` : `${change.kind === "skill" ? "skill" : "MCP server"} ${quote(change.name)}`;
    if (!confirmed || this.pending?.key !== key || now - this.pending.at > 5 * 60_000) {
      this.pending = { key, at: now };
      return `This turns the ${subject} ${action} for Droid everywhere: every thread, the Droid CLI and the desktop app. It is not a per-thread setting.\nNothing changed. To confirm within five minutes, send:\n${command}`;
    }
    // Consume before the write: two simultaneous confirmations cannot write twice.
    this.pending = undefined;
    let success: boolean;
    if (change.kind === "skill") {
      ({ success } = await handle.setSkillDisabled({ skillName: change.name, disabled: !change.enabled, settingsLevel: SettingsLevel.User }));
    } else if (change.kind === "server") {
      ({ success } = await handle.toggleMcpServer({ serverName: change.name, enabled: change.enabled, settingsLevel: SettingsLevel.User }));
    } else {
      ({ success } = await handle.toggleMcpTool(change.server!, change.name, change.enabled));
    }
    if (!success) throw new SettingRefused("Droid did not confirm the settings change. Check it in Droid itself before trying again.");
    return `Turned the ${subject} ${action} in Droid's user settings (${change.kind === "skill" ? "~/.factory/settings.json" : "~/.factory/mcp.json"}). This affects Droid everywhere; an already running thread may need to reload its settings.`;
  }

  private async skills(handle: DroidHandle): Promise<string> {
    const { skills } = await handle.listSkills();
    return ["Droid skills", ...skills.map((skill) =>
      `${quote(skill.name)}: ${skill.enabled === false ? "off" : "on"} (${skill.location})${skill.description ? `, ${oneLine(skill.description)}` : ""}`),
    ...(skills.length ? [] : ["No skills available."]), "Turning skills on or off changes Droid's own settings everywhere, not just this thread.", usage].join("\n");
  }

  private async servers(handle: DroidHandle): Promise<string> {
    const { servers } = await handle.listMcpServers();
    return ["Droid MCP servers", ...servers.map((server) =>
      `${quote(server.name)}: ${server.status} (${server.source})${server.toolCount === undefined ? "" : `, ${server.toolCount} tools`}${server.requiresAuth ? ", sign-in needed on the host" : ""}`),
    ...(servers.length ? [] : ["No MCP servers configured."]), "Turning servers or tools on or off changes Droid's own settings everywhere, not just this thread.", usage].join("\n");
  }
}

/** Quoting only groups a name; nothing is expanded or run by a shell. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest) {
    const matched = /^(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+)(?=\s|$)/.exec(rest)?.[0];
    if (!matched) throw new SettingRefused(usage);
    const value = matched.startsWith('"') ? JSON.parse(matched) as string : matched.startsWith("'") ? matched.slice(1, -1) : matched;
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new SettingRefused(usage);
    out.push(value);
    rest = rest.slice(matched.length).trimStart();
  }
  return out;
}
