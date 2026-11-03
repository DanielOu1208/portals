import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CursorProvider } from "../src/providers/cursor/provider.ts";
import { DroidProvider } from "../src/providers/droid/provider.ts";
import { cursorReport, cursorUsage, factoryReport, factoryUsage, open, PlanLimitsError } from "../src/providers/planLimits.ts";

// How much of their plans Droid and Cursor have used, asked of Factory and Cursor with the
// sign-ins their CLIs keep (planLimits.ts), from what those answered on 2026-11-01.

const factoryAnswer = {
  usesTokenRateLimitsBilling: true,
  hasActiveSubscription: true,
  limits: {
    standard: {
      fiveHour: { usedPercent: 1, windowEnd: "2026-11-02T04:33:56.917Z", secondsRemaining: 17580 },
      weekly: { usedPercent: 2, windowEnd: "2026-11-07T11:29:44.036Z", secondsRemaining: 474527 },
      monthly: { usedPercent: 28, windowEnd: "2026-11-15T22:31:16.911Z", secondsRemaining: 1205420 },
    },
    core: {
      fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
      weekly: { usedPercent: 42, windowEnd: "2026-11-07T09:31:25.473Z", secondsRemaining: 467429 },
      monthly: { usedPercent: 100, windowEnd: "2026-11-30T09:31:25.473Z", secondsRemaining: 2454629 },
    },
  },
  overagePreference: "droidCore",
  extraUsageBalanceCents: 1250,
};

const cursorPlan = { planInfo: { planName: "Pro", price: "$20/mo", billingCycleEnd: "1794625313000" } };
const cursorPeriod = {
  billingCycleStart: "1791946913000",
  billingCycleEnd: "1794625313000",
  planUsage: { totalSpend: 145, includedSpend: 145, remaining: 1855, limit: 2000, autoPercentUsed: 2.977777777777778, apiPercentUsed: 0.24444444444444444, totalPercentUsed: 1.6111111111111112 },
  enabled: true,
};

test("Factory's limits: the plan's windows, not Droid Core's (2026-11-01), each with its length, and extra usage left", () => {
  const report = factoryReport(factoryAnswer);
  assert.deepEqual(report.limits.map((limit) => [limit.name, limit.percent, limit.windowSeconds, limit.reached ?? false]), [
    ["5-hour", 1, 18000, false],
    ["weekly", 2, 604800, false],
    ["monthly", 28, 2592000, false],
  ]);
  assert.equal(report.limits[0].resetsAt, Math.floor(Date.parse("2026-11-02T04:33:56.917Z") / 1000));
  assert.equal(report.note, "Extra usage left: $12.50.");
  assert.equal(factoryReport({ hasActiveSubscription: false }).note, "No Factory subscription on this sign-in.");
});

test("Cursor's usage: what was spent of what is included, Auto and API, over the billing cycle, and the plan's name", () => {
  const report = cursorReport(cursorPlan, cursorPeriod);
  assert.equal(report.plan, "Pro");
  assert.deepEqual(report.limits.map((limit) => [limit.name, Math.round(limit.percent! * 100) / 100, limit.resetsAt, limit.windowSeconds]), [
    ["included", 7.25, 1794625313, 2678400],
    ["Auto", 2.98, 1794625313, 2678400],
    ["API", 0.24, 1794625313, 2678400],
  ]);
  // Without the plan's answer, the usage alone.
  assert.equal(cursorReport(null, cursorPeriod).plan, undefined);
});

function home(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "plan-limits-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function seal(text: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

test("Droid's sign-in is read as Droid keeps it, from the login keychain's key or its key file, and only read", async (t) => {
  const key = randomBytes(32);
  assert.equal(open(seal("hello", key), key), "hello");
  assert.equal(open(seal("hello", key), randomBytes(32)), null);

  const mac = home(t);
  mkdirSync(join(mac, ".factory"));
  writeFileSync(join(mac, ".factory", "auth.v2.loginkeychain"), seal(JSON.stringify({ access_token: "tok-mac", refresh_token: "r" }), key));
  const asked: string[] = [];
  const fetched: { url: string; auth: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    fetched.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify(factoryAnswer), { status: 200 });
  }) as typeof fetch;
  const report = await factoryUsage({ home: mac, os: "macos", env: {}, fetch: fakeFetch, keychain: async (service, account) => (asked.push(`${service}/${account}`), key.toString("base64")) });
  assert.deepEqual(asked, ["Factory CLI/auth-encryption-key-security-cli"]);
  assert.deepEqual(fetched, [{ url: "https://api.factory.ai/api/billing/limits", auth: "Bearer tok-mac" }]);
  assert.equal(report.limits.length, 3);

  const linux = home(t);
  mkdirSync(join(linux, ".factory"));
  writeFileSync(join(linux, ".factory", "auth.v2.file"), seal(JSON.stringify({ access_token: "tok-file" }), key));
  writeFileSync(join(linux, ".factory", "auth.v2.key"), key.toString("base64"));
  fetched.length = 0;
  await factoryUsage({ home: linux, os: "linux", env: {}, fetch: fakeFetch });
  assert.equal(fetched[0].auth, "Bearer tok-file");

  await assert.rejects(factoryUsage({ home: home(t), os: "linux", env: {}, fetch: fakeFetch }), /not signed in/);
  const expired = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(factoryUsage({ home: linux, os: "linux", env: {}, fetch: expired }), /expired/);
});

test("cursor-agent's sign-in is read from the login keychain on a Mac, else its auth.json, and both Dashboard calls are made with it", async (t) => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push(`${url.split("/").at(-1)} ${(init.headers as Record<string, string>).Authorization}`);
    return new Response(JSON.stringify(url.endsWith("GetPlanInfo") ? cursorPlan : cursorPeriod), { status: 200 });
  }) as typeof fetch;
  const report = await cursorUsage({ home: home(t), os: "macos", env: {}, fetch: fakeFetch, keychain: async (service) => (service === "cursor-access-token" ? "tok-cursor" : null) });
  assert.deepEqual(calls.sort(), ["GetCurrentPeriodUsage Bearer tok-cursor", "GetPlanInfo Bearer tok-cursor"]);
  assert.equal(report.plan, "Pro");

  const linux = home(t);
  mkdirSync(join(linux, ".config", "cursor"), { recursive: true });
  writeFileSync(join(linux, ".config", "cursor", "auth.json"), JSON.stringify({ accessToken: "tok-json" }));
  calls.length = 0;
  await cursorUsage({ home: linux, os: "linux", env: {}, fetch: fakeFetch });
  assert.ok(calls.every((call) => call.endsWith("Bearer tok-json")));
  await assert.rejects(cursorUsage({ home: home(t), os: "linux", env: {}, fetch: fakeFetch }), /not signed in/);
});

test("Claude's plan is named as Claude Code names it, from the profile it keeps (Ultra for what it still calls max)", async (t) => {
  const { planDisplayName } = await import("../src/providers/claude/usage.ts");
  const folder = home(t);
  writeFileSync(join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { planDisplayName: "Ultra", organizationRateLimitTier: "default_claude_max_20x" } }));
  assert.equal(await planDisplayName({ HOME: folder }), "Ultra");
  assert.equal(await planDisplayName({ HOME: "/nonexistent", CLAUDE_CONFIG_DIR: folder }), "Ultra");
  assert.equal(await planDisplayName({ HOME: home(t) }), null);
});

const cannotRead = /^This version of the host cannot read (Factory|Cursor)'s answer\.$/;

test("Factory's answer in a shape this version does not read says so, and says no limits apply only when the answer shows it", () => {
  for (const answer of [{}, null, "nope", [], { limits: {} }, { limits: { pro: { fiveHour: { usedPercent: 1 } } } }, { limits: { standard: { fiveHour: { usedPercent: "12" } } } }, { hasActiveSubscription: true }]) {
    const report = factoryReport(answer);
    assert.deepEqual(report.limits, [], JSON.stringify(answer));
    assert.match(report.note ?? "", cannotRead, JSON.stringify(answer));
  }
  assert.equal(factoryReport({ hasActiveSubscription: true, usesTokenRateLimitsBilling: false }).note, "Factory says no limits apply.");
  // Told apart from a plan with windows, whichever the field says then.
  assert.equal(factoryReport({ ...factoryAnswer, usesTokenRateLimitsBilling: false }).limits.length, 3);
});

test("a share that cannot be one is refused, and one past 100 is all of it, from Factory and from Cursor", () => {
  const factory = factoryReport({ limits: { standard: { fiveHour: { usedPercent: -5 }, weekly: { usedPercent: 140, windowEnd: "nope" }, monthly: { usedPercent: Number.POSITIVE_INFINITY } } } });
  assert.deepEqual(factory.limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false, limit.resetsAt]), [["weekly", 100, true, null]]);
  assert.match(factoryReport({ limits: { standard: { fiveHour: { usedPercent: -5 }, weekly: { usedPercent: Number.NaN } } } }).note ?? "", cannotRead);

  const cursor = cursorReport(null, { planUsage: { includedSpend: -1, limit: 100, totalPercentUsed: -2, autoPercentUsed: 250, apiPercentUsed: Number.POSITIVE_INFINITY } });
  assert.deepEqual(cursor.limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false]), [["Auto", 100, true]]);
  assert.deepEqual(cursorReport(null, { planUsage: { includedSpend: 2500, limit: 2000 } }).limits.map((limit) => [limit.name, limit.percent, limit.reached ?? false]), [["included", 100, true]]);
  assert.equal(cursorReport(null, { enabled: false }).note, "Cursor keeps no count of usage on this plan.");
  assert.equal(cursorReport(null, {}).note, "Cursor has not said yet.");
  for (const answer of [null, "nope", []]) assert.match(cursorReport(null, answer).note ?? "", cannotRead, JSON.stringify(answer));
});

test("a 200 that is not JSON gives that sentence, never a parser's words", async () => {
  const html = (async () => new Response("<html>a proxy's page</html>", { status: 200 })) as unknown as typeof fetch;
  assert.match((await factoryUsage({ env: { FACTORY_API_KEY: "key" }, fetch: html })).note ?? "", cannotRead);
  assert.match((await cursorUsage({ home: "/nonexistent", os: "macos", env: {}, fetch: html, keychain: async () => "tok" })).note ?? "", cannotRead);
});

test("a token that could not go in a header is refused before it is used, and never reaches an error", async () => {
  let fetched = 0;
  const counting = (async () => {
    fetched += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  for (const token of ["abc\ndefSECRET", "abc defSECRET", "abc\0defSECRET", "abcédefSECRET"]) {
    for (const asked of [
      factoryUsage({ env: { FACTORY_API_KEY: token }, fetch: counting }),
      cursorUsage({ home: "/nonexistent", os: "macos", env: {}, fetch: counting, keychain: async () => token }),
    ]) {
      await assert.rejects(asked, (error: Error) => {
        assert.ok(error instanceof PlanLimitsError, error.message);
        assert.doesNotMatch(error.message, /SECRET/);
        assert.match(error.message, /sign-in could not be read\.$/);
        return true;
      });
    }
  }
  assert.equal(fetched, 0);
});

test("whatever fetch throws is replaced by a fixed sentence: its words can hold the token", async () => {
  const failing = (async (_url: string, init: RequestInit) => {
    throw new TypeError(`Headers.append: "${(init.headers as Record<string, string>).Authorization}" is an invalid header value.`);
  }) as unknown as typeof fetch;
  const asks = [factoryUsage({ env: { FACTORY_API_KEY: "SECRET" }, fetch: failing }), cursorUsage({ home: "/nonexistent", os: "macos", env: {}, fetch: failing, keychain: async () => "SECRET" })];
  const [factory, cursor] = await Promise.allSettled(asks);
  assert.equal((factory as PromiseRejectedResult).reason.message, "Factory could not be reached.");
  assert.equal((cursor as PromiseRejectedResult).reason.message, "Cursor could not be reached.");
  assert.ok((factory as PromiseRejectedResult).reason instanceof PlanLimitsError);
});

test("Droid's usage is asked with the sign-in in the home Droid runs with, not this process's: FACTORY_HOME_OVERRIDE, else HOME", async (t) => {
  const key = randomBytes(32);
  const signedIn = (token: string): string => {
    const folder = home(t);
    mkdirSync(join(folder, ".factory"));
    writeFileSync(join(folder, ".factory", "auth.v2.file"), seal(JSON.stringify({ access_token: token }), key));
    writeFileSync(join(folder, ".factory", "auth.v2.key"), key.toString("base64"));
    return folder;
  };
  const tokens: string[] = [];
  const fetching = (async (_url: string, init: RequestInit) => {
    tokens.push((init.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify(factoryAnswer), { status: 200 });
  }) as unknown as typeof fetch;
  const usage = async (env: NodeJS.ProcessEnv) => {
    const directory = home(t);
    const provider = new DroidProvider({ command: "/not-a-real-droid", directory, idleMs: 100, maxWarm: 2, checkVersion: false, env, planLimits: { os: "linux", fetch: fetching } });
    t.after(() => provider.close());
    await provider.usage();
  };
  const plain = signedIn("tok-home");
  const override = signedIn("tok-override");
  await usage({ HOME: plain });
  await usage({ HOME: plain, FACTORY_HOME_OVERRIDE: override });
  assert.deepEqual(tokens, ["Bearer tok-home", "Bearer tok-override"]);
});

test("Cursor's usage is asked with the sign-in and the settings of the environment cursor-agent runs in", async (t) => {
  const folder = home(t);
  mkdirSync(join(folder, ".config", "cursor"), { recursive: true });
  writeFileSync(join(folder, ".config", "cursor", "auth.json"), JSON.stringify({ accessToken: "tok-cursor-home" }));
  const seen: string[] = [];
  const fetching = (async (url: string, init: RequestInit) => {
    seen.push(`${url.split("/aiserver")[0]} ${(init.headers as Record<string, string>).Authorization}`);
    return new Response(JSON.stringify(cursorPeriod), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new CursorProvider({ command: "/not-a-real-cursor", directory: home(t), idleMs: 100, checkVersion: false, cursorHome: null, env: { HOME: folder, CURSOR_API_ENDPOINT: "https://cursor.example" }, planLimits: { os: "linux", fetch: fetching } });
  t.after(() => provider.close());
  await provider.usage();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((line) => line === "https://cursor.example Bearer tok-cursor-home"), seen.join());
});
