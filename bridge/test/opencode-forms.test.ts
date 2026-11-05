import assert from "node:assert/strict";
import { test } from "./opencode-test.ts";
import { formCard, formAnswer } from "../src/providers/opencode/forms.ts";
import type { FormInfo } from "@opencode/client";

const form: FormInfo = {
  id: "frm_test", sessionID: "ses_test", title: "Choices",
  fields: [
    { key: "one", type: "string", required: true, options: [{ label: "First", value: "one" }] },
    { key: "many", type: "multiselect", options: [{ label: "A, B", value: "ab" }, { label: "C", value: "c" }] },
    { key: "flag", type: "boolean" },
    { key: "count", type: "integer", minimum: 1 },
  ],
};

test("OpenCode forms preserve field keys, choice values, multiple labels with commas and primitive types", () => {
  const card = formCard(form);
  assert.equal(card.questions[0].qid, "one");
  assert.deepEqual(card.questions[0].choices, ["First"]);
  assert.equal(card.questions[1].multiSelect, true);
  assert.deepEqual(formAnswer(form, { one: "First", many: "A, B, C", flag: "Yes", count: "2" }), { one: "one", many: ["ab", "c"], flag: true, count: 2 });
});

test("forms never silently coerce invalid answers or omit required values", () => {
  assert.throws(() => formAnswer(form, { one: "invented" }), /option/);
  assert.throws(() => formAnswer(form, { one: "First", count: "1.5" }), /integer/);
  assert.throws(() => formAnswer(form, { one: "First", count: "0" }), /at least/);
  assert.throws(() => formAnswer(form, {}), /required/);
});

test("forms the existing card cannot represent clearly request OpenCode's native UI", () => {
  assert.throws(() => formCard({ ...form, fields: [{ key: "login", type: "external", url: "https://example.com" }] }), /OpenCode/);
  assert.throws(() => formCard({ ...form, fields: [{ key: "secret", type: "string", hidden: true }] }), /OpenCode/);
  assert.throws(() => formCard({ ...form, fields: [{ key: "ambiguous", type: "multiselect", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "A, B", value: "ab" }] }] }), /OpenCode/);
});
