from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import runpy
import subprocess
import sys
from unittest.mock import patch

from support import ROOT, ToolTest

HELPER = ROOT / "scripts/native-test-support.py"
native = runpy.run_path(str(HELPER))
COMPILER = r'''import json, os, pathlib, sys, time
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps([pathlib.Path(sys.argv[0]).name, *args]) + "\n")
if args == ["--version"]:
    print(os.environ.get("CORE_VERSION", "Swift test 1"))
elif args == ["-print-target-info"]:
    print(os.environ.get("CORE_TARGET", "arm64-apple-macosx"))
elif "--show-sdk-build-version" in args:
    print(os.environ.get("CORE_SDK_BUILD", "SDK test 1"))
elif "-emit-library" in args:
    time.sleep(float(os.environ.get("CORE_DELAY", "0")))
    compiled = b"\n".join(pathlib.Path(arg).read_bytes() for arg in args if arg.endswith(".swift"))
    pathlib.Path(args[args.index("-emit-module-path") + 1]).write_bytes(compiled)
    if os.environ.get("CORE_FAIL"):
        sys.exit(65)
    pathlib.Path(args[args.index("-o") + 1]).write_bytes(compiled)
else:
    sys.exit("Unexpected compiler or SDK command: " + repr(args))
'''


class NativeCacheTests(ToolTest):
    def setUp(self):
        super().setUp()
        self.source = self.repo / "Packages/PortalsKit/Sources/AgentCore/Probe.swift"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("struct Probe {}")
        self.sdk = self.root / "SDK"
        self.sdk.mkdir()
        self.env["SDKROOT"] = str(self.sdk)
        for name in ("swiftc", "xcrun"):
            (self.bin / name).write_text(f"#!{sys.executable}\n{COMPILER}")

    def build(self, **kwargs):
        with patch.dict(os.environ, self.env, clear=True):
            return native["build_agent_core"](self.repo, **kwargs)

    def builds(self):
        return [call for call in self.recorded() if "-emit-library" in call]

    def test_cache_hit_retains_all_artifacts_and_rpath_install_name(self):
        first = self.build()
        self.assertEqual(self.build(), first)
        self.assertEqual(len(self.builds()), 1)
        self.assertTrue((first / "AgentCore.swiftmodule").is_file())
        self.assertTrue((first / "libAgentCore.dylib").is_file())
        self.assertIn("@rpath/libAgentCore.dylib", self.builds()[0])
        self.assertEqual(native["core_link_flags"](first),
                         ["-I", first, "-L", first, "-lAgentCore",
                          "-Xlinker", "-rpath", "-Xlinker", first])

    def test_source_edits_additions_and_removals_invalidate(self):
        initial = self.build()
        self.source.write_text("struct Probe { let value: Int }")
        edited = self.build()
        self.assertNotEqual(initial, edited)
        added = self.source.with_name("Added.swift")
        added.write_text("struct Added {}")
        self.assertNotEqual(self.build(), edited)
        added.unlink()
        self.assertEqual(self.build(), edited)
        self.assertEqual(len(self.builds()), 3)

    def test_source_edits_at_lock_or_compile_do_not_poison_the_captured_key(self):
        original = "struct Probe { let version = 1 }"
        edited = "struct Probe { let version = 2 }"
        real_flock, real_run = native["fcntl"].flock, subprocess.run
        for phase in ("lock", "compile"):
            with self.subTest(phase=phase):
                self.source.write_text(original)

                def lock(fd, operation):
                    if phase == "lock":
                        self.source.write_text(edited)
                    return real_flock(fd, operation)

                def run(command, **kwargs):
                    if phase == "compile" and "-emit-library" in command:
                        self.source.write_text(edited)
                    return real_run(command, **kwargs)

                # Mutate at exact boundaries, without scheduler timing or sleeps.
                with patch.object(native["fcntl"], "flock", side_effect=lock), \
                        patch.object(subprocess, "run", side_effect=run):
                    built = self.build(fresh=True)
                self.assertEqual(self.source.read_text(), edited)
                self.source.write_text(original)
                self.assertEqual(self.build(), built)
                self.assertEqual((built / "libAgentCore.dylib").read_text(), original)

    def test_compiler_sdk_target_environment_and_flags_invalidate(self):
        previous = self.build()
        for name, value in (("CORE_VERSION", "Swift test 2"), ("CORE_TARGET", "x86_64-apple-macosx"),
                            ("CORE_SDK_BUILD", "SDK test 2"), ("MACOSX_DEPLOYMENT_TARGET", "15.0")):
            with self.subTest(name=name):
                self.env[name] = value
                current = self.build()
                self.assertNotEqual(current, previous)
                previous = current
        (self.sdk / "SDKSettings.json").write_text('{"version":2}')
        current = self.build()
        self.assertNotEqual(current, previous)
        self.assertNotEqual(self.build(flags=(*native["CORE_FLAGS"], "-DTEST_FLAG")), current)
        self.assertEqual(len(self.builds()), 7)

    def test_compiler_file_changes_invalidate_even_with_unchanged_version(self):
        initial = self.build()
        compiler = self.bin / "swiftc"
        compiler.write_text(compiler.read_text() + "\n# changed compiler\n")
        self.assertNotEqual(self.build(), initial)

    def test_fresh_build_does_not_break_an_existing_harness_link(self):
        old = self.build()
        fresh = self.build(fresh=True)
        self.assertNotEqual(fresh, old)
        self.assertTrue((old / "libAgentCore.dylib").is_file())
        self.assertEqual(self.build(), fresh)
        self.assertEqual(len(self.builds()), 2)

    def test_missing_artifact_rebuilds(self):
        initial = self.build()
        (initial / "AgentCore.swiftmodule").unlink()
        self.assertNotEqual(self.build(), initial)
        self.assertEqual(len(self.builds()), 2)

    def test_failed_build_is_not_published_and_can_be_retried(self):
        self.env["CORE_FAIL"] = "1"
        with self.assertRaises(subprocess.CalledProcessError):
            self.build()
        self.assertEqual(list((self.repo / ".build/native-agent-core").glob("*/current")), [])
        del self.env["CORE_FAIL"]
        good = self.build()
        self.env["CORE_FAIL"] = "1"
        with self.assertRaises(subprocess.CalledProcessError):
            self.build(fresh=True)
        self.assertEqual(self.build(), good)
        self.assertEqual(len(self.builds()), 3)

    def test_concurrent_launchers_publish_one_complete_build(self):
        self.env["CORE_DELAY"] = "0.1"
        command = [sys.executable, "-I", "-B", "-c",
                   "import pathlib,runpy,sys; "
                   "print(runpy.run_path(sys.argv[1])['build_agent_core'](pathlib.Path(sys.argv[2])))",
                   str(HELPER), str(self.repo)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.run_command(command), range(4)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        paths = {result.stdout.splitlines()[-1] for result in results}
        self.assertEqual(len(paths), 1)
        self.assertEqual(len(self.builds()), 1)
        self.assertTrue((Path(paths.pop()) / "libAgentCore.dylib").is_file())

    def test_missing_sources_fail_before_using_the_cache(self):
        self.source.unlink()
        with self.assertRaisesRegex(RuntimeError, "AgentCore sources not found"):
            self.build()
