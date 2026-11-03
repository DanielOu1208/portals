import { startBridge, version } from "./bridge.ts";
import { ConfigError } from "./config.ts";
import { watchProcess } from "./lifetime.ts";
import { log } from "./log.ts";

// portals-host: runs coding agents on this Mac for the Portals app, which talks to it
// as it talks to `hermes serve`. Settings and state are in
// ~/Library/Application Support/portals-bridge/, or $PORTALS_BRIDGE_HOME. The command
// that sets it up is cli.ts.
//
//   node src/main.ts

// Signals, and errors nothing caught, from the start (lifetime.ts).
const lifetime = watchProcess();

try {
  const bridge = await startBridge();
  lifetime.started(bridge);
  log.info(`portals-host ${version} listening on ${bridge.url}`, { home: bridge.home, replay_epoch: bridge.replayEpoch });
} catch (error) {
  if (error instanceof ConfigError) {
    log.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    log.error("The port is in use: is another bridge running? Change port in config.json to use another.");
    process.exit(1);
  }
  throw error;
}
