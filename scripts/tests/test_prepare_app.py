"""Actual Mac copy helper and caller, with only owned temporary apps and inert tools."""
from pathlib import Path
import plistlib
import sys

from support import ToolTest


class PrepareAppTests(ToolTest):
    def setUp(self):
        super().setUp()
        self.helper = "scripts/mac-scroll-bench/prepare-app.sh"
        self.bundle = "com.danielou.portals.copy-regression"
        # Record destructive operations, but allow them only on this test's fixtures.
        wrapper = f"""#!{sys.executable}
import json, os, pathlib, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps([name, *args]) + "\\n")
root = pathlib.Path(os.environ["HOME"])
for arg in args:
    if not arg.startswith("-") and not pathlib.Path(arg).is_relative_to(root):
        raise SystemExit("refused non-fixture path: " + arg)
raise SystemExit(subprocess.run(["/bin/" + name, *args]).returncode)
"""
        for name in ("rm", "cp"):
            path = self.bin / name
            path.write_text(wrapper)
            path.chmod(0o755)

    def mac_app(self, path=None):
        app = path or self.root / "source.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/MacOS/Portals").write_text("inert executable fixture")
        (app / "input-sentinel").write_text("source must survive")
        for part in ("PlugIns", "_CodeSignature"):
            (app / "Contents" / part).mkdir()
            (app / "Contents" / part / "input").write_text("unchanged")
        with (app / "Contents/Info.plist").open("wb") as f:
            plistlib.dump({"CFBundleIdentifier": "com.danielou.portals",
                          "CFBundleURLTypes": [{"CFBundleURLSchemes": ["portals"]}]}, f)
        return app

    def assert_refused(self, source, destination):
        self.calls.unlink(missing_ok=True)
        result = self.shell(self.helper, source, destination, self.bundle)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse([c for c in self.recorded() if c[0] in ("rm", "cp", "codesign")],
                         self.recorded())
        self.assertEqual((source.resolve() / "input-sentinel").read_text(), "source must survive")

    def test_equal_source_is_refused_before_cleanup(self):
        source = self.mac_app()
        self.assert_refused(source, source)

    def test_destination_ancestor_is_refused_before_cleanup(self):
        destination = self.root / "previous-run"
        source = self.mac_app(destination / "app.app")
        self.assert_refused(source, destination)

    def test_destination_descendant_is_refused_before_cleanup(self):
        source = self.mac_app()
        self.assert_refused(source, source / "nested/copy.app")

    def test_canonical_alias_overlaps_are_refused_before_cleanup(self):
        for case in ("source-alias", "destination-alias", "parent-alias", "nested-alias"):
            with self.subTest(case=case):
                base = self.root / case
                source = self.mac_app(base / "source.app")
                alias = base / "alias.app"
                alias.symlink_to(source)
                parent = base / "alias-parent"
                parent.symlink_to(base)
                supplied = alias if case in ("source-alias", "nested-alias") else source
                destination = {"source-alias": source, "destination-alias": alias,
                               "parent-alias": parent / "source.app",
                               "nested-alias": parent / "source.app/nested.app"}[case]
                self.assert_refused(supplied, destination)
                self.assertTrue(alias.is_symlink())
                self.assertTrue(parent.is_symlink())

    def test_case_alias_overlaps_are_refused_before_cleanup(self):
        for case in ("source", "destination", "descendant"):
            with self.subTest(case=case):
                source = self.mac_app(self.root / case / "source.app")
                alias = source.with_name("SOURCE.APP")
                if not alias.exists():
                    self.skipTest("Requires a case-insensitive filesystem")
                self.assertTrue(alias.samefile(source))
                supplied = alias if case == "source" else source
                destination = source if case == "source" else alias
                if case == "descendant":
                    destination /= "nested.app"
                self.assert_refused(supplied, destination)

    def test_external_links_fail_before_existing_destination_is_cleaned(self):
        for part in ("Info.plist", "PlugIns", "MacOS/Portals"):
            with self.subTest(part=part):
                source = self.mac_app(self.root / part.replace("/", "-") / "source.app")
                destination = source.parent / "copy.app"
                destination.mkdir()
                (destination / "keep").write_text("existing copy")
                target = source / "Contents" / part
                outside = source.parent / "outside"
                if target.is_dir():
                    target.rename(outside)
                else:
                    outside.write_bytes(target.read_bytes())
                    target.unlink()
                target.symlink_to(outside)
                self.assert_refused(source, destination)
                self.assertEqual((destination / "keep").read_text(), "existing copy")
                self.assertTrue(outside.exists())

    def test_dangling_links_fail_before_existing_destination_is_cleaned(self):
        for part in ("Info.plist", "MacOS/Portals"):
            with self.subTest(part=part):
                source = self.mac_app(self.root / part.replace("/", "-") / "source.app")
                destination = source.parent / "copy.app"
                destination.mkdir()
                (destination / "keep").write_text("existing copy")
                target = source / "Contents" / part
                target.unlink()
                target.symlink_to("missing")
                self.assert_refused(source, destination)
                self.assertEqual((destination / "keep").read_text(), "existing copy")

    def test_disjoint_copy_preserves_source_alias_and_framework_links(self):
        for use_alias in (False, True):
            with self.subTest(source_alias=use_alias):
                base = self.root / str(use_alias)
                source = self.mac_app(base / "source.app")
                original = (source / "Contents/Info.plist").read_bytes()
                framework = source / "Contents/Frameworks/Fixture.framework"
                (framework / "Versions/A").mkdir(parents=True)
                (framework / "Versions/A/Fixture").write_text("framework bytes")
                (framework / "Versions/Current").symlink_to("A")
                (framework / "Fixture").symlink_to("Versions/Current/Fixture")
                supplied = source
                if use_alias:
                    supplied = base / "alias.app"
                    supplied.symlink_to(source)
                destination = base / "copy.app"
                result = self.shell(self.helper, supplied, destination, self.bundle)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse(destination.is_symlink())
                with (destination / "Contents/Info.plist").open("rb") as f:
                    info = plistlib.load(f)
                self.assertEqual(info["CFBundleIdentifier"], self.bundle)
                self.assertNotIn("CFBundleURLTypes", info)
                self.assertFalse((destination / "Contents/PlugIns").exists())
                self.assertFalse((destination / "Contents/_CodeSignature").exists())
                copied_link = destination / "Contents/Frameworks/Fixture.framework/Fixture"
                self.assertTrue(copied_link.is_symlink())
                self.assertEqual(copied_link.read_text(), "framework bytes")
                self.assertTrue(copied_link.resolve().is_relative_to(destination))
                self.assertEqual((source / "Contents/Info.plist").read_bytes(), original)
                self.assertTrue((source / "Contents/PlugIns/input").exists())
                self.assertTrue((source / "Contents/_CodeSignature/input").exists())
                if use_alias:
                    self.assertTrue(supplied.is_symlink())

    def test_disjoint_copy_resolves_source_symlink_before_parent(self):
        source = self.mac_app(self.root / "physical/source.app")
        original = (source / "Contents/Info.plist").read_bytes()
        (source.parent / "subdir").mkdir()
        alias = self.root / "source-alias"
        alias.symlink_to(source.parent / "subdir")
        supplied = alias / "../source.app"
        destination = self.root / "separate-copy.app"
        self.assertEqual(supplied.resolve(), source)
        result = self.shell(self.helper, supplied, destination, self.bundle)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((source / "Contents/Info.plist").read_bytes(), original)
        self.assertFalse(destination.is_symlink())
        with (destination / "Contents/Info.plist").open("rb") as f:
            self.assertEqual(plistlib.load(f)["CFBundleIdentifier"], self.bundle)

    def test_destination_root_link_is_not_followed_and_emptied(self):
        source = self.mac_app()
        unrelated = self.mac_app(self.root / "unrelated.app")
        original = (unrelated / "Contents/Info.plist").read_bytes()
        destination = self.root / "copy-link.app"
        destination.symlink_to(unrelated)
        self.assert_refused(source, destination)
        self.assertTrue(destination.is_symlink())
        self.assertEqual((unrelated / "Contents/Info.plist").read_bytes(), original)
        self.assertTrue((unrelated / "Contents/PlugIns/input").exists())

    def follow_caller(self, source, out):
        self.copy(self.helper)
        self.env["OUT"] = str(out)
        stub = f"""#!{sys.executable}
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps([name, *args]) + "\\n")
if name == "swiftc":
    pathlib.Path(args[args.index("-o") + 1]).write_text("inert window helper")
elif name == "node" and args[0].endswith("main.ts"):
    print("listening on inert fixture")
elif name == "node" and args[1] == "config":
    pathlib.Path(args[2]).mkdir(parents=True)
elif name == "node" and args[1] == "seed":
    pathlib.Path(args[-1]).write_text(json.dumps({{"running": "fixture"}}))
elif name not in ("sleep", "defaults", "kill"):
    raise SystemExit("forbidden offline command: " + repr([name, *args]))
"""
        for name in ("swiftc", "node", "sleep", "defaults", "kill"):
            path = self.bin / name
            path.write_text(stub)
            path.chmod(0o755)
        result = self.shell("scripts/open-bench/follow.sh", source)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        # follow.sh's exit trap has its own cleanup. The app itself must never be removed.
        app_removals = [c for c in self.recorded() if c[0] == "rm"
                        and any(not arg.startswith("-") and Path(arg).resolve() == source
                                for arg in c[1:])]
        self.assertFalse(app_removals, self.recorded())
        self.assertEqual((source / "input-sentinel").read_text(), "source must survive")
        self.assertFalse([c for c in self.recorded() if c[0] in ("codesign", "open")])

    def test_documented_follow_caller_cannot_delete_its_previous_build(self):
        out = self.root / "follow-run"
        self.follow_caller(self.mac_app(out / "app.app"), out)

    def test_documented_follow_caller_resolves_symlink_before_parent(self):
        physical = self.root / "physical"
        source = self.mac_app(physical / "app.app")
        (physical / "subdir").mkdir()
        alias = self.root / "alias"
        alias.symlink_to(physical / "subdir")
        out = alias / ".."
        self.assertEqual((out / "app.app").resolve(), source)
        self.follow_caller(source, out)
