import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAccess } from "../src/access.ts";
import { access, AUD, certs, dayBody, get, NOW, post, server, TEAM, token } from "./helpers.ts";

// Everything but POST /v1/day is the maintainer's, through Cloudflare Access: the Worker
// checks Access's token itself, with keys made here standing in for the team's.

test("a valid Access token opens the page and its data", async () => {
  const { check, fetched } = access();
  const { handle } = server({ access: check });
  const page = await handle(get("/", token()));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /<title>Portals stats<\/title>/);
  assert.equal((await handle(get("/api/summary?days=7", token()))).status, 200);
  // The keys are fetched once and kept.
  assert.deepEqual(fetched, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test("without a valid token, everything but POST /v1/day is refused", async () => {
  const { check } = access();
  const { handle } = server({ access: check });
  const seconds = Math.floor(NOW / 1000);
  const refused: [string, string | undefined][] = [
    ["no token", undefined],
    ["not a JWT", "dana"],
    ["another key's signature", token({ otherKey: true })],
    ["a key the team does not have", token({ kid: "someone-else" })],
    ["another algorithm", token({ alg: "HS256" })],
    ["another application", token({ claims: { aud: ["another-aud"] } })],
    ["another team", token({ claims: { iss: "https://another-team.cloudflareaccess.com" } })],
    ["expired", token({ claims: { exp: seconds - 1 } })],
    ["no expiry", token({ claims: { exp: undefined } })],
    ["not yet valid", token({ claims: { nbf: seconds + 600 } })],
  ];
  for (const [what, bearer] of refused) {
    for (const path of ["/", "/api/summary?days=7", "/nowhere"]) {
      const response = await handle(get(path, bearer));
      assert.equal(response.status, 403, `${what} on ${path}`);
      assert.deepEqual(await response.json(), { detail: "Forbidden." });
    }
  }
  // The signature covers the claims: a valid token with its claims changed is refused.
  const [header, , signature] = token().split(".");
  const claims = Buffer.from(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: seconds + 3600, email: "someone@example.com" })).toString("base64url");
  assert.equal((await handle(get("/", `${header}.${claims}.${signature}`))).status, 403);
  // An email header alone is nothing.
  const emailOnly = new Request("https://stats.example/", { headers: { "cf-access-authenticated-user-email": "dana@example.com" } });
  assert.equal((await handle(emailOnly)).status, 403);
  // POST /v1/day still needs no token.
  assert.equal((await handle(post(dayBody()))).status, 204);
});

test("with Access not set up, only POST /v1/day is answered", async () => {
  assert.equal(makeAccess({ teamDomain: "", aud: AUD }), null);
  assert.equal(makeAccess({ teamDomain: TEAM, aud: "" }), null);
  assert.equal(makeAccess({ teamDomain: "not a host/", aud: AUD }), null);
  const { handle } = server({ access: null });
  assert.equal((await handle(get("/", token()))).status, 403);
  assert.equal((await handle(get("/api/summary?days=7", token()))).status, 403);
  assert.equal((await handle(post(dayBody()))).status, 204);
});

test("the team's domain may be written as an address", async () => {
  const check = makeAccess({ teamDomain: `https://${TEAM}/`, aud: AUD, now: () => NOW, fetch: async () => Response.json(certs()) });
  assert.ok(check);
  assert.equal(await check(get("/", token())), true);
});

test("a token naming an unknown key fetches the keys again, but not on every request", async () => {
  let now = NOW;
  const { check, fetched } = access({ now: () => now });
  assert.equal(await check(get("/", token())), true);
  assert.equal(await check(get("/", token({ kid: "rotated" }))), false);
  assert.equal(fetched.length, 1);
  now += 31_000;
  assert.equal(await check(get("/", token({ kid: "rotated" }))), false);
  assert.equal(fetched.length, 2);
  // An hour on, the keys are fetched again even for a known one.
  now += 3_601_000;
  await check(get("/", token({ claims: { exp: now / 1000 + 60 } })));
  assert.equal(fetched.length, 3);
});

test("the team's keys out of reach refuse, and are asked for again later", async () => {
  let up = false;
  let now = NOW;
  const fetched: string[] = [];
  const check = makeAccess({
    teamDomain: TEAM,
    aud: AUD,
    now: () => now,
    fetch: async (url) => {
      fetched.push(url);
      if (!up) throw new Error("offline");
      return Response.json(certs());
    },
  })!;
  assert.equal(await check(get("/", token())), false);
  up = true;
  now += 1000;
  assert.equal(await check(get("/", token())), true);
  assert.equal(fetched.length, 2);
});
