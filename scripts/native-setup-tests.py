#!/usr/bin/env python3
"""Run setup/registration regressions without launching the app or using OS services."""
import argparse
import pathlib
import re
import runpy
import subprocess
import tempfile

support = runpy.run_path(str(pathlib.Path(__file__).with_name("native-test-support.py")))


def declaration(source, signature):
    """Take one complete Swift declaration, retaining its production body verbatim."""
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        if end >= len(source):
            raise RuntimeError(f"Unbalanced Swift declaration: {signature}")
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


def run(command):
    subprocess.run([str(item) for item in command], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    support["add_core_arguments"](parser)
    parser.add_argument("--topic", choices=["all", "registration", "connection", "credentials", "hostpush"], default="all")
    args = parser.parse_args()
    root = args.repository.resolve()
    fixture = pathlib.Path(__file__).with_suffix(".swift").read_text()
    available = re.findall(r"^\s*// TEST_TOPIC: (\w+)$", fixture, re.MULTILINE)
    selected = available if args.topic == "all" else [args.topic]
    if not selected or any(topic not in available for topic in selected):
        raise RuntimeError("Requested regression topic is not present in this checkout")
    push = (root / "Portals/Notifications/PushCoordinator.swift").read_text()
    settings = (root / "Portals/Settings/HostSettingsSheet.swift").read_text()
    credential_path = root / "Portals/Settings/KeychainCredentialStore.swift"
    credential = credential_path.read_text()
    relay_path = root / "Portals/Notifications/RelayRegistration.swift"

    # No new Security API may silently escape the synthetic test implementation.
    allowed_security_calls = {"SecItemCopyMatching", "SecItemDelete", "SecItemAdd", "SecItemUpdate"}
    calls = set(re.findall(r"\b(SecItem\w+)\s*\(", credential))
    if calls - allowed_security_calls:
        raise RuntimeError(f"Unmocked Security calls: {sorted(calls - allowed_security_calls)}")
    for call in allowed_security_calls:
        if f"func {call}(" not in fixture:
            raise RuntimeError(f"Missing Security interception: {call}")
    relay = relay_path.read_text()
    if re.search(r"\bFoundation\.(?:Bundle|UserDefaults|URLSession)\b", relay):
        raise RuntimeError("Qualified Foundation access would bypass test interception")

    fixture = fixture.replace("/* PRODUCTION_REGISTERED */", declaration(push, "func registered(with token:"))
    fixture = fixture.replace("/* PRODUCTION_LAST_TOKEN */", declaration(push, "var lastDeviceToken:"))
    fixture = fixture.replace("/* PRODUCTION_LAST_TOKEN_KEY */", declaration(push, "private static var lastTokenKey:"))
    fixture = fixture.replace("/* PRODUCTION_ENVIRONMENT */", declaration(push, "static var environment:"))
    host = (root / "Portals/App/HostModel.swift").read_text()
    fixture = fixture.replace("/* PRODUCTION_HOST_REGISTER */", declaration(host, "func registerForPush("))
    fixture = fixture.replace("/* PRODUCTION_START_TRIAL */", declaration(settings, "private func startTrial()"))
    fixture = fixture.replace("/* PRODUCTION_STOP_TRIAL */", declaration(settings, "private func stopTrial()"))
    limit = re.search(r"^\s*private static let trialLimit:.*$", settings, re.MULTILINE)
    if limit is None:
        raise RuntimeError("Production connection trial deadline not found")
    fixture = fixture.replace("/* PRODUCTION_TRIAL_LIMIT */", limit[0].strip())
    fixture = fixture.replace("/* PRODUCTION_TRY_CONNECTION */", declaration(settings, "private func tryConnection()"))
    invalidation = declaration(settings, ".onChange(of: [address, username, password])")
    fixture = fixture.replace("/* PRODUCTION_INVALIDATION */", invalidation[invalidation.index("{") + 1:-1])
    if re.search(r"/\* PRODUCTION_\w+ \*/", fixture):
        raise RuntimeError("Unfilled production declaration in the setup fixture")

    with tempfile.TemporaryDirectory(prefix="portals-native-setup-") as temporary:
        out = pathlib.Path(temporary)
        source = out / "NativeSetupTests.swift"
        source.write_text(fixture)
        core = support["build_agent_core"](root, fresh=args.fresh_core)
        binary = out / "native-setup-tests"
        definitions = [f"-DTEST_{topic.upper()}" for topic in selected]
        run(["swiftc", "-swift-version", "6", "-default-isolation", "MainActor", "-parse-as-library",
             *definitions,
             *support["core_link_flags"](core),
             source, credential_path, relay_path, "-o", binary])
        undefined = subprocess.check_output(["nm", "-u", str(binary)], text=True)
        if re.search(r"\b_SecItem\w+\b", undefined):
            raise RuntimeError("Test binary references a real Security function")
        run([binary])


if __name__ == "__main__":
    main()
