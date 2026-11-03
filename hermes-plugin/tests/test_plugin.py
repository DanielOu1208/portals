"""Tests for the aeriportal-push plugin. Run them with Hermes's own Python, which has the
libraries the plugin uses:

    hermes --run-module unittest discover -s hermes-plugin/tests -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parent.parent / "aeriportal-push"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


core = load("aeriportal_push_core", PLUGIN / "core.py")

DEVICE = {"token": "ab" * 32, "environment": "sandbox", "bundle_id": "com.danielou.aeriportal"}
THREAD = {"id": "20261005_000000_root01", "agent": "karina", "agent_name": "Karina", "title": "Fix the build"}


class FakeApns:
    """Records what would be sent, and answers as told."""

    def __init__(self, result: str = "sent"):
        self.result = result
        self.sent: list[tuple[str, dict, str]] = []

    def send(self, token, device, payload, collapse_id=""):
        self.sent.append((token, payload, collapse_id))
        return self.result


class Case(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="aeriportal-push-test-"))
        self.store = core.Store(self.directory)
        self.clock = [1_000_000.0]
        self.lineage_calls: list[str] = []
        self.lineages: dict[str, list[str]] = {}
        self.apns = FakeApns()
        self.notifier = core.Notifier(self.store, self.apns, lineage=self.lineage, now=lambda: self.clock[0])

    def lineage(self, session_id, home):
        self.lineage_calls.append(session_id)
        return self.lineages.get(session_id, [])

    def registered(self):
        self.store.register(DEVICE, [THREAD])


class StoreTests(Case):
    def test_a_read_error_preserves_the_registry_and_the_last_good_cache(self):
        self.registered()
        original = self.store._file.read_bytes()
        cached = self.store.snapshot()
        changes = [
            lambda: self.store.register({**DEVICE, "token": "cd" * 32}, [{"id": "new-thread"}]),
            lambda: self.store.unwatch(THREAD["id"]),
            lambda: self.store.drop_device(DEVICE["token"]),
            lambda: self.store.remove_watcher(THREAD["id"], DEVICE["token"]),
        ]
        for error in [PermissionError("temporarily unreadable"), OSError("temporary I/O failure")]:
            for change in changes:
                with self.subTest(error=type(error).__name__, change=change):
                    with patch.object(Path, "read_text", side_effect=error):
                        with self.assertRaises(OSError):
                            change()
                    self.assertEqual(self.store._file.read_bytes(), original)
                    self.assertIs(self.store.snapshot(), cached)
        state = self.store.register({**DEVICE, "token": "cd" * 32}, [{"id": "new-thread"}])
        self.assertEqual(set(state["devices"]), {DEVICE["token"], "cd" * 32})
        self.assertEqual(set(state["threads"]), {THREAD["id"], "new-thread"})

    def test_a_read_error_in_a_process_that_only_reads_is_not_cached_as_an_empty_registry(self):
        # The serving parent writes; the isolated turn child's hooks only read.
        reader = core.Store(self.directory)
        self.registered()
        self.assertTrue(reader.is_active())
        os.utime(self.store._file, ns=(1, 1))  # written again since the reader last looked
        for error in [PermissionError("temporarily unreadable"), OSError("temporary I/O failure")]:
            with self.subTest(error=type(error).__name__):
                with patch.object(Path, "read_text", side_effect=error):
                    self.assertTrue(reader.is_active(), "the last registry known stands in")
                # Once the file reads again, it is what counts: nothing empty was cached.
                self.assertTrue(reader.is_active())
        with patch.object(Path, "stat", side_effect=PermissionError("directory not searchable")):
            self.assertTrue(reader.is_active())
        # A fresh store that never read it has nothing to stand in: empty, and not cached either.
        fresh = core.Store(self.directory)
        with patch.object(Path, "read_text", side_effect=PermissionError("temporarily unreadable")):
            self.assertFalse(fresh.is_active())
        self.assertTrue(fresh.is_active())
        # No file, or one that is not JSON, still means nobody.
        self.store._file.write_text("{not json")
        self.assertFalse(reader.is_active())
        self.store._file.unlink()
        self.assertFalse(reader.is_active())

    def test_registering_adds_and_updates_without_removing(self):
        self.assertFalse(self.store.is_active())
        self.store.register(DEVICE, [THREAD])
        self.store.register(None, [{"id": "other", "agent": "aeri"}])
        self.store.register({**DEVICE, "environment": "production"}, [{**THREAD, "title": "Renamed"}])
        state = self.store.snapshot()
        self.assertEqual(list(state["devices"]), [DEVICE["token"]])
        self.assertEqual(state["devices"][DEVICE["token"]]["environment"], "production")
        self.assertEqual(sorted(state["threads"]), ["20261005_000000_root01", "other"])
        self.assertEqual(state["threads"][THREAD["id"]]["title"], "Renamed")
        self.assertEqual(state["threads"][THREAD["id"]]["devices"], [DEVICE["token"]])
        # A thread registered without a display name is called by its agent's name.
        self.assertEqual(state["threads"]["other"]["agent_name"], "aeri")
        self.assertTrue(self.store.is_active())

    def test_an_unknown_environment_means_sandbox(self):
        self.store.register({**DEVICE, "environment": "whatever"}, [])
        self.assertEqual(self.store.snapshot()["devices"][DEVICE["token"]]["environment"], "sandbox")

    def test_threads_and_devices_can_be_removed(self):
        self.registered()
        self.store.unwatch(THREAD["id"])
        self.assertEqual(self.store.snapshot()["threads"], {})
        self.store.drop_device(DEVICE["token"])
        self.assertEqual(self.store.snapshot()["devices"], {})
        self.store.unwatch("never there")  # no error

    def test_another_process_writing_is_seen(self):
        self.registered()
        self.assertTrue(self.store.is_active())
        core.Store(self.directory).unwatch(THREAD["id"])
        self.assertFalse(self.store.is_active())

    def test_the_state_file_is_private_and_survives_garbage(self):
        self.registered()
        mode = stat.S_IMODE(os.stat(self.directory / "state.json").st_mode)
        self.assertEqual(mode, 0o600)
        (self.directory / "state.json").write_text("{not json")
        self.assertEqual(self.store.snapshot(), {"devices": {}, "threads": {}})
        self.registered()
        self.assertTrue(self.store.is_active())

    def test_the_apns_key_settings_must_be_complete(self):
        self.assertIsNone(self.store.apns_config())
        (self.directory / "apns.json").write_text(json.dumps({"key_path": "/k.p8", "key_id": "ABC"}))
        self.assertIsNone(self.store.apns_config())
        (self.directory / "apns.json").write_text(json.dumps({"key_path": "/k.p8", "key_id": "ABC", "team_id": "TEAM"}))
        self.assertEqual(self.store.apns_config()["team_id"], "TEAM")


class WordingTests(unittest.TestCase):
    def test_a_preview_is_the_first_line_with_something_on_it(self):
        self.assertEqual(core.preview("\n\n  Done.   All  good.\nMore"), "Done. All good.")
        self.assertEqual(core.preview(None), "")
        long = core.preview("x" * 300)
        self.assertEqual(len(long), core.PREVIEW_LIMIT)
        self.assertTrue(long.endswith("…"))

    def test_each_kind_of_event_has_its_words(self):
        def body(kind, text):
            return core.compose(kind, "t1", THREAD, text)["aps"]["alert"]["body"]

        self.assertEqual(body("approval", "rm -rf build\n# cleanup"), "Wants to run: rm -rf build")
        self.assertEqual(body("approval", ""), "Needs your approval")
        self.assertEqual(body("question", "Which language?"), "Which language?")
        self.assertEqual(body("finished", "All 14 tests pass.\nDetails follow"), "All 14 tests pass.")
        self.assertEqual(body("finished", ""), "Finished")
        self.assertEqual(body("failed", "provider did not answer"), "Stopped with an error: provider did not answer")
        self.assertIsNone(core.compose("something else", "t1", THREAD, "x"))

    def test_a_secret_in_what_happened_is_masked_before_it_leaves(self):
        key = "sk-ant-api03-" + "A1b2C3d4" * 6
        body = core.compose("finished", "t1", THREAD, f"The key is {key} as you asked")["aps"]["alert"]["body"]
        self.assertNotIn(key, body)
        self.assertIn("The key is", body)
        titled = core.compose("finished", "t1", {**THREAD, "title": f"Rotate {key}"}, "Done")
        self.assertNotIn(key, titled["aps"]["alert"]["subtitle"])

    def test_a_notification_names_the_agent_the_thread_and_where_to_go(self):
        payload = core.compose("finished", "t1", THREAD, "Done")
        self.assertEqual(payload["aps"]["alert"], {"title": "Karina", "subtitle": "Fix the build", "body": "Done"})
        self.assertEqual(payload["aps"]["thread-id"], "t1")
        self.assertEqual(payload["aps"]["sound"], "default")
        self.assertEqual(payload["aeriportal"], {"thread": "t1", "kind": "finished", "agent": "karina"})
        untitled = core.compose("finished", "t1", {"agent": "aeri"}, "Done")
        self.assertEqual(untitled["aps"]["alert"], {"title": "aeri", "body": "Done"})

    def test_a_notification_goes_through_the_apps_extension_for_the_agents_avatar(self):
        payload = core.compose("approval", "t1", THREAD, "swift test")
        self.assertEqual(payload["aps"]["mutable-content"], 1)
        self.assertEqual(payload["aeriportal"]["agent"], "karina")
        # A thread registered without its agent still notifies, with no avatar.
        anonymous = core.compose("approval", "t1", {"agent_name": "Karina"}, "swift test")
        self.assertNotIn("agent", anonymous["aeriportal"])


class NotifierTests(Case):
    def event(self, kind, session=THREAD["id"], text="", **details):
        return self.notifier.handle({"kind": kind, "session": session, "text": text, "home": None, **details})

    def test_removing_one_watcher_preserves_other_devices_and_legacy_broadcasts(self):
        self.registered()
        other = {**DEVICE, "token": "cd" * 32}
        self.store.register(other, [THREAD])
        self.store.register(DEVICE, [{"id": "other-thread"}])
        self.store.register(None, [{"id": "legacy"}])
        self.store.remove_watcher(THREAD["id"], DEVICE["token"])
        self.assertEqual(self.event("question", text="?"), ["sent"])
        self.assertEqual([token for token, _, _ in self.apns.sent], [other["token"]])
        self.assertEqual(self.store.snapshot()["threads"]["other-thread"]["devices"], [DEVICE["token"]])
        self.assertEqual(set(self.store.snapshot()["devices"]), {DEVICE["token"], other["token"]})
        self.store.remove_watcher(THREAD["id"], DEVICE["token"])
        self.store.remove_watcher("unknown", DEVICE["token"])
        self.store.remove_watcher("legacy", DEVICE["token"])
        self.assertEqual(self.store.snapshot()["threads"]["legacy"]["devices"], [])
        self.assertEqual(self.event("approval", session="legacy", text="ls"), ["sent", "sent"])
        self.store.remove_watcher(THREAD["id"], other["token"])
        self.assertNotIn(THREAD["id"], self.store.snapshot()["threads"])
        self.assertEqual(self.event("approval", text="ls"), [])

    def test_a_session_the_app_did_not_start_is_ignored_cheaply(self):
        self.registered()
        self.assertEqual(self.event("approval", session="discord-session", text="ls"), [])
        self.assertEqual(self.event("turn_end", session="discord-session"), [])
        self.assertEqual(self.apns.sent, [])
        # Its history was looked up once, not on every event.
        self.assertEqual(self.lineage_calls, ["discord-session"])
        self.clock[0] += core.MISS_LIFETIME + 1
        self.event("approval", session="discord-session", text="ls")
        self.assertEqual(len(self.lineage_calls), 2)

    def test_an_approval_and_a_question_notify_at_once(self):
        self.registered()
        self.assertEqual(self.event("approval", text="swift test"), ["sent"])
        self.assertEqual(self.event("question", text="Python or Swift?"), ["sent"])
        (token, first, collapse), (_, second, _) = self.apns.sent
        self.assertEqual(token, DEVICE["token"])
        self.assertEqual(first["aps"]["alert"]["body"], "Wants to run: swift test")
        self.assertEqual(first["aeriportal"], {"thread": THREAD["id"], "kind": "approval", "agent": "karina"})
        self.assertEqual(collapse, f"{THREAD['id']}-approval")
        self.assertEqual(second["aeriportal"]["kind"], "question")
        # A thread the app watches needs no history lookup.
        self.assertEqual(self.lineage_calls, [])

    def test_a_request_hermes_announces_twice_notifies_once(self):
        # In "smart" approval mode the approval hook fires when the reviewer hands the
        # decision over, and again when Hermes starts waiting for the answer.
        self.registered()
        self.assertEqual(self.event("approval", text="swift test"), ["sent"])
        self.assertEqual(self.event("approval", text="swift test"), [])
        # Another command is another request, and so is the same one later on.
        self.assertEqual(self.event("approval", text="swift build"), ["sent"])
        self.clock[0] += core.REPEAT_WINDOW + 1
        self.assertEqual(self.event("approval", text="swift build"), ["sent"])
        self.assertEqual(len(self.apns.sent), 3)
        # Two turns that end with the same words are two notifications.
        self.assertEqual(self.event("turn_end"), ["sent"])
        self.assertEqual(self.event("turn_end"), ["sent"])

    def test_a_finished_turn_notifies_once_with_the_start_of_the_reply(self):
        self.registered()
        self.assertEqual(self.event("reply", text="Fixed it.\nThe token is loaded first."), [])
        self.assertEqual(self.apns.sent, [])
        self.assertEqual(self.event("turn_end", text="completed"), ["sent"])
        self.assertEqual(self.apns.sent[0][1]["aps"]["alert"]["body"], "Fixed it.")
        self.assertEqual(self.apns.sent[0][1]["aeriportal"]["kind"], "finished")
        # The reply is not reused for the next turn.
        self.event("turn_end")
        self.assertEqual(self.apns.sent[1][1]["aps"]["alert"]["body"], "Finished")

    def test_a_stopped_turn_does_not_notify(self):
        self.registered()
        self.event("reply", text="Half an answ")
        self.assertEqual(self.event("turn_end", interrupted=True), [])
        self.assertEqual(self.apns.sent, [])
        self.event("turn_end")
        self.assertEqual(self.apns.sent[0][1]["aps"]["alert"]["body"], "Finished")

    def test_a_failed_turn_says_so(self):
        self.registered()
        self.assertEqual(self.event("turn_end", text="provider_error", failed=True), ["sent"])
        payload = self.apns.sent[0][1]
        self.assertEqual(payload["aeriportal"]["kind"], "failed")
        self.assertEqual(payload["aps"]["alert"]["body"], "Stopped with an error: provider_error")

    def test_a_session_moved_by_compression_still_belongs_to_its_thread(self):
        self.registered()
        self.lineages["20261005_010000_child2"] = [THREAD["id"], "20261005_005000_child1", "20261005_010000_child2"]
        self.assertEqual(self.event("approval", session="20261005_010000_child2", text="make"), ["sent"])
        payload = self.apns.sent[0][1]
        # The app knows the thread by the id it started with.
        self.assertEqual(payload["aeriportal"]["thread"], THREAD["id"])
        self.assertEqual(payload["aps"]["alert"]["subtitle"], "Fix the build")

    def test_a_device_that_no_longer_wants_notifications_is_forgotten(self):
        self.registered()
        self.apns.result = "gone"
        self.assertEqual(self.event("approval", text="ls"), ["gone"])
        self.assertEqual(self.store.snapshot()["devices"], {})

    def test_a_thread_notifies_the_devices_that_registered_it(self):
        phone, simulator = DEVICE, {**DEVICE, "token": "cd" * 32}
        self.store.register(phone, [THREAD])
        self.store.register(simulator, [{"id": "simulator-thread", "agent": "karina"}])
        self.assertEqual(self.event("question", text="?"), ["sent"])
        self.assertEqual(self.event("question", session="simulator-thread", text="?"), ["sent"])
        self.assertEqual([token for token, _, _ in self.apns.sent], [phone["token"], simulator["token"]])

        # The same thread opened on both is told to both, once each however often
        # it is registered.
        self.store.register(simulator, [THREAD])
        self.store.register(simulator, [THREAD])
        self.assertEqual(self.store.snapshot()["threads"][THREAD["id"]]["devices"], [phone["token"], simulator["token"]])
        self.clock[0] += core.REPEAT_WINDOW + 1
        self.assertEqual(self.event("question", text="?"), ["sent", "sent"])

    def test_a_thread_registered_without_a_device_goes_to_every_device(self):
        self.store.register(DEVICE, [])
        self.store.register({**DEVICE, "token": "cd" * 32}, [])
        self.store.register(None, [THREAD])
        self.assertEqual(self.event("question", text="?"), ["sent", "sent"])

    def test_a_device_that_was_forgotten_is_not_sent_to(self):
        self.registered()
        self.store.drop_device(DEVICE["token"])
        self.store.register({**DEVICE, "token": "cd" * 32}, [])
        self.assertEqual(self.event("question", text="?"), [])

    def test_outside_the_server_the_app_talks_to_nothing_is_queued(self):
        # The messaging gateway loads the hooks too, but never the routes.
        self.registered()
        armed = core._armed
        core._armed = False
        try:
            self.notifier.submit("approval", THREAD["id"], "ls")
            self.assertTrue(self.notifier.events.empty())
            self.assertEqual(self.lineage_calls, [])
        finally:
            core._armed = armed

    def test_loading_the_routes_arms_the_plugin(self):
        armed = core._armed
        core._armed = False
        try:
            load("aeriportal_push_api_arming_test", PLUGIN / "dashboard" / "plugin_api.py")
            self.assertTrue(core.is_armed())
        finally:
            core._armed = armed

    def test_nothing_is_queued_while_nobody_is_registered(self):
        core.arm()
        self.notifier.submit("approval", THREAD["id"], "ls")
        self.assertTrue(self.notifier.events.empty())
        self.store.register(DEVICE, [])
        self.notifier.submit("approval", THREAD["id"], "ls")
        self.assertTrue(self.notifier.events.empty())
        self.notifier.submit("approval", None, "ls")
        self.assertTrue(self.notifier.events.empty())


class ComputeHostTests(Case):
    """Isolated turns load the hooks, not the HTTP routes that arm their parent."""

    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(core, "_armed", False))
        self.enterContext(patch.object(core, "_notifier", self.notifier))
        self.enterContext(patch.object(self.notifier, "_ensure_worker"))
        self.enterContext(patch.dict(os.environ, {"HERMES_COMPUTE_HOST_CHILD": "1"}))
        plugin = load("aeriportal_push_compute_host_test", PLUGIN / "__init__.py")
        self.hooks = {}
        plugin.register(types.SimpleNamespace(register_hook=lambda name, hook: self.hooks.__setitem__(name, hook)))

    def drain(self):
        while not self.notifier.events.empty():
            self.notifier.handle(self.notifier.events.get_nowait())

    def test_isolated_turn_hooks_notify_without_route_arming(self):
        self.registered()
        approval = self.hooks["pre_approval_request"]
        approval(session_key=THREAD["id"], command="automatic", surface="smart")
        approval(session_key=THREAD["id"], command="duplicate", coalesced=True)
        self.hooks["pre_tool_call"](session_id=THREAD["id"], tool_name="read_file", args={})
        for _ in range(2):
            approval(session_key=THREAD["id"], session_id="transport-id", command="swift test", surface="tui")
            self.hooks["pre_tool_call"](
                session_id=THREAD["id"], tool_name="clarify", args={"questions": [{"question": "Swift?"}]},
            )
        self.hooks["post_llm_call"](session_id=THREAD["id"], assistant_response="All tests pass.")
        self.hooks["on_session_end"](session_id=THREAD["id"], completed=True, turn_exit_reason="completed")
        self.hooks["post_llm_call"](session_id=THREAD["id"], assistant_response="Half an answer")
        self.hooks["on_session_end"](session_id=THREAD["id"], interrupted=True)
        self.drain()
        self.assertFalse(core.is_armed())
        self.assertEqual([payload["aeriportal"]["kind"] for _, payload, _ in self.apns.sent], [
            "approval", "question", "finished",
        ])
        self.assertEqual(self.apns.sent[-1][1]["aps"]["alert"]["body"], "All tests pass.")
        self.assertTrue(all(token == DEVICE["token"] for token, _, _ in self.apns.sent))

    def test_only_the_exact_child_marker_keeps_registry_and_watcher_gates(self):
        self.registered()
        for marker in [None, "", "0", "true", "01"]:
            with self.subTest(marker=marker), patch.dict(os.environ):
                if marker is None:
                    os.environ.pop("HERMES_COMPUTE_HOST_CHILD", None)
                else:
                    os.environ["HERMES_COMPUTE_HOST_CHILD"] = marker
                self.notifier.submit("approval", THREAD["id"], "swift test")
                self.assertTrue(self.notifier.events.empty())
                self.notifier._ensure_worker.assert_not_called()
        self.notifier.submit("approval", "unwatched-session", "swift test")
        self.assertEqual(self.notifier.events.qsize(), 1)
        self.drain()
        self.assertEqual(self.apns.sent, [])
        self.notifier.submit("approval", None, "swift test")
        self.assertTrue(self.notifier.events.empty())
        self.store.drop_device(DEVICE["token"])
        self.notifier.submit("approval", THREAD["id"], "swift test")
        self.assertTrue(self.notifier.events.empty())

        self.registered()
        other = {**DEVICE, "token": "cd" * 32}
        self.store.register(other, [THREAD])
        self.store.remove_watcher(THREAD["id"], DEVICE["token"])
        self.notifier.submit("approval", THREAD["id"], "swift test")
        self.drain()
        self.assertEqual([token for token, _, _ in self.apns.sent], [other["token"]])
        self.store.remove_watcher(THREAD["id"], other["token"])
        self.notifier.submit("approval", THREAD["id"], "swift test")
        self.assertTrue(self.notifier.events.empty())


class ApnsTests(Case):
    def setUp(self):
        super().setUp()
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        self.key = ec.generate_private_key(ec.SECP256R1())
        key_file = self.directory / "AuthKey_TEST.p8"
        key_file.write_bytes(self.key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ))
        (self.directory / "apns.json").write_text(json.dumps(
            {"key_path": str(key_file), "key_id": "KEY123", "team_id": "TEAM456"}
        ))
        self.calls: list[dict] = []
        self.answer = ("", "200")
        self.sender = core.Apns(self.store, run=self.fake_curl, now=lambda: self.clock[0])
        self.payload = core.compose("finished", THREAD["id"], THREAD, "Done")

    def fake_curl(self, argv, input, capture_output, text, timeout):
        config = dict(line.split(" = ", 1) for line in input.strip().splitlines() if not line.startswith("header"))
        headers = [line.split(" = ", 1)[1].strip('"') for line in input.splitlines() if line.startswith("header")]
        body_file = config["data-binary"].strip('"').lstrip("@")
        self.calls.append({
            "argv": argv, "url": config["url"].strip('"'), "headers": dict(h.split(": ", 1) for h in headers),
            "body": json.loads(Path(body_file).read_text()), "body_file": body_file,
            "body_mode": stat.S_IMODE(os.stat(body_file).st_mode),
        })
        return types.SimpleNamespace(stdout=f"{self.answer[0]}\n{self.answer[1]}", stderr="", returncode=0)

    def test_a_notification_goes_to_apple_with_a_signed_provider_token(self):
        import jwt

        self.assertEqual(self.sender.send(DEVICE["token"], DEVICE, self.payload, "t-finished"), "sent")
        call = self.calls[0]
        self.assertEqual(call["url"], f"https://api.sandbox.push.apple.com/3/device/{DEVICE['token']}")
        self.assertEqual(call["body"], self.payload)
        self.assertEqual(call["headers"]["apns-topic"], "com.danielou.aeriportal")
        self.assertEqual(call["headers"]["apns-push-type"], "alert")
        self.assertEqual(call["headers"]["apns-collapse-id"], "t-finished")
        token = call["headers"]["authorization"].removeprefix("bearer ")
        self.assertEqual(jwt.get_unverified_header(token), {"alg": "ES256", "kid": "KEY123", "typ": "JWT"})
        claims = jwt.decode(token, self.key.public_key(), algorithms=["ES256"], options={"verify_iat": False})
        self.assertEqual(claims, {"iss": "TEAM456", "iat": 1_000_000})

    def test_nothing_secret_is_on_the_command_line_and_the_payload_file_is_private_and_removed(self):
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        call = self.calls[0]
        self.assertEqual(call["argv"], [core.CURL, "--http2", "-sS", "-m", "15", "-K", "-", "-w", "\n%{http_code}"])
        self.assertEqual(call["body_mode"], 0o600)
        self.assertFalse(os.path.exists(call["body_file"]))

    def test_a_device_that_is_not_a_token_and_a_bundle_id_never_reaches_curl(self):
        # As if written into the state file by something other than the routes: a
        # bundle id that would end its line and add an option of its own.
        crafted = 'x"\nurl = "file:///etc/passwd"\noutput = "/tmp/stolen'
        self.assertEqual(self.sender.send(DEVICE["token"], {**DEVICE, "bundle_id": crafted}, self.payload), "gone")
        self.assertEqual(self.sender.send(DEVICE["token"] + '"\nnext', DEVICE, self.payload), "gone")
        self.assertEqual(self.sender.send(DEVICE["token"], {"environment": "sandbox"}, self.payload), "gone")
        self.assertEqual(self.calls, [])

    def test_a_thread_id_that_is_not_one_is_left_out_of_the_request(self):
        self.assertEqual(self.sender.send(DEVICE["token"], DEVICE, self.payload, 't"\nheader = "x: y'), "sent")
        self.assertNotIn("apns-collapse-id", self.calls[0]["headers"])
        self.assertNotIn("x", self.calls[0]["headers"])

    def test_a_production_device_uses_the_production_servers(self):
        self.sender.send(DEVICE["token"], {**DEVICE, "environment": "production"}, self.payload)
        self.assertTrue(self.calls[0]["url"].startswith("https://api.push.apple.com/3/device/"))

    def test_the_provider_token_is_reused_for_a_while_then_renewed(self):
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        self.clock[0] += core.JWT_LIFETIME - 1
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        self.clock[0] += 2
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        tokens = [call["headers"]["authorization"] for call in self.calls]
        self.assertEqual(tokens[0], tokens[1])
        self.assertNotEqual(tokens[1], tokens[2])

    def test_apples_answers_are_told_apart(self):
        for answer, expected in [
            (("", "200"), "sent"),
            (('{"reason":"Unregistered"}', "410"), "gone"),
            (('{"reason":"BadDeviceToken"}', "400"), "gone"),
            (('{"reason":"PayloadTooLarge"}', "413"), "failed"),
            (('{"reason":"ExpiredProviderToken"}', "403"), "failed"),
            (("", ""), "failed"),
        ]:
            self.answer = answer
            self.assertEqual(self.sender.send(DEVICE["token"], DEVICE, self.payload), expected, answer)

    def test_a_rejected_provider_token_is_replaced(self):
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        self.answer = ('{"reason":"ExpiredProviderToken"}', "403")
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        self.answer = ("", "200")
        self.clock[0] += 1
        self.sender.send(DEVICE["token"], DEVICE, self.payload)
        tokens = [call["headers"]["authorization"] for call in self.calls]
        self.assertEqual(tokens[0], tokens[1])
        self.assertNotEqual(tokens[1], tokens[2])

    def test_without_the_key_settings_nothing_is_sent(self):
        (self.directory / "apns.json").unlink()
        self.assertEqual(self.sender.send(DEVICE["token"], DEVICE, self.payload), "failed")
        self.assertEqual(self.calls, [])

    def test_a_curl_that_cannot_run_is_a_failure_not_an_exception(self):
        def broken(*args, **kwargs):
            raise OSError("no curl")

        sender = core.Apns(self.store, run=broken)
        self.assertEqual(sender.send(DEVICE["token"], DEVICE, self.payload), "failed")


class RecordingNotifier:
    def __init__(self):
        self.submitted: list[tuple] = []

    def submit(self, kind, session_id, text="", home=None, **details):
        self.submitted.append((kind, session_id, text, details))


class HookTests(unittest.TestCase):
    """The hooks as Hermes calls them: keyword arguments only, and never an exception."""

    @classmethod
    def setUpClass(cls):
        cls.plugin = load("aeriportal_push_plugin_under_test", PLUGIN / "__init__.py")

    def setUp(self):
        self.recorded = RecordingNotifier()
        self.previous = core._notifier
        core._notifier = self.recorded
        self.hooks: dict = {}
        self.plugin.register(types.SimpleNamespace(register_hook=lambda name, hook: self.hooks.__setitem__(name, hook)))

    def tearDown(self):
        core._notifier = self.previous

    def test_the_hooks_it_registers_are_the_ones_it_declares(self):
        declared = [line.strip()[2:] for line in (PLUGIN / "plugin.yaml").read_text().splitlines() if line.startswith("  - ")]
        self.assertEqual(sorted(self.hooks), sorted(declared))

    def test_an_approval_is_passed_on_under_the_stored_session_id(self):
        self.assertIsNone(self.hooks["pre_approval_request"](
            command="rm -rf build", description="recursive delete", pattern_key="rm", pattern_keys=["rm"],
            session_key="20261005_000000_root01", surface="gateway", turn_id="t", tool_call_id="c",
            session_id="20261005_000000_root01", telemetry_schema_version=1,
        ))
        self.assertEqual(self.recorded.submitted, [("approval", "20261005_000000_root01", "rm -rf build", {})])

    def test_an_approval_hermes_is_still_deciding_by_itself_is_not_passed_on(self):
        # "smart" mode: the hook fires for Hermes's own reviewer before it has decided.
        self.hooks["pre_approval_request"](
            command="ls", description="list", session_key="20261005_000000_root01", surface="smart",
        )
        # The same request again, for a second tool call waiting on the first.
        self.hooks["pre_approval_request"](
            command="ls", description="list", session_key="20261005_000000_root01", surface="gateway", coalesced=True,
        )
        self.assertEqual(self.recorded.submitted, [])

    def test_only_the_clarify_tool_is_passed_on(self):
        self.hooks["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", task_id="t")
        self.assertEqual(self.recorded.submitted, [])
        self.hooks["pre_tool_call"](
            tool_name="clarify", session_id="s1",
            args={"questions": [{"question": "Python or Swift?", "choices": ["Python", "Swift"]}, {"question": "Name?"}]},
        )
        self.assertEqual(self.recorded.submitted, [("question", "s1", "Python or Swift?", {})])

    def test_the_reply_and_the_end_of_the_turn_are_passed_on(self):
        self.hooks["post_llm_call"](session_id="s1", assistant_response="Done.", user_message="go", platform="tui")
        self.hooks["on_session_end"](session_id="s1", completed=True, failed=False, interrupted=False, turn_exit_reason="done")
        self.hooks["on_session_end"](session_id="s1", completed=False, failed=False, interrupted=True)
        self.assertEqual(self.recorded.submitted, [
            ("reply", "s1", "Done.", {}),
            ("turn_end", "s1", "done", {"failed": False, "interrupted": False}),
            ("turn_end", "s1", None, {"failed": False, "interrupted": True}),
        ])

    def test_a_hook_never_raises_whatever_it_is_given(self):
        def broken(*args, **kwargs):
            raise RuntimeError("worker is down")

        self.recorded.submit = broken
        for name, hook in self.hooks.items():
            self.assertIsNone(hook(), name)
            self.assertIsNone(hook(tool_name="clarify", args="not a dict", session_id=object()), name)
            self.assertIsNone(hook(tool_name="clarify", args={"questions": ["not a dict"]}, session_id="s1"), name)


class RouteTests(Case):
    """The route functions, called the way FastAPI calls them."""

    def setUp(self):
        super().setUp()
        self.previous = core._notifier
        core._notifier = self.notifier
        self.api = load("aeriportal_push_api_under_test", PLUGIN / "dashboard" / "plugin_api.py")

    def tearDown(self):
        core._notifier = self.previous

    def test_device_scoped_unsubscribe_over_http_is_validated_and_idempotent(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(self.api.router)
        other = {**DEVICE, "token": "cd" * 32}
        self.store.register(DEVICE, [THREAD])
        self.store.register(other, [THREAD])
        path = f"/threads/{THREAD['id']}/watcher"
        with TestClient(app) as client:
            for body in [None, {}, {"device_token": ""}, {"device_token": "not-hex"}, {"device_token": 12}]:
                response = client.request("DELETE", path, json=body)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(self.store.snapshot()["threads"][THREAD["id"]]["devices"], [DEVICE["token"], other["token"]])
            response = client.request("DELETE", path, json={"device_token": DEVICE["token"]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"devices": 2, "threads": 1, "apns_configured": False})
            self.assertEqual(self.store.snapshot()["threads"][THREAD["id"]]["devices"], [other["token"]])
            self.assertEqual(client.request("DELETE", path, json={"device_token": DEVICE["token"]}).status_code, 200)
            self.assertEqual(client.request("DELETE", "/threads/unknown/watcher", json={"device_token": DEVICE["token"]}).status_code, 200)
            self.assertEqual(client.request("DELETE", "/threads/bad%20id/watcher", json={"device_token": DEVICE["token"]}).status_code, 422)
            self.assertEqual(client.request("DELETE", path, json={"device_token": other["token"]}).status_code, 200)
            self.assertNotIn(THREAD["id"], self.store.snapshot()["threads"])

    def test_the_app_registers_its_device_and_threads_then_stops_watching_one(self):
        body = self.api.Registration(device=DEVICE, threads=[THREAD, {"id": "second", "agent": "aeri"}])
        self.assertEqual(self.api.register(body), {"devices": 1, "threads": 2, "apns_configured": False})
        # The app asks whether the route that stops notifying one device is here.
        self.assertEqual(self.api.status(), {"devices": 1, "threads": 2, "apns_configured": False, "features": ["watcher"]})
        self.assertEqual(self.api.unwatch("second")["threads"], 1)
        # Threads alone can be added later, with no device in the request.
        self.assertEqual(self.api.register(self.api.Registration(threads=[{"id": "third"}]))["threads"], 2)

    def test_watcher_is_a_legal_thread_id_for_scoped_and_global_unsubscribe(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(self.api.router)
        other = {**DEVICE, "token": "cd" * 32}
        for device in [DEVICE, other]:
            self.store.register(device, [{"id": "watcher"}])
        with TestClient(app) as client:
            self.assertEqual(client.request("DELETE", "/threads/watcher/watcher", json={"device_token": DEVICE["token"]}).status_code, 200)
            self.assertEqual(self.store.snapshot()["threads"]["watcher"]["devices"], [other["token"]])
            self.assertEqual(client.delete("/threads/watcher").status_code, 200)
            self.assertNotIn("watcher", self.store.snapshot()["threads"])

    def test_what_is_not_a_device_token_is_refused(self):
        from pydantic import ValidationError

        for token in ["", "short", "zz" * 32, "ab" * 32 + '" ; rm -rf /']:
            with self.assertRaises(ValidationError, msg=token):
                self.api.Registration(device={**DEVICE, "token": token})

    def test_a_bundle_id_or_thread_id_with_anything_else_in_it_is_refused(self):
        from pydantic import ValidationError

        for bundle_id in ["", 'com.example"\nurl = "file:///x', "com.example app", "com/example"]:
            with self.assertRaises(ValidationError, msg=bundle_id):
                self.api.Registration(device={**DEVICE, "bundle_id": bundle_id})
        for thread_id in ["", 'id"\nheader = "x: y', "two words", "a/b"]:
            with self.assertRaises(ValidationError, msg=thread_id):
                self.api.Registration(threads=[{"id": thread_id}])
        # What Hermes and Apple really use passes.
        self.api.Registration(device=DEVICE, threads=[{"id": "20261005_113202_3c1a55"}, {"id": "api:run-1.2"}])

    def test_fields_only_a_bridge_takes_are_ignored_not_refused(self):
        # The app sends these only to a bridge (push_host, push_relay, push_sealed); were one
        # to reach the plugin, it is dropped and the registration still works.
        body = self.api.Registration(
            device={**DEVICE, "relay_token": "v1.claims.signature", "key": "A" * 43 + "="},
            threads=[THREAD],
            host="mbp16",
        )
        self.assertEqual(set(body.device.model_dump()), {"token", "environment", "bundle_id"})
        self.assertEqual(self.api.register(body)["devices"], 1)
        self.assertEqual(set(self.notifier.store.snapshot()["devices"][DEVICE["token"]]), {"environment", "bundle_id", "updated_at"})

    def test_the_routes_are_the_ones_the_app_calls(self):
        routes = sorted((sorted(route.methods)[0], route.path) for route in self.api.router.routes)
        self.assertEqual(routes, [("DELETE", "/threads/{thread_id}"), ("DELETE", "/threads/{thread_id}/watcher"), ("GET", "/status"), ("PUT", "/registration")])


if __name__ == "__main__":
    unittest.main()
