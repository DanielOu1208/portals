"""Return freshness belongs to the thread the actual probe says is on screen."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from support import ROOT


class ReturnSummaryTests(unittest.TestCase):
    def summary(self, probe):
        with tempfile.TemporaryDirectory(prefix="portals-return-summary-") as directory:
            run = Path(directory)
            (run / "probe.txt").write_text(probe)
            (run / "marks.txt").write_text("10 back fixture\n")
            traffic = run / "bytes.txt"
            traffic.write_text("")
            result = subprocess.run(
                [sys.executable, "-I", "-B", str(ROOT / "scripts/return-bench/summary.py"),
                 str(run), str(traffic)], capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout

    def test_offscreen_thread_cannot_supply_either_freshness_event(self):
        output = self.summary(
            "9 shown A\n10 phase active\n10.1 thread-snapshot B\n"
            "10.2 thread-caught-up B\n12 thread-caught-up A\n13 thread-snapshot A\n"
        )
        self.assertIn("thread-caught-up 2.0s", output)
        self.assertIn("thread-snapshot 3.0s", output)
        self.assertNotIn("0.1s", output)
        self.assertNotIn("0.2s", output)

    def test_shown_thread_retains_existing_freshness_measurements(self):
        for event in ("thread-caught-up", "thread-snapshot"):
            with self.subTest(event=event):
                output = self.summary(f"9 shown A\n10 phase active\n10.5 {event} A\n")
                self.assertIn(f"{event} 0.5s", output)

    def test_missing_shown_identity_is_not_finite_freshness(self):
        for identity in ("", "9 shown new\n"):
            with self.subTest(identity=identity):
                output = self.summary(
                    identity + "10 phase active\n10.1 thread-caught-up A\n10.2 thread-snapshot A\n"
                )
                self.assertIn("phase 0.0s", output)
                self.assertNotIn("thread-caught-up", output)
                self.assertNotIn("thread-snapshot", output)

    def test_thread_switches_use_the_identity_at_each_event(self):
        output = self.summary(
            "9 shown A\n10 phase active\n10.2 shown B\n10.3 thread-caught-up A\n"
            "10.7 thread-caught-up B\n11 shown A\n11.2 thread-snapshot B\n"
            "11.5 thread-snapshot A\n"
        )
        self.assertIn("thread-caught-up 0.7s", output)
        self.assertIn("thread-snapshot 1.5s", output)
        self.assertNotIn("0.3s", output)
        self.assertNotIn("1.2s", output)
