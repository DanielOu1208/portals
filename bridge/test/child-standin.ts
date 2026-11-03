import { spawn } from "node:child_process";

// A stand-in for an agent's program, for the tests of the bridge's end of such a child
// process (test/child.test.ts). It reads one JSON value per line and does what each says:
//
//   {do: "echo", value, times?}      prints the value back, `times` times over
//   {do: "write", parts, to?}        writes each part as it is, with a pause between them;
//                                    parts are base64, so one can end in the middle of a
//                                    character; `to: "stderr"` writes to standard error
//   {do: "deaf"}                     ignores SIGTERM from now on, and says so
//   {do: "spawn", deaf?, inherit?}   starts a process of its own that never ends by itself
//                                    and says its id once that runs; `deaf`: that one
//                                    ignores SIGTERM; `inherit`: it writes where the
//                                    stand-in writes, and so holds its output open
//   {do: "exit", code}               ends with that code, once what it wrote has gone out
//
// Closing its input does not end it.

interface Order {
  do: "echo" | "write" | "deaf" | "spawn" | "exit";
  value?: unknown;
  times?: number;
  parts?: string[];
  to?: "stderr";
  deaf?: boolean;
  inherit?: boolean;
  code?: number;
}

function say(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function act(order: Order): void {
  switch (order.do) {
    case "echo":
      for (let count = 0; count < (order.times ?? 1); count++) say({ echo: order.value });
      return;
    case "write": {
      const stream = order.to === "stderr" ? process.stderr : process.stdout;
      (order.parts ?? []).forEach((part, index) => {
        if (index === 0) stream.write(Buffer.from(part, "base64"));
        else setTimeout(() => stream.write(Buffer.from(part, "base64")), index * 40);
      });
      return;
    }
    case "deaf":
      process.on("SIGTERM", () => undefined);
      say({ deaf: true });
      return;
    case "spawn": {
      const script = `${order.deaf ? 'process.on("SIGTERM", () => undefined);' : ""} setInterval(() => undefined, 1000);`;
      // Its id only once it runs, and so is deaf if it was to be.
      if (order.inherit) {
        // It says so itself, on the output it shares with the stand-in.
        spawn(process.execPath, ["-e", `${script} console.log(JSON.stringify({ spawned: process.pid }));`], { stdio: ["ignore", "inherit", "inherit"] });
        return;
      }
      const started = spawn(process.execPath, ["-e", `${script} console.log("ready");`], { stdio: ["ignore", "pipe", "ignore"] });
      started.stdout.once("data", () => say({ spawned: started.pid }));
      return;
    }
    case "exit":
      process.stdout.write("", () => process.stderr.write("", () => process.exit(order.code ?? 0)));
      return;
  }
}

let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (rest + chunk).split("\n");
  rest = lines.pop() ?? "";
  for (const line of lines) if (line !== "") act(JSON.parse(line) as Order);
});
setInterval(() => undefined, 1000);
