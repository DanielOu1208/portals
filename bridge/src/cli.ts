#!/usr/bin/env node
// portals-host: sets up Portals host on this Mac (or Linux computer) and pairs the Portals
// app with it.
//
//   npx portals-host setup         find the agents, make a password, install and start the
//                                  host, set up `tailscale serve`, show the pairing code
//   npx portals-host pair          show the pairing code again
//   npx portals-host status        whether it runs, and where
//   npx portals-host update        install this version and restart it
//   npx portals-host relay reset   give a copied host a relay id of its own
//   npx portals-host telemetry     turn the anonymous daily totals on or off, or show what they send
//   npx portals-host uninstall     stop it and remove it
//
// The bridge itself is main.ts, which the LaunchAgent (on Linux, the systemd user service)
// runs from the installed copy.
// The commands are loaded only after the Node check, so an old Node gets a sentence
// instead of a syntax error.

// Words for a Mac as they always were, and for a Linux computer (docs/linux-plan.md).
const mac = process.platform === "darwin";
const usage = `Usage: portals-host <command> [options]

Commands:
  setup       Set up Portals host on this ${mac ? "Mac" : "Linux computer"} and add it to the app
  pair        Show the pairing code or link again
  status      Show whether Portals host is running, and where
  update      Install this version of Portals host and restart it
  relay reset Give Portals host a new relay id (for a copy of another host's folder)
  telemetry   Turn the anonymous usage totals on or off, or show what they send: on, off or status
  uninstall   Stop Portals host and remove it

Options for setup:
  --yes                  Take the default answer to every question
  --claude <how>         How Claude Code signs in: api-key, login or off
  --no-tailscale         Leave tailscale serve alone${mac ? `; with no other address, Portals works
                         on this Mac only, and your iPhone or iPad needs Tailscale later` : ""}
  --address <url>        The address the iPhone uses, if not set up through Tailscale
  --port <number>        Portals host's port on 127.0.0.1 (a new install only)
  --no-service           Install without a ${mac ? "LaunchAgent" : "systemd user service"}; start Portals host yourself

Options for uninstall and relay reset:
  --yes                  Take the default answer to every question
`;

// 22.18 is the oldest the tests run on, and the first 22 to run the repository's .ts directly.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  // Ubuntu's and Debian's own Node is older than that.
  const where = mac ? "https://nodejs.org" : "https://nodejs.org/en/download (your distribution's own may be older)";
  console.error(`Portals host needs Node 22.18 or later; this is Node ${process.versions.node}. Get it at ${where}, then try again.`);
  process.exit(1);
}

// What the agents' clients log as setup looks at them ("connected to Hermes") is not for the
// person at the terminal; warnings still show, and PORTALS_BRIDGE_LOG still decides.
const { setLogLevel } = await import("./log.ts");
if (!process.env.PORTALS_BRIDGE_LOG && !process.env.AERIPORTAL_BRIDGE_LOG) setLogLevel("warn");
const { run } = await import("./setup/run.ts");
process.exitCode = await run(process.argv.slice(2), usage);
