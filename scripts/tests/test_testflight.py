import plistlib
import subprocess

from support import ToolTest

IOS = "generic/platform=iOS"
MAC = "generic/platform=macOS,variant=Mac Catalyst"


class TestFlightTests(ToolTest):
    def prepare(self):
        self.copy("scripts/testflight.sh")
        for name in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH"):
            self.env.pop(name, None)
        config = self.repo / "Config"
        config.mkdir()
        (config / "Local.xcconfig").write_text("DEVELOPMENT_TEAM = AUDITTEAM\n")
        (config / "Shared.xcconfig").write_text("MARKETING_VERSION = 0.1.0\n")
        result = subprocess.run(["/usr/bin/git", "init", "-q", str(self.repo)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.repo / ".git/info/exclude").write_text("/scripts/\n/Config/\n/.build/\n")

    def run_testflight(self, *args):
        return self.run_command(["/bin/sh", str(self.repo / "scripts/testflight.sh"), *args])

    def release(self):
        return self.run_testflight("--export-only")

    def xcodebuild(self):
        return [c[1:] for c in self.recorded() if c[0] == "xcodebuild"]

    def steps(self):
        """Each xcodebuild run as (action, destination or archive exported), and git tags."""
        steps = []
        for call in self.recorded():
            if call[:2] == ["xcodebuild", "archive"]:
                steps.append(("archive", call[call.index("-destination") + 1]))
            elif call[:2] == ["xcodebuild", "-exportArchive"]:
                archive = call[call.index("-archivePath") + 1]
                steps.append(("export", archive.split("/")[-2]))
            elif call[:2] == ["git", "tag"]:
                steps.append(("tag", *call[2:]))
        return steps

    def export_options(self):
        [path] = self.root.glob("portals-testflight/*/ExportOptions.plist")
        return plistlib.loads(path.read_bytes())

    def test_new_auto_included_source_or_resource_blocks_archive(self):
        self.prepare()
        for relative in ("Portals/App/New.swift", "PortalsNotifications/New.swift", "Portals/Assets/new.txt"):
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("uncommitted")
            self.calls.unlink(missing_ok=True)
            with self.subTest(path=relative):
                result = self.release()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse([c for c in self.recorded() if c[0] == "xcodebuild"])
            path.unlink()

    def test_tracked_changes_block_archive(self):
        self.prepare()
        path = self.repo / "tracked.swift"
        path.write_text("one")
        subprocess.run(["/usr/bin/git", "add", str(path)], cwd=self.repo, check=True, capture_output=True)
        path.write_text("two")
        result = self.release()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([c for c in self.recorded() if c[0] == "xcodebuild"])

    def test_failed_git_status_cannot_open_release_gate(self):
        self.prepare()
        self.env["GIT_STATUS_EXIT"] = "128"
        result = self.release()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([c for c in self.recorded() if c[0] == "xcodebuild"])

    def test_ignored_local_config_and_build_output_allow_stub_archive(self):
        self.prepare()
        build = self.repo / ".build"
        build.mkdir()
        (build / "output").write_text("ignored")
        result = self.release()
        self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
        self.assertEqual([c[1] for c in self.recorded() if c[0] == "xcodebuild"], ["archive"])
        self.assertFalse([c for c in self.recorded() if c[:2] == ["git", "tag"]])

    def test_both_platforms_archive_before_either_exports(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.steps(), [("archive", IOS), ("archive", MAC), ("export", "ios"), ("export", "mac")])
        archives = [c for c in self.xcodebuild() if c[0] == "archive"]
        builds = {next(a for a in c if a.startswith("CURRENT_PROJECT_VERSION=")) for c in archives}
        self.assertEqual(len(builds), 1, "both platforms carry one build number")
        for call in archives:
            self.assertIn("PORTALS_APS_ENVIRONMENT=production", call)
        options = self.export_options()
        self.assertEqual((options["method"], options["destination"], options["teamID"]),
                         ("app-store-connect", "export", "AUDITTEAM"))
        self.assertIn("ios/export/Portals.ipa (not uploaded)", result.stdout)
        self.assertIn("mac/export/Portals.pkg (not uploaded)", result.stdout)

    def test_one_platform_builds_only_that_one(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        for flag, destination, folder in (("--ios", IOS, "ios"), ("--mac", MAC, "mac")):
            self.calls.unlink(missing_ok=True)
            with self.subTest(flag=flag):
                result = self.run_testflight(flag, "--export-only")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.steps(), [("archive", destination), ("export", folder)])

    def test_repeated_flags_build_each_platform_once(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        result = self.run_testflight("--mac", "--ios", "--mac", "--export-only")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.steps(), [("archive", IOS), ("archive", MAC), ("export", "ios"), ("export", "mac")])

    def test_upload_tags_the_commit_at_the_first_upload(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        result = self.run_testflight()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.export_options()["destination"], "upload")
        [build] = {a.split("=")[1] for c in self.xcodebuild() for a in c if a.startswith("CURRENT_PROJECT_VERSION=")}
        tag = ("tag", f"testflight-0.1.0-{build}", "abcdef0")
        self.assertEqual(self.steps(), [("archive", IOS), ("archive", MAC), ("export", "ios"), tag, ("export", "mac")])

    def test_failed_mac_archive_uploads_nothing(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = "Mac Catalyst"
        result = self.run_testflight()
        self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
        self.assertEqual(self.steps(), [("archive", IOS), ("archive", MAC)])

    def test_failed_upload_is_not_tagged(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        self.env["EXPORT_EXIT"] = "70"
        result = self.run_testflight()
        self.assertEqual(result.returncode, 70, result.stdout + result.stderr)
        self.assertEqual(self.steps(), [("archive", IOS), ("archive", MAC), ("export", "ios")])

    def test_unknown_argument_builds_nothing(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        result = self.run_testflight("--macos")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Usage", result.stderr)
        self.assertFalse(self.xcodebuild())

    def api_key(self, key_id="AUDITKEY"):
        key = self.root / ".appstoreconnect/private_keys" / f"AuthKey_{key_id}.p8"
        key.parent.mkdir(parents=True)
        key.write_text("-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n-----END PRIVATE KEY-----\n")
        key.chmod(0o600)
        return key

    def test_api_key_signs_and_uploads_every_build_unprinted(self):
        self.prepare()
        key = self.api_key()
        self.env.update(ARCHIVE_FAIL="", ASC_KEY_ID="AUDITKEY", ASC_ISSUER_ID="AUDIT-ISSUER")
        result = self.run_testflight()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.xcodebuild()
        self.assertEqual(len(calls), 4)
        for call in calls:
            with self.subTest(call=call[0]):
                self.assertIn("-allowProvisioningUpdates", call)
                at = call.index("-authenticationKeyPath")
                self.assertEqual(call[at:at + 6], ["-authenticationKeyPath", str(key), "-authenticationKeyID",
                                                   "AUDITKEY", "-authenticationKeyIssuerID", "AUDIT-ISSUER"])
        self.assertNotIn("SECRETKEYBODY", result.stdout + result.stderr)

    def test_api_key_path_may_be_given(self):
        self.prepare()
        key = self.root / "elsewhere key.p8"
        key.write_text("key")
        self.env.update(ARCHIVE_FAIL="", ASC_KEY_ID="AUDITKEY", ASC_ISSUER_ID="AUDIT-ISSUER", ASC_KEY_PATH=str(key))
        result = self.run_testflight("--mac", "--export-only")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for call in self.xcodebuild():
            self.assertEqual(call[call.index("-authenticationKeyPath") + 1], str(key))

    def test_incomplete_api_key_builds_nothing(self):
        self.prepare()
        self.api_key()
        cases = ({"ASC_KEY_ID": "AUDITKEY"}, {"ASC_ISSUER_ID": "AUDIT-ISSUER"},
                 {"ASC_KEY_ID": "MISSING", "ASC_ISSUER_ID": "AUDIT-ISSUER"})
        for case in cases:
            self.calls.unlink(missing_ok=True)
            with self.subTest(case=case):
                env = self.env
                self.env = {**env, "ARCHIVE_FAIL": "", **case}
                result = self.release()
                self.env = env
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertFalse(self.xcodebuild())

    def test_without_api_key_xcode_signs_in_with_its_own_account(self):
        self.prepare()
        self.env["ARCHIVE_FAIL"] = ""
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for call in self.xcodebuild():
            self.assertFalse([a for a in call if a.startswith("-authentication")])
