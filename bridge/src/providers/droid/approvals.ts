import { dirname } from "node:path";
import { ToolConfirmationOutcome, type RequestPermissionRequestParams } from "@factory/droid-sdk/node";
import { textDiff } from "../acp/diff.ts";
import { addedDiff } from "../claude/tools.ts";
import type { ApprovalDetail, ApprovalOption } from "../types.ts";
import { applyPatchDiff } from "./tools.ts";

type Confirmation = RequestPermissionRequestParams["toolUses"][number]["details"];

/**
 * The confirmations a request asks for: a Script's (CLI 0.250, Droid's way of calling its
 * tools since 0.247) are those of the calls it makes, each as the call itself would ask.
 */
function confirmations(params: RequestPermissionRequestParams): Exclude<Confirmation, { type: "script" }>[] {
  return params.toolUses.flatMap(({ details }) => details.type === "script" ? details.calls.map((call) => call.confirmation) : [details]);
}

export function approvalDetails(params: RequestPermissionRequestParams, cwd: string): ApprovalDetail[] {
  return params.toolUses.flatMap(({ toolUse, details }) => details.type === "script"
    // The Script, then what it does: the card shows each call as its own approval would.
    ? [{ toolId: toolUse.id, name: toolUse.name, type: details.type, impact: details.impactLevel },
      ...details.calls.map((call) => detail(toolUse.id, call.toolName, call.confirmation, cwd))]
    : [detail(toolUse.id, toolUse.name, details, cwd)]);
}

function detail(toolId: string, name: string, d: Exclude<Confirmation, { type: "script" }>, cwd: string): ApprovalDetail {
  const base = { toolId, name, type: d.type };
  switch (d.type) {
    case "exec": return { ...base, command: d.fullCommand };
    case "edit": return { ...base, path: d.filePath, diff: textDiff(d.filePath, d.oldContent ?? "", d.newContent ?? "", cwd) };
    case "create": return { ...base, path: d.filePath, diff: addedDiff(d.filePath, d.content, cwd, true) };
    case "apply_patch": return { ...base, path: d.filePath, diff: d.files
      ? d.files.map((file) => textDiff(file.filePath, file.oldContent ?? "", file.newContent ?? "", cwd)).join("\n")
      : applyPatchDiff(d.patchContent, cwd) || textDiff(d.filePath, d.oldContent ?? "", d.newContent ?? "", cwd) };
    case "mcp_tool": return { ...base, server: d.serverName, tool: d.actualToolName ?? d.toolName, impact: d.impactLevel };
    case "sandbox_violation": return { ...base, violationType: d.violationType, reason: d.reason, operation: d.operationType, target: d.target };
    case "droid_shield_violation": return { ...base, command: d.command, findings: [{ title: "Droid Shield", message: d.reason }] };
    default: return base; // Do not expose arbitrary tool input or authentication state.
  }
}

export function approvalOptions(params: RequestPermissionRequestParams): ApprovalOption[] {
  const plan = params.toolUses.some(({ details }) => details.type === "exit_spec_mode");
  const asked = confirmations(params);
  const paths = asked.flatMap((details) => "filePath" in details ? [details.filePath] : []);
  const directories = [...new Set(paths.map((path) => dirname(path)))].join(", ");
  const mcp = asked.flatMap((details) => details.type === "mcp_tool" ? [details] : []);
  const tools = mcp.map((d) => [d.serverName, d.actualToolName ?? d.toolName].filter(Boolean).join("/")).join(", ");
  const servers = [...new Set(mcp.flatMap((d) => d.serverName ? [d.serverName] : []))].join(", ");
  return params.options.flatMap<ApprovalOption>(({ value, label }) => {
    let description: string;
    let scope: ApprovalOption["effects"][number]["scope"];
    let requiresConfirmation = false;
    switch (value) {
      case ToolConfirmationOutcome.ProceedOnce: scope = "once"; description = "Allow this action once."; break;
      case ToolConfirmationOutcome.Cancel: scope = "once"; description = plan ? "Keep planning without starting implementation." : "Deny this action."; break;
      case ToolConfirmationOutcome.ProceedEdit:
        if (!plan) return [];
        scope = "once"; description = "Return the edited plan to Droid for planning. This does not approve implementation."; break;
      case ToolConfirmationOutcome.ProceedAlways:
        scope = "settings"; requiresConfirmation = true;
        description = directories ? `Save Droid's offered directory permission across sessions for ${directories}.`
          : "Save Droid's offered permission rule across sessions."; break;
      case ToolConfirmationOutcome.ProceedAlwaysForExactPath:
        scope = "settings"; requiresConfirmation = true;
        description = `Save permission across sessions for the exact file path${paths.length ? `: ${paths.join(", ")}` : ""}, not its parent directory.`; break;
      case ToolConfirmationOutcome.ProceedAlwaysTools:
        scope = "settings"; requiresConfirmation = true;
        description = `Save permission for the named MCP tools across sessions${tools ? `: ${tools}` : "."}`; break;
      case ToolConfirmationOutcome.ProceedAlwaysServer:
        scope = "settings"; requiresConfirmation = true;
        description = `Save permission for all tools from the offered MCP server across sessions${servers ? `: ${servers}` : "."}`; break;
      case ToolConfirmationOutcome.ProceedReportFalsePositive:
        return [{ id: value, label, description: "Allow this action once and send Droid's offered false-positive report externally.",
          requiresConfirmation: true, effects: [{ scope: "once", text: "Allow this action once." },
            { scope: "external", text: "Send the false-positive report externally." }] }];
      case ToolConfirmationOutcome.ProceedAutoRun:
      case ToolConfirmationOutcome.ProceedAutoRunLow:
      case ToolConfirmationOutcome.ProceedAutoRunMedium:
      case ToolConfirmationOutcome.ProceedAutoRunHigh:
        scope = "session";
        description = value === ToolConfirmationOutcome.ProceedAutoRun ? `Change this session's autonomy as offered by Droid: ${label}.`
          : `Change this session's autonomy to ${value.slice("proceed_auto_run_".length)}.`; break;
      case ToolConfirmationOutcome.ProceedNewSession:
      case ToolConfirmationOutcome.ProceedNewSessionLow:
      case ToolConfirmationOutcome.ProceedNewSessionMedium:
      case ToolConfirmationOutcome.ProceedNewSessionHigh:
        if (!plan) return [];
        scope = "new_session"; requiresConfirmation = true;
        description = `Approve the plan in a replacement Droid session in this Portals thread, preserving visible history. ${
          value === ToolConfirmationOutcome.ProceedNewSession ? `Autonomy as offered by Droid: ${label}.`
            : `Set autonomy to ${value.slice("proceed_new_session_".length)}.`}`; break;
      default: return []; // Unknown SDK outcomes are not executable.
    }
    return [{ id: value, label, description, effects: [{ scope, text: description }], ...(requiresConfirmation ? { requiresConfirmation } : {}) }];
  });
}
