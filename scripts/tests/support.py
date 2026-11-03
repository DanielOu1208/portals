"""Disposable, offline fixtures for the command-line tooling regressions."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
STUB = r'''import json, os, pathlib, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps([name, *args]) + "\n")
if name == "xcrun":
    if args[:3] == ["simctl", "list", "devices"]:
        print(json.dumps({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{
            "udid": "AUDIT-SIM", "isAvailable": True,
            "state": os.environ.get("SIM_STATE", "Booted")
        }]}}))
        sys.exit(0)
    if args[:2] == ["simctl", "install"]:
        sys.exit(73)
    if args[:2] in (["simctl", "terminate"], ["simctl", "uninstall"]):
        sys.exit(0)
elif name == "codesign":
    sys.exit(int(os.environ.get("SIGN_EXIT", "0")))
elif name == "xcodebuild":
    if args and args[0] == "archive":
        # ARCHIVE_FAIL: "*" (the default) fails every archive, "" none, else those whose
        # destination contains it.
        destination = args[args.index("-destination") + 1] if "-destination" in args else ""
        failing = os.environ.get("ARCHIVE_FAIL", "*")
        if failing == "*" or (failing and failing in destination):
            sys.exit(73)
        pathlib.Path(args[args.index("-archivePath") + 1]).mkdir(parents=True)
        sys.exit(0)
    if args and args[0] == "-exportArchive":
        sys.exit(int(os.environ.get("EXPORT_EXIT", "0")))
    if args and args[0] == "test-without-building":
        mode = os.environ.get("UI_MODE", "ok")
        marks = ["1 open Long 60"]
        if mode != "no-ink": marks.append("2 ink 0.2000 Long 60")
        if mode != "no-done": marks.append("3 done")
        pathlib.Path(os.environ["UIDIR"], "marks.txt").write_text("\n".join(marks) + "\n")
        print("Test Case 'BlankUITests.testOpenFromSidebar' passed", flush=True)
        if mode == "verdict-then-fail":
            # The suite said passed, then xcodebuild failed on its own as it finished.
            print("Test Suite 'Selected tests' passed", flush=True)
            import time; time.sleep(0.5)
            sys.exit(65)
        if mode in ("linger", "linger-fail"):
            # As xcodebuild does at times: the tests over, it stays on.
            print("Test Suite 'Selected tests' " + ("failed" if mode == "linger-fail" else "passed"), flush=True)
            import time; time.sleep(60)
        sys.exit(65 if mode == "fail" else 0)
elif name == "git":
    if args and args[0] == "status":
        if os.environ.get("GIT_STATUS_EXIT"):
            sys.exit(int(os.environ["GIT_STATUS_EXIT"]))
        sys.exit(subprocess.run(["/usr/bin/git", *args]).returncode)
    if args == ["rev-parse", "--short", "HEAD"]:
        print("abcdef0")
        sys.exit(0)
    if args and args[0] == "tag":
        sys.exit(0)
elif name == "kill":
    sys.exit(0)
print("forbidden offline command: " + name + " " + repr(args), file=sys.stderr)
sys.exit(90)
'''


class ToolTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="portals-tool-test-", dir="/private/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls.jsonl"
        self.env = {**os.environ, "PATH": f"{self.bin}:/usr/bin:/bin",
                    "HOME": str(self.root), "TMPDIR": str(self.root), "CALLS": str(self.calls)}
        for name in ("xcrun", "xcodebuild", "codesign", "node", "swiftc", "open", "defaults", "git", "kill"):
            path = self.bin / name
            path.write_text(f"#!{sys.executable}\n{STUB}")
            path.chmod(0o755)

    def copy(self, relative):
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)
        return target

    def run_command(self, args, **kwargs):
        return subprocess.run(args, cwd=self.repo, env=self.env, capture_output=True,
                              text=True, timeout=10, **kwargs)

    def shell(self, relative, *args):
        script = self.copy(relative)
        # A script's builtin kill cannot bypass the recording stub.
        return self.run_command(["/bin/zsh", "-c", 'disable kill; source "$0" "$@"', str(script), *map(str, args)])

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def app(self):
        app = self.root / "source.app"
        app.mkdir()
        with (app / "Info.plist").open("wb") as f:
            plistlib.dump({"CFBundleIdentifier": "com.danielou.portals",
                          "CFBundleURLTypes": [{"CFBundleURLSchemes": ["portals"]}]}, f)
        (app / "PlugIns").mkdir()
        (app / "PlugIns" / "unchanged").write_text("source")
        return app


def function(relative, name):
    source = (ROOT / relative).read_text()
    start = source.index(f"\n{name}() {{") + 1
    return source[start:source.index("\n}\n", start) + 3]


def load_threads():
    path = ROOT / "scripts/phone-bench/threads.py"
    module = {"__name__": "threads_regression"}
    exec(compile(path.read_text(), str(path), "exec"), module)
    return module
