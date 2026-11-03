import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider } from "../src/providers/types.ts";

// Loaded before the bridge in a bridge run as a process (`node --import <this> src/main.ts`),
// for test/lifetime.test.ts, with PORTALS_TEST_TROUBLE saying what goes wrong:
//
//   rejection   on SIGUSR2, a promise fails with nothing to catch it
//   exception   on SIGUSR2, an exception nothing catches
//   hang        a session of the scripted agent never closes
//   hang-agent  the scripted agent itself never closes
//
// Otherwise each session of the scripted agent says on standard output when it has
// closed, `closed <thread>`, and the agent when it closes, `agent closed`.

const trouble = process.env.PORTALS_TEST_TROUBLE;

(FakeProvider.prototype as Provider).close = trouble === "hang-agent" ? () => new Promise<void>(() => undefined) : async () => void process.stdout.write("agent closed\n");

const start = FakeProvider.prototype.startSession;
FakeProvider.prototype.startSession = async function (options, sink) {
  const session = await start.call(this, options, sink);
  const close = session.close.bind(session);
  session.close =
    trouble === "hang"
      ? () => new Promise<void>(() => undefined)
      : async () => {
          await close();
          process.stdout.write(`closed ${options.id}\n`);
        };
  return session;
};

process.on("SIGUSR2", () => {
  if (trouble === "rejection") void Promise.reject(new Error("nobody waits for this"));
  if (trouble === "exception") {
    setImmediate(() => {
      throw new Error("nothing catches this");
    });
  }
});
