#!/usr/bin/env python3
"""Run offline tooling regressions in isolated per-file workers."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--test-directory", type=Path, default=Path(__file__).resolve().parent / "tests")
    parser.add_argument("--pattern", default="test_*.py")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    directory = args.test_directory.resolve()
    files = sorted(directory.glob(args.pattern))
    if not files:
        parser.error(f"No test files match {args.pattern!r} in {directory}")

    def run(path):
        return subprocess.run([sys.executable, "-I", "-B", "-m", "unittest", "discover",
                               "-s", str(directory), "-p", path.name, "-v"],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    failed = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(run, path): path for path in files}
        for future in as_completed(futures):
            path, result = futures[future], future.result()
            print(f"\n=== {path.name} ===", flush=True)
            print(result.stdout, end="", flush=True)
            if result.returncode:
                failed.append(path.name)
    print(f"\n{len(files)} test files, {len(failed)} failed", flush=True)
    if failed:
        print("Failed: " + ", ".join(sorted(failed)), file=sys.stderr)
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
