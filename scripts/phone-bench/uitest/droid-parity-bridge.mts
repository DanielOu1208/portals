import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { startBridge } from "../../../bridge/src/bridge.ts";
import { parseConfig, pathsFor } from "../../../bridge/src/config.ts";
import { hashPassword } from "../../../bridge/src/http/auth.ts";
import { commandAccess, onPath } from "../../../bridge/src/portals/access.ts";
import { methods } from "../../../bridge/src/gateway/methods.ts";
import { DroidProvider } from "../../../bridge/src/providers/droid/provider.ts";
import { DroidParityFakeProvider, FakeProvider } from "../../../bridge/src/providers/fake.ts";
import type { AgentProfile, Provider, ProviderSession, SessionOptions, SessionSink, ThreadMode } from "../../../bridge/src/providers/types.ts";
import { Device } from "../../../bridge/scripts/bench/device.ts";
import { approvedModel, SdkObservation } from "./droid-pr2-observe.mts";

// Source-only bridge for DroidParityUITests. Never uses the installed bridge's home,
// build output, credentials, push registration, or configuration.
const live = process.argv.includes("--live");
const fixtures = process.argv.includes("--fixtures");
const scratchHome = process.argv.includes("--scratch-home");
const legacyIndex = process.argv.indexOf("--legacy-modes");
const legacyKind = legacyIndex >= 0 ? process.argv[legacyIndex + 1] : undefined;
if (legacyIndex >= 0 && (live || !["codex", "cursor"].includes(legacyKind ?? ""))) {
  throw new Error("--legacy-modes requires codex or cursor and never runs with --live");
}
const droidPath = process.env.DROID_RECORD_PATH;
if (live && (!droidPath || !isAbsolute(droidPath))) {
  throw new Error("--live requires DROID_RECORD_PATH with the explicitly approved CLI's absolute path");
}
const port = Number(process.env.PORTALS_PARITY_PORT ?? (live ? 9486 : 9487));
const home = mkdtempSync("/private/tmp/portals-droid-parity-");
const repo = join(home, "work");
mkdirSync(repo);
execFileSync("/usr/bin/git", ["-C", repo, "init", "--quiet"]);
const secondRepo = fixtures ? mkdtempSync("/private/tmp/portals-droid-project-b-") : undefined;
const factoryHome = scratchHome ? join(home, "factory-home") : undefined;
if (secondRepo) {
  execFileSync("/usr/bin/git", ["-C", secondRepo, "init", "--quiet"]);
}
if (factoryHome) mkdirSync(factoryHome);
if (fixtures) {
  for (const [cwd, label] of [[repo, "a"], [secondRepo!, "b"]]) {
    const commands = join(cwd, ".factory", "commands");
    const droids = join(cwd, ".factory", "droids");
    mkdirSync(commands, { recursive: true });
    mkdirSync(droids, { recursive: true });
    writeFileSync(join(cwd, "hello.txt"), "pear\n", { flag: "wx" });
    writeFileSync(join(commands, `parity-${label}.md`),
      `---\ndescription: Only project ${label.toUpperCase()}\n---\nReply exactly parity-project-${label}. Do not use tools.\n`, { flag: "wx" });
    writeFileSync(join(commands, "parity-args.md"),
      `---\ndescription: Project ${label.toUpperCase()} argument echo\nargument-hint: <word>\n---\nReply exactly parity-${label}-$ARGUMENTS. Do not use tools.\n`, { flag: "wx" });
    if (label === "a") {
      writeFileSync(join(commands, "portals-parity-test.md"),
        "---\ndescription: Project A overrides the personal parity test\n---\nReply exactly portals-project-a-$ARGUMENTS. Do not use tools.\n", { flag: "wx" });
    }
    writeFileSync(join(droids, "parity-ui-helper.md"),
      "---\nname: parity-ui-helper\ndescription: Isolated UI reporting helper\nmodel: claude-haiku-5-5\ntools: [\"Read\"]\n---\nRead only hello.txt in the scratch working directory supplied in your task. Follow the task's requested report format and length. No other tools, files, network or settings.\n", { flag: "wx" });
  }
}
if (factoryHome) {
  const commands = join(factoryHome, ".factory", "commands");
  mkdirSync(commands, { recursive: true });
  writeFileSync(join(commands, "portals-parity-test.md"),
    "---\ndescription: Isolated personal command\n---\nReply exactly portals-personal-$ARGUMENTS. Do not use tools.\n", { flag: "wx" });
}
const password = randomBytes(24).toString("base64url");
const config = {
  host: "127.0.0.1", port,
  auth: { username: "droid-parity", passwordHash: await hashPassword(password) },
  allowedHosts: ["127.0.0.1", "localhost", "::1"],
  generalFolder: repo,
  providers: { claude: false, codex: false, pi: false, cursor: false, droid: live, hermes: false, fake: !live },
  droid: { ...(droidPath ? { path: droidPath } : {}), idleMinutes: 0.1, maxWarm: 2 },
  apns: null, push: { relay: null, dryRun: join(home, "push.jsonl") },
  // No standby link to the deployed relay: the relay is on unless set off.
  relay: { enabled: false },
  fleet: { tellAgents: false }, visuals: { tellAgents: false }, aeri: { enabled: false },
};
const parsed = parseConfig(config);
writeFileSync(join(home, "config.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" });
const paths = pathsFor(home);
class LegacyModeFixture extends FakeProvider {
  readonly supportsModes = true;
  override readonly profile: AgentProfile;

  constructor(kind: "codex" | "cursor") {
    super({ directory: join(home, kind), name: kind, delayMs: 100 });
    this.profile = { name: kind, kind, displayName: `${kind} mode fixture`,
      description: "Scripted legacy mode metadata only; no native provider runs.",
      model: "fake-1", provider: "fake" };
  }

  override async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return this.withModes(await super.startSession(options, sink), options.mode);
  }

  override async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    return this.withModes(await super.resumeSession(options, sink), options.mode);
  }

  private withModes(session: ProviderSession, mode: ThreadMode = "default"): ProviderSession {
    return Object.assign(session, {
      mode: () => ({ mode, defaultsTo: "full" as const }),
      setMode: async (next: ThreadMode) => { mode = next; },
    });
  }
}
const portals = commandAccess(parsed, paths);
const childEnv = factoryHome ? { ...process.env, HOME: factoryHome } : process.env;
const observation = live ? new SdkObservation(droidPath!, join(home, "sdk-metrics.jsonl"),
  onPath(childEnv, portals.bin)) : undefined;
// Same options as the ordinary factory, with an optional scratch-only HOME.
let providers: Map<string, Provider>;
if (live) {
  providers = new Map([["droid", new DroidProvider({
      command: droidPath!, directory: paths.droid,
      idleMs: parsed.droid.idleMinutes * 60_000, maxWarm: parsed.droid.maxWarm,
      portals,
      sdk: observation!.sdk,
      ...(factoryHome ? { env: { ...process.env, HOME: factoryHome } } : {}),
    })]]);
} else if (legacyKind) {
  providers = new Map([[legacyKind, new LegacyModeFixture(legacyKind as "codex" | "cursor")]]);
} else {
  providers = new Map([["fake", new DroidParityFakeProvider({ directory: join(home, "fake"), delayMs: 100 })]]);
}
const auditFile = process.argv.includes("--audit") ? join(home, "receipts.jsonl") : undefined;
if (auditFile) {
  writeFileSync(auditFile, "", { mode: 0o600, flag: "wx" });
  let sequence = 0;
  const record = (row: Record<string, unknown>) => {
    const line = JSON.stringify({ at: Date.now(), sequence: ++sequence, ...row });
    appendFileSync(auditFile, line + "\n");
    console.log(`PARITY_AUDIT ${line}`);
  };
  for (const name of ["slash.exec", "command.dispatch"] as const) {
    const spec = methods[name]!;
    const handle = spec.handle.bind(spec);
    spec.handle = (params, context) => {
      const command = String((name === "slash.exec" ? params.command : params.name) ?? "")
        .match(/^\/?([a-z0-9-]+)/i)?.[1];
      record({ event: "rpc_command", method: name, thread: params.session_id, command });
      return handle(params, context);
    };
  }
  for (const provider of providers.values()) {
    const start = provider.startSession.bind(provider);
    provider.startSession = async (options, sink) => {
      const session = await start(options, { ...sink, emit(event) {
        if (event.type === "tool.start" || event.type === "tool.end") {
          record({ event: event.type, thread: options.id, id: event.id, name: event.name });
        } else if (event.type === "subagent") {
          record({ event: event.type, thread: options.id, id: event.subagent.id,
            status: event.subagent.status, background: event.subagent.background, stoppable: event.subagent.stoppable });
        } else if (event.type === "compacted") {
          record({ event: "provider.compacted", thread: options.id, trigger: event.trigger, tokensBefore: event.tokensBefore });
        } else if (event.type === "turn.end") {
          record({ event: "turn_end", thread: options.id, status: event.status });
        }
        sink.emit(event);
      } });
      const turn = session.startTurn.bind(session);
      session.startTurn = (prompt) => {
        record({ event: "prompt_received", thread: options.id, characters: prompt.text.length,
          probe: prompt.text.match(/\bparity-probe-[a-z0-9-]+/i)?.[0] });
        turn(prompt);
      };
      return session;
    };
  }
}
const bridge = await startBridge({ home, providers, temporaryFolders: [] });
if (secondRepo) {
  const setup = await Device.open({ url: bridge.url, account: { username: "droid-parity", password } });
  try { await setup.call("folders.add", { path: secondRepo }); }
  finally { await setup.disconnect(); }
}
const catalog = live ? await providers.get("droid")!.models() : undefined;
const maxModel = Object.entries(catalog?.levels ?? {}).find(([model, levels]) => model !== approvedModel && levels.includes("max"))?.[0];
const nonMaxModel = "claude-haiku-4-5-20251001";
const ui = {
  bundleIdentifier: "com.danielou.portals.parity",
  hosts: JSON.stringify([{ name: live ? "Droid scratch" : "Droid scripted", url: bridge.url, user: "droid-parity", password }]),
  agent: live ? "droid" : legacyKind ?? "fake", live, cwd: repo, secondCwd: secondRepo, auditFile,
  legacyKind, maxModelName: maxModel ? catalog?.names?.[maxModel] ?? maxModel : undefined,
  nonMaxModelName: catalog?.levels?.[nonMaxModel]?.includes("medium") && !catalog.levels[nonMaxModel]!.includes("max")
    ? catalog.names?.[nonMaxModel] ?? nonMaxModel : undefined,
  haikuModelName: catalog?.names?.[approvedModel] ?? (live ? approvedModel : undefined),
  personalCommand: factoryHome ? "portals-parity-test" : undefined,
};
const uiConfig = join(home, "ui.json");
writeFileSync(uiConfig, JSON.stringify(ui), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ home, uiConfig, port: bridge.port, live }));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void bridge.close().then(() => process.exit(0)); });
}
