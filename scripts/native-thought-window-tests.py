#!/usr/bin/env python3
"""Exercise production thought-window lifecycle with real AgentCore and a label stand-in."""
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
    setup = runpy.run_path(str(pathlib.Path(__file__).with_name("native-setup-tests.py")))
    declaration, run = setup["declaration"], setup["run"]
    source = (root / "Portals/Chat/ThoughtWindow.swift").read_text()
    methods = "\n\n".join(declaration(source, signature) for signature in [
        "func show(", "private func render(", "private func fadeOut()",
        "private func putInPlaceCalmly()", "func stop()",
    ])
    fixture = pathlib.Path(__file__).with_suffix(".swift").read_text().replace("/* PRODUCTION */", methods)
    with tempfile.TemporaryDirectory(prefix="portals-native-thought-window-") as temporary:
        out = pathlib.Path(temporary)
        test = out / "ThoughtWindowTests.swift"
        test.write_text(fixture)
        core = support["build_agent_core"](root, fresh=args.fresh_core)
        binary = out / "native-thought-window-tests"
        run(["swiftc", "-swift-version", "6", "-default-isolation", "MainActor", "-parse-as-library",
             *support["core_link_flags"](core),
             test, "-o", binary])
        for iteration in range(1, args.repeat + 1):
            print(f"REPEAT {iteration}/{args.repeat}", flush=True)
            run([binary])


if __name__ == "__main__":
    main()
