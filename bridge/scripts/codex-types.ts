import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// Writes the TypeScript types of the Codex app-server protocol that the bridge uses
// into src/providers/codex/types/, from the installed codex:
//
//   node scripts/codex-types.ts
//
// `codex app-server generate-ts --experimental` writes all of them (about 900 files);
// only the ones named in `roots` below, and the ones they need, are kept. Imports get
// their `.ts` extension, which Node's type stripping and `tsc` want; nothing else is
// changed. Run it again after updating Codex, then `npm run typecheck`.

const roots = [
  // Requests the bridge makes, and their answers.
  "InitializeParams",
  "InitializeResponse",
  "v2/ThreadStartParams",
  "v2/ThreadStartResponse",
  "v2/ThreadResumeParams",
  "v2/ThreadResumeResponse",
  "v2/ThreadReadParams",
  "v2/ThreadReadResponse",
  "v2/ThreadLoadedListParams",
  "v2/ThreadLoadedListResponse",
  "v2/ThreadListParams",
  "v2/ThreadListResponse",
  "v2/ThreadDeleteParams",
  "v2/ThreadForkParams",
  "v2/ThreadForkResponse",
  "v2/TurnStartParams",
  "v2/TurnStartResponse",
  "v2/TurnSteerParams",
  "v2/TurnSteerResponse",
  "v2/TurnInterruptParams",
  "v2/ModelListParams",
  "v2/ModelListResponse",
  "v2/ConfigReadParams",
  "v2/ConfigReadResponse",
  // Requests Codex makes, and the bridge's answers.
  "ServerRequest",
  "v2/CommandExecutionRequestApprovalParams",
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalParams",
  "v2/FileChangeRequestApprovalResponse",
  "v2/ToolRequestUserInputParams",
  "v2/ToolRequestUserInputResponse",
  "v2/PermissionsRequestApprovalParams",
  "v2/PermissionsRequestApprovalResponse",
  "v2/McpServerElicitationRequestParams",
  "v2/McpServerElicitationRequestResponse",
  "v2/CurrentTimeReadResponse",
  // What Codex reports.
  "v2/ErrorNotification",
  "v2/ThreadStatusChangedNotification",
  "v2/ThreadNameUpdatedNotification",
  "v2/ThreadTokenUsageUpdatedNotification",
  "v2/TurnStartedNotification",
  "v2/TurnCompletedNotification",
  "v2/TurnPlanUpdatedNotification",
  "v2/ItemStartedNotification",
  "v2/ItemCompletedNotification",
  "v2/AgentMessageDeltaNotification",
  "v2/ReasoningSummaryTextDeltaNotification",
  "v2/ReasoningSummaryPartAddedNotification",
  "v2/ServerRequestResolvedNotification",
  "v2/AccountRateLimitsUpdatedNotification",
  "v2/WarningNotification",
  "v2/ModelReroutedNotification",
  "v2/ThreadClosedNotification",
  "v2/ThreadSettingsUpdatedNotification",
  "v2/ThreadItem",
  "v2/Turn",
  "v2/Thread",
  "v2/ThreadStatus",
  "v2/SandboxPolicy",
  "v2/AskForApproval",
  "v2/UserInput",
  "v2/RateLimitSnapshot",
  "v2/RateLimitWindow",
  "v2/Model",
  "v2/FileUpdateChange",
  "RequestId",
];

const bridge = resolve(import.meta.dirname, "..");
const target = join(bridge, "src/providers/codex/types");
const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const generated = mkdtempSync(join(tmpdir(), "codex-types-"));

try {
  execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", generated], { stdio: "inherit" });

  // Every file the roots need, following their imports.
  const needed = new Set<string>();
  const queue = roots.map((root) => `${root}.ts`);
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (needed.has(file)) continue;
    const path = join(generated, file);
    if (!existsSync(path)) throw new Error(`${file} is not in what codex generated: a type was renamed or removed.`);
    needed.add(file);
    for (const [, from] of readFileSync(path, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      queue.push(relative(generated, join(dirname(path), `${from}.ts`)));
    }
  }

  rmSync(target, { recursive: true, force: true });
  for (const file of [...needed].sort()) {
    const text = readFileSync(join(generated, file), "utf8").replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.ts"');
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), text);
  }
  const exports = roots.map((root) => `export type * from "./${root}.ts";`).join("\n");
  writeFileSync(
    join(target, "index.ts"),
    `// The Codex app-server protocol types the bridge uses, from ${version}\n// (\`codex app-server generate-ts --experimental\`, copied by scripts/codex-types.ts).\n// Generated: do not edit by hand.\n\n${exports}\n`,
  );
  writeFileSync(join(target, "VERSION"), `${version}\n`);
  console.log(`wrote ${needed.size} files from ${version} to ${relative(bridge, target)}`);
} finally {
  rmSync(generated, { recursive: true, force: true });
}
