import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

// A dependency refresh must keep the collection-size guard: older Zod parsed every
// element before refusing the container, so a small maximum did not bound its work.
for (const kind of ["array", "set"] as const) {
  test(`Zod refuses an oversized ${kind} before parsing its elements`, () => {
    let parsed = 0;
    const element = z.number().transform((value) => {
      parsed += 1;
      return value;
    });
    const schema = kind === "array" ? z.array(element).max(1) : z.set(element).max(1);
    const values = Array.from({ length: 1000 }, (_, index) => index);
    const result = schema.safeParse(kind === "array" ? values : new Set(values));
    assert.equal(result.success, false);
    assert.equal(parsed, 0);
    if (!result.success) assert.equal(result.error.issues[0].code, "too_big");

    const allowed = kind === "array" ? [7] : new Set([7]);
    assert.deepEqual(schema.parse(allowed), allowed);
    assert.equal(parsed, 1);
    assert.equal(schema.safeParse(kind === "array" ? ["not a number"] : new Set(["not a number"])).success, false);
  });
}
