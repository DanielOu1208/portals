import sys

from support import ROOT, ToolTest


class ToolRunnerTests(ToolTest):
    def setUp(self):
        super().setUp()
        self.tests = self.repo / "tests"
        self.tests.mkdir()

    def runner(self, *args):
        return self.run_command([sys.executable, "-I", "-B", str(ROOT / "scripts/test-tools.py"),
                                 "--test-directory", str(self.tests), *args])

    def fixture(self, name, body):
        (self.tests / name).write_text("import unittest\n" + body)

    def test_files_run_concurrently_and_keep_their_output_together(self):
        for name, other in (("first", "second"), ("second", "first")):
            self.fixture(f"test_{name}.py", f'''
from pathlib import Path
import time
class Concurrent(unittest.TestCase):
    def test_other_worker_started(self):
        here = Path(__file__).parent
        (here / "{name}").touch()
        deadline = time.monotonic() + 3
        while not (here / "{other}").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue((here / "{other}").exists(), "other file did not run concurrently")
''')
        result = self.runner("--jobs", "2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("2 test files, 0 failed", result.stdout)
        for name in ("first", "second"):
            self.assertIn(f"=== test_{name}.py ===", result.stdout)
        self.assertEqual(result.stdout.count("Ran 1 test"), 2)

    def test_failure_and_import_error_fail_the_run_without_skipping_other_files(self):
        self.fixture("test_pass.py", "class Pass(unittest.TestCase):\n    def test_ok(self): pass\n")
        self.fixture("test_fail.py", "class Fail(unittest.TestCase):\n    def test_no(self): self.fail('expected')\n")
        self.fixture("test_error.py", "raise RuntimeError('import failed')\n")
        result = self.runner("--jobs", "1")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("3 test files, 2 failed", result.stdout)
        self.assertIn("test_fail.py", result.stderr)
        self.assertIn("test_error.py", result.stderr)
        self.assertIn("test_ok (test_pass.Pass.test_ok) ... ok", result.stdout)

    def test_no_matching_files_and_invalid_worker_counts_are_errors(self):
        for args in ((), ("--jobs", "0"), ("--jobs", "-1")):
            with self.subTest(args=args):
                result = self.runner(*args)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
