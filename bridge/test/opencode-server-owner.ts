import { ServerLocator, type ServerOptions } from "../src/providers/opencode/server.ts";

// A disposable bridge process. Its detached stand-in survives a SIGKILL, as the
// native server does; the parent test then exercises durable ownership recovery.
const options = JSON.parse(process.argv[2]) as ServerOptions;
const server = new ServerLocator({ ...options, env: process.env });
process.on("message", (message) => {
  if (message === "locate") void server.locate().then(
    (endpoint) => process.send?.({ endpoint }),
    (error: Error) => process.send?.({ error: error.message }),
  );
});
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
process.send?.({ ready: true });
