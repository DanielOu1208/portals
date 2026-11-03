#!/usr/bin/env python3
"""Run production sign-in button actions with a synthetic swipe and browser."""
import argparse
import pathlib
import runpy
import subprocess
import tempfile

support = runpy.run_path(str(pathlib.Path(__file__).with_name("native-test-support.py")))


def declaration(source, signature):
    """Retain a complete production Swift declaration or action body."""
    start = source.index(signature)
    opening = source.index("{", start)
    depth, end = 1, opening + 1
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
    args = parser.parse_args()
    root = args.repository.resolve()
    screen = (root / "Portals/App/MainScreen.swift").read_text()
    cards = (root / "Portals/Chat/MCPAuthCardView.swift").read_text()
    fixture = pathlib.Path(__file__).with_suffix(".swift").read_text()
    fixture = fixture.replace("/* PRODUCTION_GUARD */", declaration(screen, "struct SwipeGuard"))
    fixture = fixture.replace("/* PRODUCTION_CLEAR */", declaration(cards, "private func clearCode()"))
    for name, signature in [
        ("START", "Button(title)"), ("OPEN", 'Button("Open sign-in")'),
        ("SUBMIT", 'Button("Submit")'), ("CANCEL", 'Button("Cancel")'),
        ("RETRY", 'Button("Try again")'),
    ]:
        button = declaration(cards, signature)
        fixture = fixture.replace(f"/* PRODUCTION_{name} */", button[button.index("{") + 1:-1])
    # Both the list-retry container and each server card must read the inherited guard.
    if cards.count(r"@Environment(\.swipeGuard)") != 2:
        raise RuntimeError("The sign-in views must inherit the sidebar swipe guard")
    with tempfile.TemporaryDirectory(prefix="portals-native-mcp-auth-") as temporary:
        out = pathlib.Path(temporary)
        source = out / "NativeMCPAuthTests.swift"
        source.write_text(fixture)
        core = support["build_agent_core"](root, fresh=args.fresh_core)
        binary = out / "native-mcp-auth-tests"
        run(["swiftc", "-swift-version", "6", "-default-isolation", "MainActor", "-parse-as-library",
             *support["core_link_flags"](core),
             source, "-o", binary])
        run([binary])


if __name__ == "__main__":
    main()
