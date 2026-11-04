import "./environment.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { AskUserRequestParamsSchema, CliRequestOrNotificationSchema, RequestPermissionRequestParamsSchema, SessionNotificationSchema } from "@factory/droid-sdk/node";

// What the real Droid sent in every recording (fixtures/droid: CLI 1.3.0, and some kept from
// 0.247.0 and 1.0.0) parses as the SDK the bridge runs reads it: none of it is dropped
// before the bridge sees it, as SDK 0.9.1 dropped newer Droid's Script approvals.
const fixtures = new URL("./fixtures/droid/", import.meta.url);
/**
 * What Droid 1.3.0 sends that the pinned SDK cannot parse (the recorder's `dropped` rows): the
 * SDK drops these before any session handler, so only a raw read in `DroidTransport` could see them.
 */
const unknownToTheSDK = ["background_processes_changed", "child_session_settled"];
for (const name of readdirSync(fixtures).filter((file) => file.endsWith(".jsonl"))) {
  test(`every notification, approval and question Droid sent in ${name} parses with the SDK the bridge runs`, () => {
    const records = readFileSync(new URL(name, fixtures), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    const refused = records.flatMap((record, line) => {
      const parsed = record.kind === "notification" ? SessionNotificationSchema.safeParse(record.notification)
        : record.kind === "permission" ? RequestPermissionRequestParamsSchema.safeParse(record.params)
          : record.kind === "ask" ? AskUserRequestParamsSchema.safeParse(record.params) : undefined;
      return parsed && !parsed.success ? [`line ${line + 1}: ${record.kind} ${record.notification?.params?.notification?.type ?? ""}`] : [];
    });
    assert.deepEqual(refused, []);
    assert.ok(records.some((record) => record.kind === "notification"));
    // And what the SDK dropped is only what is known to be dropped, and is still dropped.
    for (const record of records.filter((entry) => entry.kind === "dropped")) {
      assert.ok(unknownToTheSDK.includes(record.frame.params?.notification?.type), `${name}: ${record.frame.method} ${record.frame.params?.notification?.type ?? ""}`);
      assert.equal(CliRequestOrNotificationSchema.safeParse(record.frame).success, false);
    }
  });
}
