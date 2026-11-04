#!/usr/bin/env python3
"""Run net-switch regressions with the app's actual switching and notification methods.

The app imports UIKit, so compile just these methods with the host/fleet probes
stubbed, against the real AgentCore. No app, network, Keychain or agent is used.
"""
import argparse
import pathlib
import runpy
import subprocess
import tempfile

support = runpy.run_path(str(pathlib.Path(__file__).with_name("native-test-support.py")))


def method(source, signature):
    start = source.index(signature)
    end = source.index("{", start) + 1
    depth = 1
    while depth:
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
        end += 1
    return source[start:end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    support["add_core_arguments"](parser)
    args = parser.parse_args()
    root = args.repository.resolve()
    source = (root / "Portals/App/Net.swift").read_text()
    methods = "\n\n".join(method(source, signature) for signature in [
        "func said(", "private func leaveIfEveryMacRefuses(", "private func isCurrent(",
        "private func become(", "func leave()", "private func leaveHere(",
    ])
    template = (root / "scripts/native-net-tests.swift").read_text()
    sheet = (root / "Portals/Settings/HostSettingsSheet.swift").read_text()
    template = template.replace("// APP_OUTCOME", method(source, "enum Outcome: Equatable"))
    # run(), and what its guard on a loopback address reads.
    template = template.replace("// SHEET_RUN", "\n\n".join(method(sheet, signature) for signature in [
        "private func run(", "private var addressIsTheDeviceItself:", "private var isOnlyOnThisMac:",
    ]))
    with tempfile.TemporaryDirectory(prefix="portals-native-net-") as temporary:
        out = pathlib.Path(temporary)
        core = support["build_agent_core"](root, fresh=args.fresh_core)
        probe = out / "native-net-tests.swift"
        probe.write_text(template.replace("// APP_METHODS", methods))
        binary = out / "native-net-tests"
        subprocess.run([
            "swiftc", "-swift-version", "6", "-parse-as-library",
            *map(str, support["core_link_flags"](core)), str(probe), "-o", str(binary),
        ], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
