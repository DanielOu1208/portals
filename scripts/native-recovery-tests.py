#!/usr/bin/env python3
"""Run the outgoing-message journal regressions against the real ThreadController.

Compiles AgentCore as a library, then scripts/native-recovery-tests.swift with the
app's actual ThreadController, AgentOfferings and ChatFeature (the probes the app's
other files provide are stubbed in the test file). No app, network or model is
launched; the harness is temporary and AgentCore is cached between launchers.
"""
import argparse
import pathlib
import runpy
import subprocess
import tempfile

support = runpy.run_path(str(pathlib.Path(__file__).with_name("native-test-support.py")))

APP_SOURCES = [
    "Portals/Chat/ThreadController.swift",
    "Portals/Chat/AgentOfferings.swift",
    "Portals/Chat/ChatFeature.swift",
]
# As the app target builds them (Portals.xcodeproj).
APP_FLAGS = [
    "-swift-version", "6", "-default-isolation", "MainActor",
    "-enable-upcoming-feature", "NonisolatedNonsendingByDefault",
    "-enable-upcoming-feature", "InferIsolatedConformances",
]


def run(command):
    subprocess.run([str(item) for item in command], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    support["add_core_arguments"](parser)
    args = parser.parse_args()
    root = args.repository.resolve()
    with tempfile.TemporaryDirectory(prefix="portals-native-recovery-") as temporary:
        out = pathlib.Path(temporary)
        core = support["build_agent_core"](root, fresh=args.fresh_core)
        binary = out / "native-recovery-tests"
        run(["swiftc", *APP_FLAGS, "-parse-as-library",
             *support["core_link_flags"](core),
             root / "scripts/native-recovery-tests.swift", *[root / source for source in APP_SOURCES], "-o", binary])
        run([binary])


if __name__ == "__main__":
    main()
