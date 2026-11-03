import { Auth } from "../src/http/auth.ts";
import { createHttpServer, type HttpOptions } from "../src/http/server.ts";

// Only the HTTP edge in a process of its own: a bad upgrade must not stop it.
// No agents, files, relay or installed bridge are used.
const server = createHttpServer({
  auth: new Auth({ credentials: () => null }),
  allowedHosts: ["127.0.0.1"],
  version: "test",
} as HttpOptions);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") process.stdout.write(`${address.port}\n`);
});
