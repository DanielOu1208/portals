-- The anonymous daily totals (docs/plans/2026-11-06-token-analytics.md, section 6). One row
-- in `days` per day and install, and one in `usage` per day, install, agent and model. A
-- host that sends a day again replaces both (src/day.ts), so nothing counts twice. Nothing
-- here says who or where: `install` is a random id, `owner` a hash the host makes.

CREATE TABLE days (
  day TEXT NOT NULL,
  install TEXT NOT NULL,
  owner TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  turns INTEGER NOT NULL,
  portals_iphone INTEGER NOT NULL,
  portals_ipad INTEGER NOT NULL,
  portals_mac INTEGER NOT NULL,
  portals_other INTEGER NOT NULL,
  -- Milliseconds since 1970, when the server took the day.
  received_at INTEGER NOT NULL,
  PRIMARY KEY (day, install)
);

-- Distinct owners by day (daily, weekly and monthly actives) read from this index alone.
CREATE INDEX days_day_owner ON days (day, owner);

CREATE TABLE usage (
  day TEXT NOT NULL,
  install TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  -- API-equivalent US dollars at the host's prices; null for a model it has no price for.
  usd REAL,
  PRIMARY KEY (day, install, agent, model)
);
