import plistlib
import shutil
import sys

from support import ToolTest


class ReturnBenchTests(ToolTest):
    def prepare(self):
        app = self.app()
        data = self.root / "data"
        (data / "bridge").mkdir(parents=True)
        (data / "bridge/ids.txt").write_text("\n".join(f"thread-{i}" for i in range(12)))
        return app, data

    def test_explicit_booted_simulator_and_scratch_copy(self):
        app, data = self.prepare()
        original = (app / "Info.plist").read_bytes()
        self.env["SIM"] = "AUDIT-SIM"
        result = self.shell("scripts/return-bench.sh", "sim", app, data, "trial", 0)
        self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
        actions = [c for c in self.recorded() if c[0] == "xcrun" and c[2] in ("terminate", "uninstall", "install")]
        self.assertTrue(actions)
        for call in actions:
            self.assertEqual(call[3], "AUDIT-SIM")
            if call[2] != "install":
                self.assertEqual(call[4], "com.danielou.portals.n4-return")
        copy = data / "copy-trial/Portals.app"
        self.assertEqual(actions[-1][4], str(copy))
        with (copy / "Info.plist").open("rb") as f:
            info = plistlib.load(f)
        self.assertEqual(info["CFBundleIdentifier"], "com.danielou.portals.n4-return")
        self.assertNotIn("CFBundleURLTypes", info)
        self.assertFalse((copy / "PlugIns").exists())
        self.assertEqual((app / "Info.plist").read_bytes(), original)
        self.assertTrue((app / "PlugIns/unchanged").exists())

    def test_missing_unknown_or_shutdown_simulator_never_mutates_apps(self):
        app, data = self.prepare()
        for sim, state in ((None, "Booted"), ("UNKNOWN", "Booted"), ("AUDIT-SIM", "Shutdown")):
            self.calls.unlink(missing_ok=True)
            self.env.pop("SIM", None)
            if sim is not None:
                self.env["SIM"] = sim
            self.env["SIM_STATE"] = state
            with self.subTest(sim=sim, state=state):
                result = self.shell("scripts/return-bench.sh", "sim", app, data, "trial", 0)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse([c for c in self.recorded() if c[0] == "xcrun" and c[2] != "list"])

    def test_signing_failure_precedes_any_simulator_mutation(self):
        app, data = self.prepare()
        self.env.update(SIM="AUDIT-SIM", SIGN_EXIT="71")
        result = self.shell("scripts/return-bench.sh", "sim", app, data, "trial", 0)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([c for c in self.recorded() if c[0] == "xcrun" and c[2] != "list"])

    def test_external_app_symlink_is_rejected_before_signing_or_mutation(self):
        app, data = self.prepare()
        (app / "external").symlink_to(self.root / "outside")
        (self.root / "outside").write_text("untouched")
        self.env["SIM"] = "AUDIT-SIM"
        result = self.shell("scripts/return-bench.sh", "sim", app, data, "trial", 0)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([c for c in self.recorded() if c[0] == "codesign" or c[0] == "xcrun" and c[2] != "list"])
        self.assertEqual((self.root / "outside").read_text(), "untouched")

    def test_source_overlaps_are_rejected_before_any_cleanup(self):
        template = self.app()
        rm = self.bin / "rm"
        rm.write_text(f"#!{sys.executable}\nimport json,os,sys\n"
                      "with open(os.environ['CALLS'],'a') as f: f.write(json.dumps(['rm',*sys.argv[1:]])+'\\n')\n")
        rm.chmod(0o755)
        self.env["SIM"] = "AUDIT-SIM"
        for case in ("inside-out", "equal-out", "source-ancestor", "inside-copy", "equal-copy", "source-alias"):
            base = self.root / case
            data = base / "data"
            if case == "source-ancestor":
                source = base / "source.app"
                data = source / "data"
            elif case == "equal-out":
                source = data / "trial"
            elif case == "equal-copy":
                source = data / "copy-trial"
            else:
                source = data / ("copy-trial" if case == "inside-copy" else "trial") / "Portals.app"
            shutil.copytree(template, source)
            (data / "bridge").mkdir(parents=True)
            (data / "bridge/ids.txt").write_text("thread\n" * 12)
            supplied = source
            if case == "source-alias":
                supplied = base / "source-link.app"
                supplied.symlink_to(source)
            self.calls.unlink(missing_ok=True)
            with self.subTest(case=case):
                result = self.shell("scripts/return-bench.sh", "sim", supplied, data, "trial", 0)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse([c for c in self.recorded() if c[0] == "rm"])
                self.assertTrue((source / "PlugIns/unchanged").exists())
                self.assertFalse([c for c in self.recorded() if c[0] == "codesign" or c[0] == "xcrun" and c[2] != "list"])
