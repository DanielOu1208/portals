"""Fills in test/fixtures/push/plugin-payloads.json with the payload the Hermes plugin's
compose() gives for each case, as JSON, for test/notifier.test.ts to hold the bridge's
compose() to. Run from bridge/ with any Python 3, outside Hermes (nothing of Hermes is
loaded, so the plugin redacts nothing):

    python3 -I scripts/plugin-payloads.py
"""

import importlib.util
import json
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent.parent
FIXTURE = BRIDGE / "test" / "fixtures" / "push" / "plugin-payloads.json"
CORE = BRIDGE.parent / "hermes-plugin" / "aeriportal-push" / "core.py"

spec = importlib.util.spec_from_file_location("aeriportal_push_core", CORE)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
for case in fixture["cases"]:
    payload = core.compose(case["kind"], case["thread_id"], case["thread"], case["text"])
    # Compact, in the plugin's key order: what JSON.stringify gives for the same object.
    case["payload"] = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
FIXTURE.write_text(json.dumps(fixture, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")
print(f"{len(fixture['cases'])} payloads written to {FIXTURE.relative_to(BRIDGE)}")
