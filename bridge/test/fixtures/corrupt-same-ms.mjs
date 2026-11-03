// Force both recoveries to share a valid ISO timestamp, without changing real timers.
Date.prototype.toISOString = function () { return "2026-10-24T00:00:00.000Z"; };
