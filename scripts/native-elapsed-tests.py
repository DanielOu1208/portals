#!/usr/bin/env python3
"""Compile the app's actual elapsed schedule and run its deterministic regressions.

No app, simulator, bridge or network is launched. Compile once, then use --repeat
for consecutive lifecycle regressions without spending the time recompiling.
"""
import argparse
import pathlib
import subprocess
import tempfile

APP_FLAGS = [
    "-swift-version", "6", "-default-isolation", "MainActor",
    "-enable-upcoming-feature", "NonisolatedNonsendingByDefault",
    "-enable-upcoming-feature", "InferIsolatedConformances",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    root = args.repository.resolve()
    with tempfile.TemporaryDirectory(prefix="portals-native-elapsed-") as temporary:
        binary = pathlib.Path(temporary) / "native-elapsed-tests"
        subprocess.run([
            "swiftc", *APP_FLAGS, "-parse-as-library",
            str(root / "scripts/native-elapsed-tests.swift"),
            str(root / "Portals/Chat/ElapsedSchedule.swift"), "-o", str(binary),
        ], check=True)
        for _ in range(args.repeat):
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
