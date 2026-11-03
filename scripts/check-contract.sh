#!/bin/sh
# Checks the part of the Hermes gateway contract Portals uses against a Hermes build.
#
# Hermes rejects a request carrying a key its contract does not define, and the
# contract changes between Hermes versions. This compares
# Packages/PortalsKit/Tests/HermesBackendTests/Fixtures/contract-subset.json with a
# host's gateway-contract.openrpc.json and fails on anything the host does not have.
#
# The subset's `bridge` part (methods the app sends only to an portals-bridge that
# lists their feature in gateway.ready, and events it reads only from one) is checked
# only against a contract that lists `x-bridge-features`, which Hermes's does not.
#
#   scripts/check-contract.sh                       # this Mac's Hermes install
#   scripts/check-contract.sh path/to/contract.json # a copy from another host
#   scripts/check-contract.sh bridge/contract.json  # portals-bridge (same format; `npm run contract` rebuilds it)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBSET="$ROOT/Packages/PortalsKit/Tests/HermesBackendTests/Fixtures/contract-subset.json"
CONTRACT="${1:-$HOME/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json}"

exec python3 - "$SUBSET" "$CONTRACT" <<'PY'
import json
import sys

subset_path, contract_path = sys.argv[1], sys.argv[2]
subset = json.load(open(subset_path))
contract = json.load(open(contract_path))
schemas = contract.get("components", {}).get("schemas", {})


def resolve(schema):
    while isinstance(schema, dict) and "$ref" in schema:
        schema = schemas.get(schema["$ref"].rsplit("/", 1)[-1], {})
    return schema or {}


methods = {m["name"]: m for m in contract.get("methods", [])}
events = {n["name"] for n in contract.get("x-notifications", [])}
server_requests = {r["name"] for r in contract.get("x-server-requests", [])}

problems = []
for name, keys in subset["methods"].items():
    method = methods.get(name)
    if method is None:
        problems.append(f"method {name}: not in the contract")
        continue
    params = method.get("params") or []
    properties = resolve(params[0].get("schema")).get("properties", {}) if params else {}
    for key in keys:
        if key not in properties:
            problems.append(f"method {name}: param '{key}' is not in the contract")
    required = set(resolve(params[0].get("schema")).get("required", [])) if params else set()
    for key in sorted(required - set(keys)):
        problems.append(f"method {name}: the contract requires '{key}', which Portals never sends")

for name in subset["events"]:
    if name not in events:
        problems.append(f"event {name}: not in the contract")

for name in subset["server_requests"]:
    if name not in server_requests:
        problems.append(f"server request {name}: not in the contract")

bridge = subset.get("bridge", {})
features = contract.get("x-bridge-features")
if features is not None:
    for feature in bridge.get("features", []):
        if feature not in features:
            problems.append(f"bridge feature {feature}: not offered by this bridge")
    for name in bridge.get("events", {}):
        if name not in events:
            problems.append(f"bridge event {name}: not in the contract")
    for name, spec in bridge.get("methods", {}).items():
        method = methods.get(name)
        if method is None:
            problems.append(f"bridge method {name}: not in the contract")
            continue
        params = method.get("params") or []
        properties = resolve(params[0].get("schema")).get("properties", {}) if params else {}
        for key in spec.get("params", []):
            if key not in properties:
                problems.append(f"bridge method {name}: param '{key}' is not in the contract")
        required = set(resolve(params[0].get("schema")).get("required", [])) if params else set()
        for key in sorted(required - set(spec.get("params", []))):
            problems.append(f"bridge method {name}: the contract requires '{key}', which Portals never sends")

info = contract.get("info", {})
print(f"contract: {contract_path}")
print(f"  {info.get('title', '?')} v{info.get('version', '?')}: "
      f"{len(methods)} methods, {len(events)} events, {len(server_requests)} server requests")
print(f"subset:   {len(subset['methods'])} methods, {len(subset['events'])} events, "
      f"{len(subset['server_requests'])} server requests")
count = len(bridge.get("methods", {}))
bridge_events = len(bridge.get("events", {}))
bridge_methods = (f"{count} bridge-only method{'' if count == 1 else 's'} "
                  f"and {bridge_events} event{'' if bridge_events == 1 else 's'}")
if features is None:
    print(f"          {bridge_methods} skipped: this is not a bridge's contract, and the app uses them with no other host")
else:
    print(f"bridge:   {bridge_methods}; features offered: {', '.join(features)}")

if problems:
    print("\nFAILED")
    for problem in problems:
        print(f"  - {problem}")
    sys.exit(1)
print("\nOK: every method, param, event and server request Portals uses is in this contract.")
PY
