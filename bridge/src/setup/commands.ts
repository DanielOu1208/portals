import { existsSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { hostname, userInfo } from "node:os";
import { bridgeHome, ConfigError, defaultBridgeHome, defaults, expandHome, parseConfig, pathsFor, type Paths } from "../config.ts";
import { makeGeneral } from "../folders.ts";
import { hashPassword } from "../http/auth.ts";
import { computerName, hostOS, machineWord, type HostOS } from "../platform.ts";
import { isLoopbackAddress } from "../net/members.ts";
import { ensureDirectory, readJSON, writeJSON } from "../store/jsonFile.ts";
import { droidProgram, findClaude, findCodex, findCursor, findDroid, findOpenCode, findPi, installHints, looksLikeAnthropicKey, type FoundAgent } from "./agents.ts";
import { cursorProgram } from "../providers/cursor/options.ts";
import { findHermes } from "../providers/hermes/setup.ts";
import { minimumOpenCodeVersion, opencodeProgram, supportedOpenCodeVersion } from "../providers/opencode/options.ts";
import { setUpHermes } from "./hermes.ts";
import { bridgePath, installApp, installedVersion, InstallError, readManifest } from "./install.ts";
import { moveOldInstall, oldBridgeHome, oldInstallToMove } from "./migrate.ts";
import { pairingLink, qrCode } from "./pairing.ts";
import { newPassword, readSavedPassword, savePassword } from "./password.ts";
import { serviceFor, serviceKind, type Service, type ServiceState } from "./service.ts";
import { UnsupportedServiceDefinition, type DefinitionUpdate } from "./serviceDefinition.ts";
import { namesFor, readSetupState, writeSetupState, type SetupState } from "./state.ts";
import { enableLingering, lingering, userManagerAnswers } from "./systemd.ts";
import type { System } from "./system.ts";
import { freeServePort, mappingTo, refusedToUser, Tailscale, tailscaleConnect, tailscaleDownload, type TailscaleStatus } from "./tailscale.ts";
import type { Ui } from "./ui.ts";
import { isNewer, lastHeard } from "../updates.ts";

// The `portals-host` commands: setup, pair, status, update, relay reset and uninstall. Each
// returns its exit code. Wording is for someone who has never seen the bridge: what a
// step does, what was found, and what to do when something is missing.

export interface Context {
  ui: Ui;
  system: System;
  env: NodeJS.ProcessEnv;
  /** Whether questions are asked (false: `--yes`, or no terminal). */
  interactive: boolean;
  /** Where LaunchAgent plists (on Linux, systemd units) go; tests only. */
  plistFolder?: string;
  /** The system setup is for, this one unless a test says (src/platform.ts). */
  os?: HostOS;
  /** The package to install, instead of this one; tests only. */
  packageRoot?: string;
  /** Where Pi is looked for when it is not on PATH, instead of the usual folders; tests only. */
  piFolders?: string[];
  /** Where OpenCode is looked for when it is not on PATH, instead of the usual folders; tests only. */
  opencodeFolders?: string[];
}

export interface SetupOptions {
  /** Install and start the LaunchAgent, or the systemd user service on Linux (`--no-service` skips it). */
  service: boolean;
  /** Set up `tailscale serve` (`--no-tailscale` skips it). */
  tailscale: boolean;
  /** The address the phone uses, when it reaches the bridge some other way than setup's mapping. */
  address?: string;
  /** The bridge's port, for a new install. */
  port?: number;
  /** How Claude Code signs in, instead of asking. */
  claude?: ClaudeMode;
}

export type ClaudeMode = "api-key" | "login" | "off";

const skipped = "Skipped. The phone can't reach Portals host until there is an address; run setup again for one.";
const thisMacCommand = "To use Portals on just this Mac, without Tailscale: npx portals-host setup --no-tailscale";

/** Said wherever a Mac is set up for itself alone: other devices are the one thing that needs Tailscale. */
const needsTailscale = "To use Portals on your iPhone or iPad, you'll need Tailscale: install it on this Mac and on the device, signed in to the same account, then run npx portals-host setup again.";

// Soft on purpose (2026-10-28): it follows the choice most people make.
const termsNote = "To use an API key instead (what Anthropic's terms cover most clearly): npx portals-host setup --claude=api-key";

type RawConfig = Record<string, unknown> & {
  port: number;
  auth: { username: string; passwordHash: string } | null;
  allowedHosts: string[];
  generalFolder: string;
  providers: Record<string, boolean>;
  claude: Record<string, unknown>;
  codex: Record<string, unknown>;
};

export async function setup(options: SetupOptions, context: Context): Promise<number> {
  const { ui, system, env } = context;
  const os = context.os ?? hostOS;
  const here = `this ${machineWord(os)}`;
  const { version } = readManifest();
  ui.begin(`Portals host ${version}`, `Sets up Portals host on ${here}, so the Portals app can run your agents here.`);

  // Without a systemd manager of the person's own (no systemd, or a shell outside a login
  // session of theirs, as from `sudo -u`), there is nothing to keep it running: said
  // before anything is written, mapped or installed.
  if (options.service && os === "linux" && !(await userManagerAnswers(system))) {
    ui.warn(`systemd's user services can't be reached for ${userInfo().username}, so nothing can keep Portals host running. Run setup in a login session of your own (at the desktop, over SSH, or su - with its dash), on a Linux computer with systemd. Or run it with --no-service, and start Portals host yourself.`);
    return 1;
  }

  const home = bridgeHome(env, os);
  const paths = pathsFor(home);

  // Only a Mac had Portals host before the rename.
  if (os === "macos" && home === defaultBridgeHome(os, env) && oldInstallToMove(oldBridgeHome(), home)) {
    ui.step("An earlier install");
    ui.say(`This Mac has Portals host from before the app was called Portals, in ${oldBridgeHome()}.`);
    ui.say("Setup can move it to the new names. Its threads, settings, password and address stay the same.");
    if (!(await ui.confirm("Move it? It stops until setup starts it again, and Claude Code turns in progress stop.", true))) {
      ui.say("Left as it is. Setup stops here, so two copies don't run at once.");
      return 1;
    }
    const moved = await ui.task("Moving it", () => moveOldInstall(system, oldBridgeHome(), home, { plistFolder: context.plistFolder }));
    ui.ok(`Moved it to ${home}${moved.stopped ? " (stopped for now)" : ""}.`);
  }

  ui.step("Node");
  ui.ok(`Node ${process.versions.node}`);

  const fresh = !existsSync(paths.config);
  ensureDirectory(paths.home);
  let raw: RawConfig;
  try {
    raw = settingsToEdit(paths, fresh);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    ui.warn(`${paths.config} has a setting that can't be used: ${error.message}\nFix it, then run setup again.`);
    return 1;
  }
  if (fresh) raw.port = options.port ?? (await freeLocalPort(defaults.port));

  ui.step("Agents");
  const [claude, codex, pi, cursor, droid, opencode] = await ui.task(`Looking for the agents on ${here}`, () =>
    Promise.all([
      findClaude(system),
      findCodex(system),
      findPi(system, context.piFolders),
      findCursor(system),
      findDroid(system, (raw.droid as { path?: string } | undefined)?.path),
      findOpenCode(system, context.opencodeFolders, (raw.opencode as { path?: string } | undefined)?.path),
    ]),
  );
  reportClaude(ui, claude);
  reportCodex(ui, codex);
  reportPi(ui, pi);
  reportCursor(ui, cursor, !fresh && raw.providers.cursor === true);
  // As Cursor: a new install on a Mac without Droid hears nothing of it.
  reportDroid(ui, droid, !fresh && raw.providers.droid === true);
  // Only OpenCode 2 is run; an OpenCode 1 found is said, with how to upgrade.
  const opencode2 = opencode.path !== null && supportedOpenCodeVersion(opencode.version);
  reportOpenCode(ui, opencode, !fresh && raw.providers.opencode === true);
  const hermes = await setUpHermes({ ui, system, interactive: context.interactive, paths, enabled: raw.providers.hermes !== false });
  ui.say(hermes.summary);
  if (hermes.config) raw.hermes = { ...(raw.hermes as object | undefined), ...hermes.config };

  // A new install asks; an agent turned off earlier (not installed then, say) is offered again.
  if (claude.path) {
    raw.claude.path = claude.path;
    if (fresh || options.claude || (raw.providers.claude === false && (await ui.confirm("Claude Code is off on this host. Set it up now?", false)))) {
      await chooseClaude(raw, claude, options.claude, context);
    } else {
      ui.say(`Claude Code ${raw.providers.claude === false ? "is off" : raw.claude.apiKey ? "uses the API key in config.json" : raw.claude.oauthToken ? "uses the token in config.json" : "uses your own Claude login"}. Change it in ${paths.config}.`);
    }
  } else if (fresh) {
    raw.providers.claude = false;
  }
  if (codex.path) {
    raw.codex.path = codex.path;
    if (!fresh && raw.providers.codex === false && (await ui.confirm("Codex is off on this host. Turn it on?", false))) raw.providers.codex = true;
  } else if (fresh) {
    raw.providers.codex = false;
  }
  if (pi.path) {
    // Written only where Pi is found, as Hermes's section is.
    raw.pi = { ...(raw.pi as object | undefined), path: pi.path };
    // Pi is off unless config.json says otherwise. Found on a new install, or by a config.json from before Pi was an agent, it is turned on.
    if (fresh || raw.providers.pi === undefined) raw.providers.pi = true;
    else if (raw.providers.pi === false && (await ui.confirm("Pi is off on this host. Turn it on?", false))) raw.providers.pi = true;
    if (raw.providers.pi === true) ui.say("Pi runs commands and edits files without asking first, from the phone as at the desk.");
  } else if (fresh) {
    raw.providers.pi = false;
  }
  if (cursor.path) {
    raw.cursor = { ...(raw.cursor as object | undefined), path: cursor.path };
    if (!fresh && raw.providers.cursor === false && (await ui.confirm("Cursor is off on this host. Turn it on?", false))) raw.providers.cursor = true;
  } else if (fresh) {
    raw.providers.cursor = false;
  }

  if (droid.path) {
    raw.droid = { ...(raw.droid as object | undefined), path: droid.path };
    if (fresh || raw.providers.droid === undefined) raw.providers.droid = true;
    else if (raw.providers.droid === false && (await ui.confirm("Droid is off on this host. Turn it on?", false))) raw.providers.droid = true;
  } else if (fresh) {
    raw.providers.droid = false;
  }

  if (opencode2) {
    raw.opencode = { ...(raw.opencode as object | undefined), path: opencode.path };
    // Off unless config.json says otherwise: found on a new install, or by a config.json from before OpenCode was an agent, it is turned on.
    if (fresh || raw.providers.opencode === undefined) raw.providers.opencode = true;
    else if (raw.providers.opencode === false && (await ui.confirm("OpenCode is off on this host. Turn it on?", false))) raw.providers.opencode = true;
    if (raw.providers.opencode === true) ui.say("OpenCode follows its own permission settings; what it asks comes to the phone.");
  } else if (fresh) {
    raw.providers.opencode = false;
  }

  const offered =
    (claude.path && raw.providers.claude !== false) ||
    (codex.path && raw.providers.codex !== false) ||
    (pi.path && raw.providers.pi === true) ||
    (cursor.path && raw.providers.cursor !== false) ||
    (droid.path && raw.providers.droid === true) ||
    (opencode2 && raw.providers.opencode === true) ||
    hermes.state === "ready" ||
    raw.providers.fake === true;
  if (!offered) {
    ui.warn("There is no agent for Portals host to run. Install Claude Code, Codex, Pi, Cursor, Droid, Hermes or OpenCode, then run setup again.");
    return 1;
  }

  ui.step("Folder");
  if (makeGeneral(raw.generalFolder)) ui.ok(`New threads start in ${raw.generalFolder} unless you pick another folder in the app.`);
  else ui.warn(`Could not make ${raw.generalFolder}; new threads start in your home folder.`);

  ui.step("Sign-in");
  const password = await signIn(raw, paths, context);
  if (!password) {
    ui.warn("There is no password setup can show in the pairing code. Run setup again and let it make one.");
  }

  const previous = readSetupState(paths.setup);
  const names = env.PORTALS_BRIDGE_LABEL?.trim() ? namesFor(home, env, os) : previous ?? namesFor(home, env, os);
  const service = options.service ? serviceFor(system, names.label, context.plistFolder, os) : null;
  const script = `${paths.app}/dist/main.js`;
  const canInstall = async () => {
    if (!service || (await serviceOwnership(service, script)).safe) return true;
    ui.warn(`${service.name} or its definition (${service.file}) belongs to another folder or could not be verified, and was left alone. Choose an unused PORTALS_BRIDGE_LABEL for this home, then run setup again.`);
    return false;
  };
  // Saved labels travel with copied homes, and derived labels can collide too.
  if (!(await canInstall())) return 1;
  const saved = previous && previous.label !== names.label ? serviceFor(system, previous.label, context.plistFolder, os) : null;
  const savedOwnership = async (): Promise<"own" | "foreign" | "absent" | null> => {
    if (!saved) return "absent";
    let reason = "its job and definition do not establish which home owns it";
    try {
      const owner = await serviceOwnership(saved, script);
      if (!owner.present) return "absent";
      if (owner.safe) return "own";
      // A foreign job with this home's definition could start a duplicate host later,
      // so mixed ownership cannot be treated as an entirely foreign service.
      if (!owner.running && !saved.fileRuns(script) && (owner.loaded || saved.fileRuns())) return "foreign";
    } catch (error) {
      reason = (error as Error).message;
    }
    ui.warn(`The saved ${saved.name} (${saved.file}) could not be verified (${reason}), so no service was changed.`);
    return null;
  };
  const savedOwner = await savedOwnership();
  if (savedOwner === null) return 1;
  let address = options.address ?? previous?.address ?? null;
  let servePort = previous?.servePort ?? null;
  // Tailscale is the way to reach a host. Portals on the Mac it runs on can do without it, as
  // the exception someone asks for (2026-11-03): `--no-tailscale`, or the choice below, never
  // because Tailscale happened not to work. Setup run again with Tailscale replaces the address.
  let thisMac = !options.address && !options.tailscale && !address;
  if (options.address) {
    addAllowedHost(raw, options.address);
  } else if (options.tailscale) {
    const found = await tailscaleStep(raw, previous, context);
    if (found === "this-mac") thisMac = true;
    else if (found) ({ address, servePort } = found);
  }
  if (os === "macos" && !options.address && (thisMac || (address && isLoopbackAddress(address)))) {
    address = `http://127.0.0.1:${raw.port}`;
    ui.ok("Portals on this Mac will reach the host directly, without Tailscale.");
  }

  ui.step("Running Portals host");
  try {
    parseConfig(raw);
  } catch (error) {
    ui.warn(`The settings can't be used: ${(error as Error).message}`);
    return 1;
  }
  writeJSON(paths.config, raw);
  ui.ok(`Its settings are in ${paths.config}.`);
  const state: SetupState = {
    label: names.label,
    log: names.log,
    address,
    servePort,
    name: previous?.name || (await machineName(system, os)),
    version,
    updatedAt: new Date().toISOString(),
  };
  let question = options.service ? `Install Portals host in ${paths.app} and keep it running, now and at every login?` : `Install Portals host in ${paths.app}?`;
  if (saved && savedOwner === "own") question += ` It replaces ${saved.name}, which stops first.`;
  if (!(await ui.confirm(question, true))) {
    if (!saved) writeSetupState(paths.setup, state);
    ui.end("Not installed. Run setup again when you want it.");
    return 0;
  }
  try {
    await ui.task("Installing Portals host; this takes a minute or two", () => installApp(system, paths, context.packageRoot, { opencode: opencode2 || raw.providers.opencode === true }));
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    ui.warn(error.message);
    return 1;
  }
  ui.ok(`Installed version ${version}.`);
  // The question and package installation can leave time for another home's setup.
  if (!(await canInstall())) return 1;
  if ((await savedOwnership()) !== savedOwner) {
    ui.warn("The saved service changed while you were asked, so its label was kept. Run setup again.");
    return 1;
  }
  if (saved && savedOwner === "own") {
    await ui.task(`Removing the saved ${saved.name}`, () => saved.remove());
  } else if (saved && savedOwner === "foreign") {
    ui.say(`The saved ${saved.name} (${saved.file}) belongs to another folder and was left alone.`);
  }
  // Removing the old service can wait for its process to stop, so check the target again.
  if (!(await canInstall())) return 1;
  writeSetupState(paths.setup, state);
  if (service) {
    const up = await ui.task("Starting Portals host", async () => {
      await service.install({
        label: names.label,
        node: process.execPath,
        script,
        workingDirectory: paths.app,
        path: bridgePath([claude.path, codex.path, pi.path, cursor.path, droid.path]),
        log: names.log,
        // Always on Linux: systemd's manager need not have the XDG_DATA_HOME this shell has.
        environment: os === "macos" && home === defaultBridgeHome(os, env) ? undefined : { PORTALS_BRIDGE_HOME: home },
      });
      return answers(raw.port);
    });
    ui.ok(`Started it. It starts again at login (${service.name}).`);
    if (up) ui.ok(`It answers on 127.0.0.1:${raw.port}.`);
    else ui.warn(`It hasn't answered yet. Its log is ${names.log}.`);
    if (os === "linux") await offerLingering(context);
  } else {
    ui.say(`No ${serviceKind(os)} (--no-service). Start it with: node "${paths.app}/dist/main.js"`);
  }

  ui.step(isThisMacOnly(state) ? "Add this Mac to Portals" : "Pair your iPhone");
  // Setup's code is also the way into the net from a device already in it (docs/net-plan.md).
  const link = showPairing(ui, paths, state, os, "Already use Portals on another device? Scan this with Add a host there instead.");
  if (!link) {
    ui.end("Done, except for the pairing code: see above.");
    return 0;
  }
  const opened = await offerToOpen(context, link);
  if (isThisMacOnly(state)) {
    ui.warn(needsTailscale);
    ui.end(`Done. ${thisMacNextStep(opened)}`);
    return 0;
  }
  ui.end(opened ? "Done. Add this Mac in Portals, open now; for your iPhone, scan the code with its Camera." : `Done. Scan the code with your iPhone's Camera to add ${here}.`);
  return 0;
}

/**
 * On Linux, systemd stops a user's services when they log out, and starts them at boot
 * only once they log in, unless lingering is on for them: then the bridge keeps running,
 * as a Mac's LaunchAgent does while the Mac is logged in. Asked first (2026-10-28); without someone to ask, said how.
 */
async function offerLingering(context: Context): Promise<void> {
  const { ui, system } = context;
  const user = userInfo().username;
  if (await lingering(system, user)) {
    ui.ok("It keeps running when you log out, and starts at boot: lingering is on for you.");
    return;
  }
  ui.say("systemd stops it when you log out, and starts it at boot only once you log in, unless lingering is on for you.");
  const command = `sudo loginctl enable-linger ${user}`;
  if (!context.interactive) {
    ui.say(`To keep it running without you logged in: ${command}`);
    return;
  }
  if (!(await ui.confirm("Turn lingering on, so it keeps running when you log out and starts at boot? It may ask for your password.", true))) {
    ui.say(`Left off. To turn it on later: ${command}`);
    return;
  }
  // Without polkit (most servers), only root may: asked again, for sudo.
  const on = (await enableLingering(system, user)) || ((await ui.confirm(`That needs root here. Run ${command}? sudo asks for your password.`, true)) && (await enableLingering(system, user, true)));
  if (on) ui.ok("Lingering is on: it keeps running when you log out, and starts at boot.");
  else ui.warn(`Lingering is off. To turn it on: ${command}`);
}

/** config.json as it is, every key kept, with the sections setup edits filled in; the defaults for a new install. */
function settingsToEdit(paths: Paths, fresh: boolean): RawConfig {
  const raw = fresh ? (structuredClone(defaults) as unknown as Record<string, unknown>) : readJSON<Record<string, unknown>>(paths.config, {});
  const parsed = parseConfig(raw);
  const object = (key: string) => (typeof raw[key] === "object" && raw[key] !== null ? (raw[key] as Record<string, unknown>) : {});
  return {
    ...raw,
    port: parsed.port,
    auth: parsed.auth,
    allowedHosts: [...parsed.allowedHosts],
    generalFolder: parsed.generalFolder,
    providers: { ...object("providers") } as Record<string, boolean>,
    claude: { ...object("claude") },
    codex: { ...object("codex") },
  };
}

function reportClaude(ui: Ui, claude: FoundAgent): void {
  if (!claude.path) {
    ui.warn(`Claude Code: not found. ${installHints.claude}`);
    return;
  }
  ui.ok(`Claude Code ${claude.version ?? ""} at ${claude.path}`.replace("  ", " "));
}

function reportCodex(ui: Ui, codex: FoundAgent): void {
  if (!codex.path) {
    ui.warn(`Codex: not found. ${installHints.codex}`);
    return;
  }
  if (codex.signedIn === false) {
    ui.warn(`Codex ${codex.version ?? ""} at ${codex.path} is not signed in. Run: codex login`);
    return;
  }
  ui.ok(`Codex ${codex.version ?? ""} at ${codex.path}, signed in`);
}

/**
 * Most Macs have no Pi. A bridge runs Pi only once setup has turned it on, so a Mac
 * without it is told how to get it: said, not warned of, as a missing Hermes is.
 */
function reportPi(ui: Ui, pi: FoundAgent): void {
  if (!pi.path) {
    ui.say(`Pi: not found. ${installHints.pi}`);
    return;
  }
  ui.ok(`Pi ${pi.version ?? ""} at ${pi.path}`.replace("  ", " "));
}

/**
 * Most Macs have no Cursor either. A bridge offers Cursor from the day its program is
 * there, with no setup run again, so a Mac without it hears nothing of it, unless
 * config.json asks for it (`wanted`).
 */
function reportCursor(ui: Ui, cursor: FoundAgent, wanted: boolean): void {
  if (!cursor.path) {
    if (wanted) ui.warn(`Cursor: not found. ${installHints.cursor}`);
    return;
  }
  if (cursor.signedIn === false) {
    ui.warn(`Cursor ${cursor.version ?? ""} at ${cursor.path} is not signed in. Run: cursor-agent login`.replace("  ", " "));
    return;
  }
  ui.ok(`Cursor ${cursor.version ?? ""} at ${cursor.path}${cursor.signedIn ? ", signed in" : ""}`.replace("  ", " "));
}

/**
 * Most Macs have no OpenCode, so one without it hears nothing of it unless config.json
 * asks for it (`wanted`). An OpenCode 1 is said, with how to upgrade: Portals runs
 * OpenCode 2 only, whose server is another.
 */
function reportOpenCode(ui: Ui, opencode: FoundAgent, wanted: boolean): void {
  if (!opencode.path) {
    if (wanted) ui.warn(`OpenCode: not found. ${installHints.opencode}`);
    return;
  }
  if (!supportedOpenCodeVersion(opencode.version)) {
    ui.say(`OpenCode ${opencode.version ?? ""} at ${opencode.path}: Portals runs OpenCode 2 (${minimumOpenCodeVersion} or newer). Choose a separate v2 installation with opencode.path; upgrading is your choice (opencode upgrade --major).`.replace("  ", " "));
    return;
  }
  ui.ok(`OpenCode ${opencode.version} at ${opencode.path}`);
}

function reportDroid(ui: Ui, droid: FoundAgent, wanted: boolean): void {
  if (!droid.path) {
    if (wanted) ui.warn(`Droid: not found. ${installHints.droid}`);
    return;
  }
  ui.ok(`Droid ${droid.version ?? ""} at ${droid.path}`.replace("  ", " "));
  ui.say("Droid uses its existing Factory login and settings. To sign in, run droid in a terminal and use /login; setup does not check or copy credentials.");
}

async function chooseClaude(raw: RawConfig, claude: FoundAgent, wanted: ClaudeMode | undefined, context: Context): Promise<void> {
  const { ui, env } = context;
  const fromEnvironment = env.ANTHROPIC_API_KEY?.trim();
  // Most people use Claude Code with their Claude plan, so their own login comes first; an API
  // key is the choice made for them only when there is one here and no login (2026-10-28).
  const preferred: ClaudeMode = claude.signedIn === false && fromEnvironment ? "api-key" : "login";
  const mode =
    wanted ??
    (context.interactive
      ? await ui.choose(
          "How should Claude Code sign in when Portals host runs it?",
          [
            { value: "login", label: "With my own Claude login", hint: claude.signedIn ? "the one claude uses now; your Claude plan" : "your Claude plan" },
            { value: "api-key", label: "With an Anthropic API key", hint: "billed to the key" },
            { value: "off", label: "Don't offer Claude Code" },
          ] as const,
          preferred,
        )
      : claude.signedIn
        ? "login"
        : fromEnvironment
          ? "api-key"
          : "off");

  if (mode === "off") {
    raw.providers.claude = false;
    ui.say(context.interactive || wanted ? "Claude Code is off." : "Claude Code is off: sign in with claude, set ANTHROPIC_API_KEY or pass --claude=login to turn it on.");
    return;
  }
  raw.providers.claude = true;
  if (mode === "login") {
    raw.claude.apiKey = null;
    // A token from `claude setup-token` would be used over the login, so it goes too.
    raw.claude.oauthToken = null;
    if (claude.signedIn === false) ui.warn("Claude Code is not signed in. Run claude once and sign in.");
    else ui.ok("Claude Code uses your own login, as in your terminal.");
    ui.say(termsNote);
    return;
  }

  let key: string | undefined;
  if (fromEnvironment && looksLikeAnthropicKey(fromEnvironment) && (await ui.confirm("Use the ANTHROPIC_API_KEY set in this terminal?", true))) {
    key = fromEnvironment;
  }
  for (let tries = 0; !key && context.interactive && tries < 3; tries++) {
    const typed = (await ui.secret("Paste an Anthropic API key (from https://console.anthropic.com/settings/keys):")).trim();
    if (typed === "") break;
    if (looksLikeAnthropicKey(typed)) key = typed;
    else ui.warn("That doesn't look like an Anthropic API key (sk-ant-…).");
  }
  if (!key) {
    raw.providers.claude = false;
    ui.warn(`No API key, so Claude Code is off. Run setup again, or put a key in claude.apiKey in config.json.`);
    return;
  }
  raw.claude.apiKey = key;
  ui.ok("Claude Code uses the API key. It is kept in config.json, readable by you only.");
}

/** Makes the sign-in password when there is none setup can show; returns the one in use, or null. */
async function signIn(raw: RawConfig, paths: Paths, context: Context): Promise<string | null> {
  const { ui } = context;
  const saved = readSavedPassword(paths.password);
  if (raw.auth && saved) {
    ui.ok(`Signs in as ${raw.auth.username} with the password setup made earlier.`);
    return saved;
  }
  const replace = "A password is set that setup didn't make, so it can't go in the pairing code. Make a new one? Phones paired already will need the new code.";
  // Without questions the password stays: a phone that signs in with it keeps working.
  if (raw.auth && !(await ui.confirm(replace, context.interactive))) {
    ui.say(`Keeping it. Sign in as ${raw.auth.username} with your own password.`);
    return null;
  }
  const password = newPassword();
  const username = raw.auth?.username ?? userInfo().username;
  savePassword(paths.password, password);
  raw.auth = { username, passwordHash: await hashPassword(password) };
  ui.ok(`Made a password for the app to sign in with, as ${username}. It's in ${paths.password}, readable by you only.`);
  return password;
}

/** The tailnet address made or found; "this-mac" when the person chose to go without Tailscale; null with neither. */
async function tailscaleStep(raw: RawConfig, previous: SetupState | null, context: Context): Promise<{ address: string; servePort: number | null } | "this-mac" | null> {
  const { ui, system } = context;
  const os = context.os ?? hostOS;
  ui.step("Tailscale");
  ui.say(`The iPhone reaches this ${machineWord(os)} through Tailscale, on your own tailnet; Portals host is never on the open internet.`);
  // A Mac with no way in yet may go without, if the person says so: Portals on that Mac reaches
  // it directly. Not one with a tailnet address, whose devices count on it: Tailscale being
  // off is to be put right.
  const canDoWithout = os === "macos" && (!previous?.address || isLoopbackAddress(previous.address));
  // With someone at the terminal, setup waits while what is missing is put right and checks
  // again, rather than ending with "run setup again".
  let found: { tailscale: Tailscale; dnsName: string };
  for (;;) {
    const tailscale = Tailscale.find(system);
    const status = tailscale ? await ui.task("Checking Tailscale", () => tailscale.status()) : null;
    if (status?.dnsName) addAllowedHost(raw, status.dnsName);
    const problem = tailnetProblem(tailscale, status, os);
    if (!problem && tailscale && status?.dnsName) {
      found = { tailscale, dnsName: status.dnsName };
      break;
    }
    ui.warn(problem ?? "Tailscale can't be used.");
    if (!context.interactive) {
      ui.say("Then run setup again.");
      if (canDoWithout) ui.say(thisMacCommand);
      return null;
    }
    if (canDoWithout) {
      const next = await ui.choose(
        "Once Tailscale is ready:",
        [
          { value: "check", label: "Check again", hint: "recommended" },
          { value: "this-mac", label: "Use just this Mac without it", hint: "your iPhone or iPad can't reach it until you add Tailscale" },
        ],
        "check",
      );
      if (next === "this-mac") return "this-mac";
      continue;
    }
    if (!(await ui.confirm("Done? Check again", true))) {
      ui.say(skipped);
      return null;
    }
  }
  const { tailscale, dnsName } = found;

  let serveStatus;
  try {
    serveStatus = await tailscale.serveStatus();
  } catch (error) {
    ui.warn(`Could not read what Tailscale serves: ${(error as Error).message}`);
    return null;
  }
  const existing = mappingTo(serveStatus, raw.port);
  if (existing) {
    const address = `https://${dnsName}:${existing.port}`;
    ui.ok(`${address} reaches Portals host.`);
    return { address, servePort: previous?.servePort === existing.port ? existing.port : null };
  }
  const port = freeServePort(serveStatus);
  if (!port) {
    ui.warn("Every port setup tries (10010–10099) is in use by tailscale serve. Free one, then run setup again.");
    return null;
  }
  const address = `https://${dnsName}:${port}`;
  if (!(await ui.confirm(`Make ${address} reach Portals host? Only devices on your tailnet can open it.`, true))) {
    if (canDoWithout) return "this-mac";
    ui.say(skipped);
    return null;
  }
  const target = `http://127.0.0.1:${raw.port}`;
  let served = await ui.task("Setting up tailscale serve", () => tailscale.serve(port, target));
  // On Linux, only root and Tailscale's operator may change what it serves (2026-10-28: setup offers to make the person its operator, "yes if this is necessary").
  if (!served.ok && os === "linux" && refusedToUser(served.message)) {
    const user = userInfo().username;
    ui.say(`On Linux, Tailscale lets only root, or the user it names its operator, change what it serves.`);
    if (!context.interactive || !(await ui.confirm(`Make ${user} Tailscale's operator, so setup can? It runs sudo tailscale set --operator=${user}, which asks for your password.`, true))) {
      ui.warn(`tailscale serve was refused. Run: sudo tailscale set --operator=${user}\nThen run setup again.`);
      return null;
    }
    const made = await tailscale.makeOperator(user);
    if (!made.ok) {
      ui.warn(`${user} isn't Tailscale's operator: sudo tailscale set --operator=${user} did not work.${made.message ? `\n${made.message}` : ""}`);
      return null;
    }
    ui.ok(`${user} is Tailscale's operator.`);
    served = await ui.task("Setting up tailscale serve", () => tailscale.serve(port, target));
  }
  if (!served.ok) {
    ui.warn(`tailscale serve did not work:\n${served.message}`);
    return null;
  }
  ui.ok(`${address} reaches Portals host.`);
  return { address, servePort: port };
}

/** What keeps the tailnet from reaching this machine, and what to do about it; null when nothing does. */
function tailnetProblem(tailscale: Tailscale | null, status: TailscaleStatus | null, os: HostOS): string | null {
  if (!tailscale) return `Tailscale is not installed. Get it at ${tailscaleDownload(os)} and sign in.`;
  if (!status?.running) return `Tailscale is not connected. ${tailscaleConnect(os)}`;
  const dns = "https://login.tailscale.com/admin/dns";
  if (!status.dnsName && !status.https) return `MagicDNS and HTTPS certificates are off for your tailnet. Turn both on at ${dns}.`;
  if (!status.dnsName) return `MagicDNS is off for your tailnet. Turn it on at ${dns}.`;
  if (!status.https) return `HTTPS certificates are off for your tailnet. Turn them on at ${dns}.`;
  return null;
}

function addAllowedHost(raw: RawConfig, address: string): void {
  let name = address;
  try {
    name = new URL(address.includes("://") ? address : `https://${address}`).hostname;
  } catch {
    // Not a URL: the name as given.
  }
  name = name.toLowerCase();
  if (!raw.allowedHosts.includes(name)) raw.allowedHosts.push(name);
}

/** `preferred`, or the next port up nothing on 127.0.0.1 listens on. */
async function freeLocalPort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  return preferred;
}

/** Whether the bridge answers its health check within about 15 seconds. */
async function answers(port: number, tries = 30): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * The machine's name as people know it ("Dana's MacBook Air"; on Linux its pretty host
 * name, which most leave unset), else its host name, for the host's name in the app.
 */
async function machineName(system: System, os: HostOS): Promise<string> {
  if (os === "linux") return computerName("linux") || hostname();
  const result = await system.run("/usr/sbin/scutil", ["--get", "ComputerName"], { timeoutMs: 5000 });
  const name = result.code === 0 ? result.stdout.trim() : "";
  return name || hostname().replace(/\.local$/, "");
}

/** Whether only Portals on this Mac can reach the host: setup gave it no other address. */
function isThisMacOnly(state: SetupState): boolean {
  return state.address !== null && isLoopbackAddress(state.address);
}

/** What's left to do on a Mac set up for itself, once `opened` says whether its link opened in Portals. */
function thisMacNextStep(opened: boolean): string {
  return opened
    ? "Choose Add this host in Portals, open now."
    : "Paste the link above in Add a host in Portals on this Mac. No Portals yet? Get it at https://github.com/DanielOu1208/portals/releases/latest";
}

/** Shows the pairing code and link; `afterCode`, a line said right after the code. Gives back the link, or null when there is none to show. */
function showPairing(ui: Ui, paths: Paths, state: SetupState, os: HostOS, afterCode?: string): string | null {
  const config = parseConfig(readJSON<Record<string, unknown>>(paths.config, {}));
  const password = readSavedPassword(paths.password);
  if (!config.auth || !password) {
    ui.warn("There is no password setup made, so there is no pairing code. Run: npx portals-host setup");
    return null;
  }
  if (!state.address) {
    ui.warn("There is no address the iPhone can reach yet. Set up Tailscale, then run npx portals-host setup again.");
    if (os === "macos") ui.say(thisMacCommand);
    return null;
  }
  const link = pairingLink({ url: state.address, user: config.auth.username, password, name: state.name });
  if (isThisMacOnly(state)) {
    // No code to scan: a phone holding it would dial itself.
    ui.say("This link adds this Mac to Portals on this Mac:");
    ui.raw(link);
    ui.raw("");
    ui.warn("The link holds this host's password. Anyone with it can use your agents on this Mac, so don't share it.");
    ui.say("To show it again: npx portals-host pair");
    return link;
  }
  ui.say("On the iPhone: install Tailscale and sign in to the same tailnet, and install Portals.");
  ui.say(`Then scan this code with the Camera. It opens Portals with this ${machineWord(os)} filled in.`);
  ui.raw("");
  ui.raw(qrCode(link, { color: Boolean(process.stdout.isTTY) }));
  ui.raw("");
  if (afterCode) ui.say(afterCode);
  ui.say("Or open this link on the iPhone:");
  ui.raw(link);
  ui.raw("");
  ui.warn(`The code holds this host's password. Anyone with it can use your agents on this ${machineWord(os)}, so don't share it.`);
  ui.say("To show it again: npx portals-host pair");
  return link;
}

/**
 * The app that opens `portals://` links on this Mac (Portals for the Mac, or the iPhone
 * app on an Apple silicon Mac), or null when there is none.
 */
async function portalsOnThisMac(system: System): Promise<string | null> {
  const script = 'ObjC.import("AppKit"); const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("portals://pair")); app.isNil() ? "" : app.path.js';
  const found = await system.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeoutMs: 10_000 });
  return found.code === 0 && found.stdout.trim() ? found.stdout.trim() : null;
}

/**
 * Where Portals is on this Mac too, offers to open the link in it, so the Mac that runs the
 * agents is added to its own app without a copy and paste (2026-10-28). Says whether
 * it opened.
 */
async function offerToOpen(context: Context, link: string): Promise<boolean> {
  const { ui, system } = context;
  // Portals runs on Apple's systems only: a Linux computer has no app to open the link in.
  if ((context.os ?? hostOS) !== "macos" || !context.interactive || !(await portalsOnThisMac(system))) return false;
  if (!(await ui.confirm("Portals is on this Mac too. Add this Mac to it now?", true))) return false;
  // `open` hands the link to the app; only this user's processes could see it meanwhile,
  // as they can read the password setup made.
  const opened = await system.run("/usr/bin/open", [link], { timeoutMs: 20_000 });
  if (opened.code !== 0) {
    ui.warn("Portals didn't open. Open the link above on this Mac, or paste it in Add a host.");
    return false;
  }
  ui.ok("Opened Portals with this Mac filled in. Choose Add this host there.");
  return true;
}

export async function pair(context: Context): Promise<number> {
  const { ui } = context;
  const os = context.os ?? hostOS;
  const paths = pathsFor(bridgeHome(context.env, os));
  const state = readSetupState(paths.setup);
  ui.begin(state && isThisMacOnly(state) ? "Add this Mac to Portals" : "Pair your iPhone");
  if (!state || !existsSync(paths.config)) {
    ui.warn(`Portals host isn't set up on this ${machineWord(os)}. Run: npx portals-host setup`);
    return 1;
  }
  const link = showPairing(ui, paths, state, os);
  if (!link) return 1;
  const opened = await offerToOpen(context, link);
  if (isThisMacOnly(state)) {
    ui.warn(needsTailscale);
    ui.end(thisMacNextStep(opened));
    return 0;
  }
  ui.end(opened ? "Add this Mac in Portals, open now; for your iPhone, scan the code with its Camera." : "Scan it with your iPhone's Camera.");
  return 0;
}

export async function status(context: Context): Promise<number> {
  const { ui, system } = context;
  const os = context.os ?? hostOS;
  const paths = pathsFor(bridgeHome(context.env, os));
  const installed = installedVersion(paths);
  ui.begin(`Portals host ${installed ?? ""}`.trim());
  const state = readSetupState(paths.setup);
  if (!state || !existsSync(paths.config)) {
    ui.warn(`Portals host isn't set up on this ${machineWord(os)}. Run: npx portals-host setup`);
    return 1;
  }
  const config = parseConfig(readJSON<Record<string, unknown>>(paths.config, {}));
  const agent = await serviceFor(system, state.label, context.plistFolder, os).state();
  const up = await answers(config.port, 1);
  const agents = [
    config.providers.claude ? `Claude Code (${config.claude.apiKey ? "API key" : config.claude.oauthToken ? "token" : "own login"})` : null,
    config.providers.codex ? "Codex" : null,
    config.providers.pi ? "Pi" : null,
    config.providers.cursor && cursorProgram(config.cursor.path) ? "Cursor" : null,
    config.providers.droid && droidProgram(config.droid.path) ? "Droid" : null,
    config.providers.hermes && findHermes(config.hermes.path) ? "Hermes" : null,
    config.providers.opencode && opencodeProgram(config.opencode.path) ? "OpenCode" : null,
    config.providers.fake ? "the scripted test agent" : null,
  ].filter(Boolean);
  let running = "no";
  if (agent.unknown) running = `can't tell (${agent.unknown})`;
  else if (agent.pid) running = `yes, process ${agent.pid}`;
  else if (agent.loaded) running = "loaded, not running";
  ui.say(`Folder:   ${paths.home}`);
  ui.say(`Running:  ${running}${up ? `, answers on 127.0.0.1:${config.port}` : ""}`);
  ui.say(`Address:  ${state.address ?? "none yet"}${isThisMacOnly(state) ? " (this Mac only)" : ""}`);
  ui.say(`Agents:   ${agents.join(", ") || "none"}`);
  ui.say(`General:  ${config.generalFolder}`);
  ui.say(`Log:      ${state.log}`);
  // What the bridge last heard from npm's registry (src/updates.ts), while it asks.
  const latest = config.updates.check ? lastHeard(paths.update) : undefined;
  if (installed && latest && isNewer(latest, installed)) ui.say(`Update:   version ${latest} is out. Run: npx portals-host@latest update`);
  if (isThisMacOnly(state)) ui.say(needsTailscale);
  ui.end(up ? "It's running." : "It isn't answering. Its log says why.");
  return up ? 0 : 1;
}

export async function update(context: Context): Promise<number> {
  const { ui, system } = context;
  ui.begin(`Update Portals host to ${readManifest(context.packageRoot).version}`);
  const os = context.os ?? hostOS;
  const paths = pathsFor(bridgeHome(context.env, os));
  const state = readSetupState(paths.setup);
  if (!state || !existsSync(paths.config)) {
    ui.warn(`Portals host isn't set up on this ${machineWord(os)}. Run: npx portals-host setup`);
    return 1;
  }
  const config = parseConfig(readJSON<Record<string, unknown>>(paths.config, {}));
  try {
    const opencode = config.providers.opencode || supportedOpenCodeVersion((await findOpenCode(system, context.opencodeFolders, config.opencode.path)).version);
    const { version } = await ui.task("Installing it; this takes a minute or two", () => installApp(system, paths, context.packageRoot, { opencode }));
    writeSetupState(paths.setup, { ...state, version, updatedAt: new Date().toISOString() });
    ui.ok(`Installed version ${version} in ${paths.app}.`);
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    ui.warn(error.message);
    return 1;
  }
  const agent = serviceFor(system, state.label, context.plistFolder, os);
  const current = await agent.state();
  if (current.unknown) {
    ui.end(`The ${agent.name} couldn't be checked (${current.unknown}), so nothing was restarted.`);
    return 0;
  }
  if (!current.loaded) {
    ui.end(`The ${agent.name} isn't loaded, so nothing was restarted.`);
    return 0;
  }
  // A copied setup.json names the original home's service; updating the copy must not interrupt it.
  try {
    if (!(await serviceOwnership(agent, `${paths.app}/dist/main.js`, current)).safe) {
      ui.end(`The ${agent.name} or its definition (${agent.file}) belongs to another folder, so nothing was restarted.`);
      return 0;
    }
  } catch (error) {
    ui.end(`The ${agent.name} couldn't be checked (${(error as Error).message}), so nothing was restarted.`);
    return 0;
  }
  ui.say("Restarting it. Claude Code, Pi, Cursor and Droid turns in progress stop; Codex's keep going.");
  const up = await ui.task("Restarting Portals host", async () => {
    let definition: DefinitionUpdate | undefined;
    try {
      definition = await agent.refreshDefinition();
    } catch (error) {
      if (!(error instanceof UnsupportedServiceDefinition)) throw error;
      ui.say(`Service settings left unchanged (${error.message}); \`portals-host setup\` will refresh them.`);
    }
    try {
      await agent.restart();
    } catch (error) {
      if (definition?.changed) {
        // Reload never stops a service. If restart did, put back the last definition
        // and start it again before reporting the update's failure.
        try {
          await definition.rollback();
          await agent.restart();
        } catch (recovery) {
          throw new AggregateError([error, recovery], `Restart failed and ${agent.name} could not be recovered: ${(recovery as Error).message}`);
        }
      }
      throw error;
    }
    definition?.commit();
    if (definition?.changed && os === "macos") ui.say("Service settings updated; they take full effect after your next login or `portals-host setup`.");
    return answers(config.port);
  });
  if (up) ui.ok(`Restarted. It answers on 127.0.0.1:${config.port}.`);
  else ui.warn(`It hasn't answered yet. Its log is ${state.log}.`);
  ui.end(up ? "Updated." : "Updated, but it isn't answering yet.");
  return 0;
}

/**
 * `portals-host relay reset`: this bridge lets go of its relay id and secret, and makes
 * new ones as it starts (net-19). For a copy of a bridge's folder, which has the relay id
 * of the bridge it was copied from: the relay keeps the first bridge's standby socket and
 * refuses the copy's, which says so (`relay_problem`), and the copy is the one to reset.
 * Its net entry changes with it, which the other Macs hear of as for any change of its own.
 *
 * The running bridge keeps its relay id in memory and writes it back with its token, so
 * it is never reset under it: one run by its LaunchAgent (its systemd unit on Linux) is
 * stopped first and started again after; one run some other way (its socket answers) is
 * left alone, with what to do.
 */
export async function relayReset(context: Context): Promise<number> {
  const { ui, system } = context;
  const os = context.os ?? hostOS;
  ui.begin("A new relay id for Portals host");
  const home = bridgeHome(context.env, os);
  const paths = pathsFor(home);
  if (!existsSync(paths.netOwn) && !existsSync(`${paths.netOwn}.bak`)) {
    ui.end(`Portals host in ${home} has no relay id yet: it makes one of its own when it starts.`);
    return 0;
  }
  // Only the service whose loaded job runs this folder's bridge: a copied folder's
  // setup.json names the label of the bridge it was copied from, and two folders of one
  // name in different places have one label, neither of which is to be stopped for it.
  const state = readSetupState(paths.setup);
  const script = `${paths.app}/dist/main.js`;
  const named = state ? serviceFor(system, state.label, context.plistFolder, os) : null;
  const owns = async () => named !== null && (await named.runs(script)) === true;
  const agent = (await owns()) ? named : null;
  const running = agent !== null;
  // Started again from its file on disk, which must be this folder's too, and whole: a
  // setup of a copy stopped halfway may have put the copy's there, which would start the
  // copy instead, or left it cut short, which would start nothing.
  if (running && !agent.fileRuns(script)) {
    ui.warn(`The ${agent.name} runs Portals host from this folder, but its ${os === "macos" ? "plist" : "unit"} (${agent.file}) is now another folder's or not whole, so it would not start this one again. Repair its definition before resetting this home.`);
    return 1;
  }
  if (!running && (await socketAnswers(paths.socket))) {
    ui.warn(`Portals host in ${home} is running, and not from its ${os === "macos" ? "LaunchAgent" : "systemd unit"}, so it can't be restarted from here. Stop it, run this again, then start it.`);
    return 1;
  }
  const question = running
    ? "Give Portals host a new relay id? It restarts: Claude Code, Pi, Cursor and Droid turns in progress stop; Codex's keep going."
    : "Give Portals host a new relay id? It makes one when it next starts.";
  if (!(await ui.confirm(question, true))) return 1;
  // While the question was open, a setup may have changed what runs: looked at again.
  if ((await owns()) !== running || (running && !agent.fileRuns(script)) || (!running && (await socketAnswers(paths.socket)))) {
    ui.warn("What runs Portals host changed while you were asked, so nothing was changed. Run this again.");
    return 1;
  }
  if (running) await ui.task("Stopping Portals host", () => agent.stop());
  try {
    dropRelayID(paths.netOwn);
    ui.ok("Its relay id and secret are let go of.");
  } finally {
    // Started again whatever happened to the file, as it was before.
    if (running) await agent.start();
  }
  if (!running) {
    ui.end("It makes a new relay id when it starts.");
    return 0;
  }
  const config = parseConfig(readJSON<Record<string, unknown>>(paths.config, {}));
  const up = await ui.task("Starting Portals host", () => answers(config.port));
  if (up) ui.ok(`Started with a new relay id. It answers on 127.0.0.1:${config.port}.`);
  else ui.warn(`It hasn't answered yet. Its log is ${state!.log}.`);
  ui.end(up ? `Devices reach this ${machineWord(os)} through the relay again once they reconnect.` : "Reset, but it isn't answering yet.");
  return 0;
}

/**
 * Takes `relay` out of `state/net-own.json` and out of its `.bak`, which the bridge goes on
 * with when the file cannot be used: the bridge makes a new relay id and secret as it
 * reads it (net.ts `readOwn`). The rest (its token and key) stays. A file that cannot be
 * read is left as it is, and said.
 */
function dropRelayID(path: string): void {
  for (const file of [path, `${path}.bak`]) {
    if (!existsSync(file)) continue;
    const own = readJSON<unknown>(file, undefined, (error) => {
      throw new Error(`${file} can't be read (${error.message}), so it was left as it is.`);
    });
    if (typeof own !== "object" || own === null || Array.isArray(own)) throw new Error(`${file} isn't what the bridge writes there, so it was left as it is.`);
    if (!("relay" in own)) continue;
    const { relay: _dropped, ...rest } = own as Record<string, unknown>;
    writeJSON(file, rest);
  }
}

/** Whether this home's command socket or a local TCP port accepts a connection. */
function socketAnswers(address: string | number, host = "127.0.0.1"): Promise<boolean> {
  if (typeof address === "string" && !existsSync(address)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = typeof address === "number" ? connect(address, host) : connect(address);
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    // An uncertain TCP probe counts as busy, so it cannot authorize mapping removal.
    socket.setTimeout(2000, () => done(typeof address === "number"));
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const absent = error.code === "ECONNREFUSED" || (host === "::1" && (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL" || error.code === "ENETUNREACH"));
      done(typeof address === "number" && !absent);
    });
  });
}

/** Both the loaded job and its definition must belong to this home before its service can change. */
async function serviceOwnership(service: Service, script: string, checked?: ServiceState): Promise<{ safe: boolean; running: boolean; loaded: boolean; present: boolean }> {
  const current = checked ?? (await service.state());
  if (current.unknown) throw new Error(current.unknown);
  const running = current.loaded ? await service.runs(script) : false;
  if (running === null) throw new Error(`The loaded ${service.name} could not be checked, so its home was kept.`);
  const defined = existsSync(service.file);
  return { safe: (!current.loaded || running) && (!defined || service.fileRuns(script)), running, loaded: current.loaded, present: current.loaded || defined };
}

export async function uninstall(context: Context): Promise<number> {
  const { ui, system } = context;
  ui.begin("Remove Portals host");
  const os = context.os ?? hostOS;
  const home = bridgeHome(context.env, os);
  const paths = pathsFor(home);
  const state = readSetupState(paths.setup) ?? (existsSync(paths.config) ? { ...namesFor(home, context.env, os), servePort: null } : null);
  if (!state) {
    ui.end(`Portals host isn't set up on this ${machineWord(os)}.`);
    return 0;
  }
  let general = defaults.generalFolder;
  let bridgePort: number | undefined;
  try {
    const config = parseConfig(readJSON<Record<string, unknown>>(paths.config, {}));
    general = config.generalFolder;
    bridgePort = config.port;
  } catch {
    // The usual one.
  }
  const service = serviceFor(system, state.label, context.plistFolder, os);
  const script = `${paths.app}/dist/main.js`;
  const ownership = async () => {
    const current = await service.state();
    // A Linux home installed without systemd has no service to remove. Its socket,
    // both loopbacks and the unit file are checked again wherever cleanup can proceed.
    if (current.unknown && os === "linux" && bridgePort !== undefined && !existsSync(service.file)
      && !(await socketAnswers(paths.socket)) && !(await socketAnswers(bridgePort)) && !(await socketAnswers(bridgePort, "::1")) && !existsSync(service.file)) {
      return { safe: true, running: false, loaded: false, present: false, unmanaged: true };
    }
    return { ...(await serviceOwnership(service, script, current)), unmanaged: false };
  };
  // A copied setup.json can name another home's service, so both the loaded job and
  // the definition to be deleted must belong to this home before anything is removed.
  let owned = await ownership();
  if (!owned.safe) {
    ui.say(`${service.name} or its definition (${service.file}) belongs to another folder and was left alone.`);
  } else if (owned.unmanaged) {
    ui.say(`No unit file exists for ${service.name}, and this home is stopped, so the service step was skipped.`);
  } else {
    if (!(await ui.confirm(os === "macos" ? "Stop Portals host and remove it from login items?" : "Stop Portals host and remove its systemd user service?", true))) return 1;
    owned = await ownership();
    if (!owned.safe || owned.unmanaged) {
      ui.warn("What runs Portals host changed while you were asked, so nothing was removed. Run this again.");
      return 1;
    }
    await service.remove();
    ui.ok(`Stopped. ${service.name} removed.`);
  }

  // Without a service, a quiet port or this home's answering socket rules out cutting
  // off a running copy. A known foreign service always keeps its mapping.
  const port = bridgePort;
  const mayRemoveMapping = async () => {
    if (!owned.safe || port === undefined) return false;
    // The label may have changed homes after our service was removed, even if the
    // mapping's target stayed the same while its confirmation was open.
    owned = await ownership();
    if (!owned.safe) return false;
    if (owned.unmanaged) return true;
    if (owned.running || (await socketAnswers(paths.socket))) return true;
    return !(await socketAnswers(port)) && !(await socketAnswers(port, "::1"));
  };
  let removedMapping = false;
  if (state.servePort !== null && port !== undefined && (await mayRemoveMapping())) {
    const tailscale = Tailscale.find(system);
    if (tailscale) {
      const mapped = async () => {
        try {
          const serving = await tailscale.serveStatus();
          const mappings = serving.mappings.filter((mapping) => mapping.port === state.servePort);
          return mappingTo({ ...serving, mappings }, port) !== undefined;
        } catch (error) {
          ui.warn(`tailscale serve could not be checked, so its mapping was kept: ${(error as Error).message}`);
          return false;
        }
      };
      if (!(await mapped())) {
        ui.say(`Kept the tailscale serve mapping on port ${state.servePort}: its target could not be verified for this bridge.`);
      } else if (await ui.confirm(`Remove the tailscale serve mapping on port ${state.servePort} that setup made?`, true)) {
        // Another setup may change the mapping while the question is open.
        if ((await mapped()) && (await mayRemoveMapping())) {
          const result = await tailscale.unserve(state.servePort);
          removedMapping = result.ok;
          if (result.ok) ui.ok(`Port ${state.servePort} no longer reaches Portals host.`);
          else ui.warn(`tailscale serve did not remove it:\n${result.message}`);
        } else {
          ui.say(`Kept the tailscale serve mapping on port ${state.servePort}: it changed while you were asked.`);
        }
      }
    }
  } else if (state.servePort !== null) {
    ui.say(`Kept the tailscale serve mapping on port ${state.servePort}: another host may still be using it.`);
  }
  if (state.servePort !== null && owned.safe && !removedMapping) ui.say(`To remove the mapping later: tailscale serve --https=${state.servePort} off`);

  const stillRunning = async () => (await ownership()).running || (await socketAnswers(paths.socket));
  if (await stillRunning()) {
    ui.warn(`Portals host in ${home} is still running, so its home was kept. Stop it, then run uninstall again.`);
    return 1;
  }
  if (await ui.confirm(`Also delete ${home}? It holds the settings, the password, the list of threads and the display conversations of Cursor and Droid threads. Your agents' own sessions stay either way.`, false)) {
    // A bridge started while the question was open must keep its settings and threads.
    if (await stillRunning()) {
      ui.warn(`Portals host in ${home} is still running, so its home was kept. Stop it, then run uninstall again.`);
      return 1;
    }
    rmSync(home, { recursive: true, force: true });
    ui.ok(`Deleted ${home}.`);
  } else {
    ui.say(`Kept ${home}. Setup uses it again if you run it.`);
  }
  ui.say(`${expandHome(general)} and your agents' sessions were not touched.`);
  ui.end("Removed.");
  return 0;
}
