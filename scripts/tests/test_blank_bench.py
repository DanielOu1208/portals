import json
import sys

from support import ROOT, ToolTest, function


class BlankSummaryTests(ToolTest):
    def summary(self, marks=None, events=None):
        out = self.root / "out"
        out.mkdir(exist_ok=True)
        (out / "ids.json").write_text('{"long60":"t1"}')
        if marks is not None:
            (out / "marks.txt").write_text(marks)
        if events is not None:
            (out / "blank.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
        return self.run_command([sys.executable, "-I", str(ROOT / "scripts/blank-bench/summary.py"), str(out)])

    marks = "1 open Long 60\n2 ink 0.2000 Long 60\n3 done\n"
    opened = [{"event": "open", "thread": "t1", "t": 1}]

    def test_measured_run_passes(self):
        result = self.summary(self.marks, self.opened)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_invalid_evidence_fails(self):
        cases = [None, "", "1 done\n", self.marks.replace("3 done\n", ""),
                 self.marks.replace("0.2000", "-1"), self.marks.replace("0.2000", "nan"),
                 self.marks.replace("0.2000", "0.0000"),
                 self.marks + "4 no-row Long 45\n",
                 self.marks + "4 no-sidebar-button\n",
                 self.marks + "4 unknown unexpected\n"]
        for marks in cases:
            with self.subTest(marks=marks):
                out = self.root / "out"
                if (out / "marks.txt").exists():
                    (out / "marks.txt").unlink()
                self.assertNotEqual(self.summary(marks, self.opened).returncode, 0)

    def test_missing_probe_fails(self):
        self.assertNotEqual(self.summary(self.marks).returncode, 0)

    def test_zero_probe_openings_fails(self):
        self.assertNotEqual(self.summary(self.marks, []).returncode, 0)

    def test_long_and_unresolved_blank_fail_but_short_recovery_passes(self):
        blank = {"event": "blank", "thread": "t1", "t": 1.1, "turns": 45,
                 "content": 2000, "offset": 0, "dist": 0, "built": [], "since_open_ms": 100}
        for duration, expected in ((254, 0), (1000, 1), (None, 1)):
            clear = [] if duration is None else [{"event": "clear", "thread": "t1", "t": 1.5,
                "ms": duration, "by": "repair", "built": [], "offset": 0, "dist": 0, "in_view": []}]
            with self.subTest(duration=duration):
                result = self.summary(self.marks, self.opened + [blank] + clear)
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_interrupted_short_blanks_fail_even_with_later_positive_ink(self):
        blank = {"event": "blank", "thread": "t1", "t": 1.1, "turns": 45,
                 "content": 2000, "offset": 0, "dist": 0, "built": [], "since_open_ms": 100}
        for cause, expected in (("aside", 1), ("gone", 1), ("repair", 0), ("self", 0), ("hand", 0)):
            clear = {"event": "clear", "thread": "t1", "t": 1.3, "ms": 200,
                     "by": cause, "built": [], "offset": 0, "dist": 0, "in_view": []}
            with self.subTest(cause=cause):
                result = self.summary(self.marks, self.opened + [blank, clear])
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertIn(f"ended by: {cause} 1", result.stdout)


class BlankDriverTests(ToolTest):
    def ui(self, mode):
        out, uid = self.root / "out", self.root / "ui"
        out.mkdir(exist_ok=True)
        uid.mkdir(exist_ok=True)
        # Keep the real late-failure stub's 0.5 s exit inside the grace period.
        self.env.update(OUT=str(out), UIDIR=str(uid), UI_MODE=mode,
                        BLANK_UI_POLL_SECONDS="0.01", BLANK_UI_EXIT_GRACE_SECONDS="0.65")
        script = ("set -uo pipefail\nBUNDLE=com.example.offline SIM=AUDIT-SIM XCTESTRUN=fake DWELL=2.5\n"
                  'log() { print -r -- "$*" >> "$OUT/bench.log"; }\n'
                  + function("scripts/blank-bench.sh", "uitest")
                  + '\nuitest main "tap:Long_60"\n')
        return self.run_command(["/bin/zsh", "-c", script])

    def test_real_ui_exit_and_missing_completion_are_failures(self):
        for mode in ("fail", "no-done", "no-ink"):
            with self.subTest(mode=mode):
                result = self.ui(mode)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_successful_ui_retains_marks(self):
        result = self.ui("ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("done", (self.root / "out/marks.txt").read_text())

    def test_xcodebuild_left_on_after_the_tests_is_ended_with_their_verdict(self):
        for mode, expected in (("linger", 0), ("linger-fail", 1), ("verdict-then-fail", 1)):
            with self.subTest(mode=mode):
                result = self.ui(mode)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_driver_preserves_ui_relaunch_and_summary_failures(self):
        out = self.root / "out"
        out.mkdir()
        (out / "ids.json").write_text('{"long60":"t1"}')
        (out / "blank.jsonl").write_text('{"event":"open","thread":"t1","t":1}\n')
        source = (ROOT / "scripts/blank-bench.sh").read_text()
        main = source[source.index("\nfailures=0\n"):]
        for ui_exit, relaunches, launch_exit, ink, expected in (
                (0, 0, 0, "0.2", 0), (65, 0, 0, "0.2", 1),
                (0, 1, 1, "0.2", 1), (0, 0, 0, "0.0", 1)):
            (out / "marks.txt").write_text(f"1 open Long 60\n2 ink {ink} Long 60\n3 done\n")
            self.env.update(OUT=str(out), ROOT=str(ROOT), RELAUNCHES=str(relaunches),
                            UI_EXIT=str(ui_exit), LAUNCH_EXIT=str(launch_exit))
            code = ('set -uo pipefail\nzmodload zsh/datetime\n'
                    'STEPS=tap:Long_60 SIM=AUDIT-SIM app_pid=123\n'
                    'uitest() { return $UI_EXIT; }\nlaunch() { return $LAUNCH_EXIT; }\n'
                    'kill() { :; }\nsleep() { :; }\n' + main)
            with self.subTest(ui_exit=ui_exit, relaunches=relaunches, ink=ink):
                result = self.run_command(["/bin/zsh", "-c", code])
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assertTrue((out / "summary.txt").exists())

    def test_stale_marks_cannot_supply_missing_completion(self):
        uid = self.root / "ui"
        uid.mkdir()
        (uid / "marks.txt").write_text("0 done\n")
        result = self.ui("no-done")
        self.assertNotEqual(result.returncode, 0)

    def test_repairs_propagates_any_child_failure_and_keeps_summary(self):
        child = self.repo / "scripts/blank-bench.sh"
        child.parent.mkdir(parents=True)
        child.write_text('#!/bin/zsh\nmkdir -p "$OUT"\necho measured > "$OUT/summary.txt"\nexit 1\n')
        child.chmod(0o755)
        self.env["OUT"] = str(self.root / "repairs")
        result = self.shell("scripts/blank-bench/repairs.sh", "--modes", "none last")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("measured", (self.root / "repairs/repairs.txt").read_text())

    def test_ui_records_failures_as_assertions(self):
        text = (ROOT / "scripts/phone-bench/uitest/UITests/BlankUITests.swift").read_text()
        self.assertIn('XCTFail("no sidebar button', text)
        self.assertIn('XCTFail("no row', text)
        self.assertIn("XCTAssertGreaterThanOrEqual(ink", text)
        self.assertIn('XCTFail("unknown step', text)
