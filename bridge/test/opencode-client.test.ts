import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("an enabled OpenCode provider with no client reports the setup/update repair instead of crashing", () => {
  const module = new URL("../src/providers/opencode/client.ts", import.meta.url).href;
  const script = `
    import { registerHooks } from "node:module";
    import assert from "node:assert/strict";
    registerHooks({ resolve(name, context, next) {
      if (name === "@opencode/client") throw new Error("client intentionally missing");
      return next(name, context);
    }});
    const { clientModule } = await import(${JSON.stringify(module)});
    await assert.rejects(clientModule(), /OpenCode's client is not installed.*npx portals-host@latest update.*npx portals-host@latest setup/);
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
});
