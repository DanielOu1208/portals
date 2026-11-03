import contextlib
import io
import os
import re
import subprocess
import sys
import threading
import time
import types
from unittest.mock import Mock, patch

from support import ROOT, ToolTest, function, load_threads


class PhoneMetricsTests(ToolTest):
    def test_process_counter_includes_workers_missing_from_end_snapshot(self):
        module = load_threads()
        with patch.dict(module, threads=Mock(side_effect=[[(1, "main", 1.0, True)],
                                                         [(1, "main", 1.1, True)]]),
                        cputime=Mock(side_effect=[10.0, 10.4]),
                        time=types.SimpleNamespace(time=Mock(side_effect=[100.0, 102.0])),
                        subprocess=types.SimpleNamespace(run=Mock(return_value=types.SimpleNamespace(stdout="")))):
            output = io.StringIO()
            with patch.object(sys, "argv", ["threads.py", "123", "2"]), contextlib.redirect_stdout(output):
                module["main"]()
            values = dict(re.findall(r"(\w+)=([0-9.]+)", output.getvalue()))
            self.assertEqual(float(values["cpu"]), 20.0)
            self.assertEqual(float(values["main"]), 5.0)

    def test_actual_finished_worker_cpu_is_not_zero(self):
        module = load_threads()
        real_run = subprocess.run
        def top(args, **kwargs):
            if args[0] != "top":
                return real_run(args, **kwargs)
            def work():
                until = time.thread_time() + 0.15
                while time.thread_time() < until:
                    pass
            worker = threading.Thread(target=work)
            worker.start()
            worker.join()
            return types.SimpleNamespace(stdout="")
        output = io.StringIO()
        started = time.perf_counter()
        with patch.object(subprocess, "run", side_effect=top), patch.object(sys, "argv", ["threads.py", str(os.getpid()), "1"]), contextlib.redirect_stdout(output):
            module["main"]()
        elapsed = time.perf_counter() - started
        percent = float(re.search(r"\bcpu=([0-9.]+)", output.getvalue())[1])
        # Check accounted work, not a load-dependent percentage threshold.
        self.assertGreater(percent * elapsed / 100, 0.075)

    def test_record_has_unique_authoritative_metric_keys(self):
        data = self.root / "data"
        data.mkdir()
        (data / "poll.txt").write_text("0 0 0 0\n10 4 2 0\n")
        (data / "frames.txt").write_text("")
        self.env.update(OUT=str(self.root), HELP=str(ROOT / "scripts/phone-bench"), dir=str(data))
        command = ('set -uo pipefail\nlog() { :; }\nwash_fps() { print 0; }\n'
                   + function("scripts/phone-bench.sh", "record")
                   + '\nrecord base idle 0 10 "cpu=1.0 main=2.0 wakeups=0"\n'
                   + 'record base whole 0 10\n')
        result = self.run_command(["/bin/zsh", "-c", command])
        self.assertEqual(result.returncode, 0, result.stderr)
        line, whole = (self.root / "results.txt").read_text().splitlines()
        self.assertEqual(len(re.findall(r"\bcpu=", line)), 1)
        self.assertEqual(len(re.findall(r"\bmain=", line)), 1)
        self.assertIn("cpu=40.0", line)
        self.assertIn("sample_cpu=1.0", line)
        self.assertIn("cpu=40.0", whole)
        self.assertNotIn("sample_cpu", whole)

    def test_legacy_duplicate_metrics_keep_first_process_measurement(self):
        results = self.root / "results.txt"
        results.write_text("base idle cpu=84.4 main=5.0 secs=0.3 cpu=0.0 main=0.0\n")
        result = self.run_command([sys.executable, "-I", str(ROOT / "scripts/phone-bench/medians.py"), str(results)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cpu=84.4", result.stdout)
        self.assertIn("main=5.0", result.stdout)
