import { makeAccess, type AccessCheck } from "./access.ts";
import type { D1Database, Limiter } from "./d1.ts";
import { makeStats } from "./stats.ts";

// The stats server as a Cloudflare Worker (wrangler.jsonc). It holds no secret: the Access
// team's domain and the application's AUD tag are plain vars, since a token can only be
// signed by the team's own keys, which the Worker fetches from the team.

interface Env {
  DB: D1Database;
  DAY_LIMIT?: Limiter;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

// One Access check per Worker instance and settings, so the team's keys are fetched once
// an hour, not once a request.
let access: { settings: string; check: AccessCheck | null } | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const teamDomain = env.ACCESS_TEAM_DOMAIN ?? "";
    const aud = env.ACCESS_AUD ?? "";
    const settings = `${teamDomain}\n${aud}`;
    if (access?.settings !== settings) access = { settings, check: makeAccess({ teamDomain, aud }) };
    return makeStats({ db: env.DB, dayLimit: env.DAY_LIMIT, access: access.check })(request);
  },
};
