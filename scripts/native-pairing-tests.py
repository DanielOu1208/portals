#!/usr/bin/env python3
"""Exercise current pairing-sheet actions with real AgentCore and an in-memory net."""
import argparse
import pathlib
import runpy
import tempfile

support = runpy.run_path(str(pathlib.Path(__file__).with_name("native-test-support.py")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    support["add_core_arguments"](parser)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    root = args.repository.resolve()
    # Share the existing declaration extractor without running its setup topics.
    setup = runpy.run_path(str(pathlib.Path(__file__).with_name("native-setup-tests.py")))
    declaration, run = setup["declaration"], setup["run"]
    settings = (root / "Portals/Settings/HostSettingsSheet.swift").read_text()
    fixture = pathlib.Path(__file__).with_suffix(".swift").read_text()
    signatures = [
        "private var decision:", "private func addFromCode()", "private func switchNet()",
        "private func run(", "private var config:", "private var suggestedName:",
    ]
    # The pre-fix source has no derived pairing property. Keep it compilable so the
    # regression fails on observed behavior, not a missing declaration.
    if "private var pairingAsTyped:" in settings:
        signatures.append("private var pairingAsTyped:")
    declarations = "\n\n".join(declaration(settings, signature) for signature in signatures)
    fixture = fixture.replace("/* PRODUCTION_ACTIONS */", declarations)
    invalidation = declaration(settings, ".onChange(of: [address, username, password])")
    fixture = fixture.replace("/* PRODUCTION_INVALIDATION */", invalidation[invalidation.index("{") + 1:-1])

    with tempfile.TemporaryDirectory(prefix="portals-native-pairing-") as temporary:
        out = pathlib.Path(temporary)
        source = out / "NativePairingTests.swift"
        source.write_text(fixture)
        core = support["build_agent_core"](root, fresh=args.fresh_core)
        binary = out / "native-pairing-tests"
        run(["swiftc", "-swift-version", "6", "-default-isolation", "MainActor", "-parse-as-library",
                   *support["core_link_flags"](core),
                   source, "-o", binary])
        for iteration in range(1, args.repeat + 1):
            print(f"REPEAT {iteration}/{args.repeat}", flush=True)
            run([binary])


if __name__ == "__main__":
    main()
