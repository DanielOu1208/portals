"""Portals push: what the hooks (``__init__.py``) and the HTTP routes
(``dashboard/plugin_api.py``) share.

The app registers its device token and the ids of its threads over the routes. The hooks
see every session in every Hermes process the plugin is enabled in (the Discord gateway
too), so the first thing that happens to an event is a lookup in that registry: a
session the app did not start costs a dictionary miss and nothing else.

State lives in files under ``<Hermes root>/aeriportal-push/`` because the hooks and the
routes are loaded as separate modules, once per profile, possibly in different
processes:

- ``state.json``  devices and watched threads, written by the routes
- ``apns.json``   ``{"key_path", "key_id", "team_id"}``: the APNs auth key (.p8), put
                  there by hand. Without it nothing is sent.

With ``AERIPORTAL_PUSH_DRY_RUN=<file>`` in the environment, notifications are appended to
that file instead of being sent, which needs no key.

Nothing here may raise into Hermes: a hook that raises in ``pre_tool_call`` blocks the
tool. Hooks only put an event on a queue; one worker thread does the rest.

Loading the HTTP routes arms the serving process (``arm``). With
``dashboard.turn_isolation``, the app's turns run in a persistent compute child
instead, identified by Hermes's ``HERMES_COMPUTE_HOST_CHILD=1`` marker. Both may submit
events; the registry still limits delivery to watched threads and their devices.
Elsewhere (the messaging gateway, the CLI) the hooks return at once.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import queue
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("aeriportal_push")

#: The longest preview a notification carries.
PREVIEW_LIMIT = 120
#: How long an APNs provider token is reused. Apple accepts one for an hour and objects
#: to a new one more often than every 20 minutes.
JWT_LIFETIME = 50 * 60
#: How long a session that is not one of the app's threads is remembered as such.
MISS_LIFETIME = 10 * 60
#: Within this long, the same request is notified about once. Hermes announces an
#: approval twice in "smart" approval mode: when its reviewer hands the decision to the
#: user, and again when it starts waiting for the answer.
REPEAT_WINDOW = 60
CURL = "/usr/bin/curl"


_armed = False


def arm() -> None:
    """Called by the HTTP routes to enable hooks in the serving parent."""
    global _armed
    _armed = True


def is_armed() -> bool:
    return _armed


def state_dir() -> Path:
    """``<Hermes root>/aeriportal-push``; the root is the same for every profile."""
    override = os.environ.get("AERIPORTAL_PUSH_HOME", "").strip()
    if override:
        return Path(override)
    try:
        from hermes_constants import get_default_hermes_root

        return Path(get_default_hermes_root()) / "aeriportal-push"
    except Exception:
        return Path.home() / ".hermes" / "aeriportal-push"


# What a device token, a bundle id and a thread id are made of. Each goes into the
# request curl sends to Apple; anything else in them could add a line to it.
TOKEN_PATTERN = r"^[0-9a-fA-F]+$"
BUNDLE_ID_PATTERN = r"^[A-Za-z0-9.-]+$"
THREAD_ID_PATTERN = r"^[A-Za-z0-9_.:-]+$"


def redacted(text: Any) -> str:
    """``text`` with keys and tokens masked the way Hermes masks them, so a secret an
    agent printed is not carried to Apple and a lock screen. Outside Hermes, where its
    module is not there to ask, the text as it is."""
    text = str(text or "")
    try:
        from agent.redact import redact_sensitive_text

        return redact_sensitive_text(text, force=True)
    except Exception:
        return text


def preview(text: Any, limit: int = PREVIEW_LIMIT) -> str:
    """The first line with something on it, cut to ``limit`` characters."""
    for line in str(text or "").splitlines():
        line = " ".join(line.split())
        if line:
            return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"
    return ""


# --------------------------------------------------------------------------- registry


class Store:
    """Devices and watched threads, in ``state.json``. Reads are cached until the file
    changes; writes take a lock, so two processes cannot lose each other's change."""

    def __init__(self, directory: Optional[Path] = None):
        self.directory = Path(directory) if directory else state_dir()
        self._cached: tuple[float, dict] | None = None
        # The last registry read or written in full: what a read that fails for a moment
        # answers with, without caching it, so the next read tries the file again.
        self._good: dict | None = None
        self._lock = threading.Lock()

    @property
    def _file(self) -> Path:
        return self.directory / "state.json"

    def _last_good(self) -> dict:
        with self._lock:
            return self._good if self._good is not None else {"devices": {}, "threads": {}}

    def snapshot(self) -> dict:
        """The registry. No file, or one that is not JSON, is an empty one. A read that
        fails otherwise (permissions, I/O) answers with the last registry known, and is
        not cached: the hooks of a process that only reads it would otherwise send
        nothing until the next write."""
        try:
            modified = self._file.stat().st_mtime_ns
        except FileNotFoundError:
            return {"devices": {}, "threads": {}}
        except OSError:
            return self._last_good()
        with self._lock:
            if self._cached and self._cached[0] == modified:
                return self._cached[1]
        try:
            data = json.loads(self._file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            # Gone since the stat: empty, and read again next time.
            return {"devices": {}, "threads": {}}
        except ValueError:
            data = {}
        except OSError:
            return self._last_good()
        state = {
            "devices": data.get("devices") if isinstance(data, dict) and isinstance(data.get("devices"), dict) else {},
            "threads": data.get("threads") if isinstance(data, dict) and isinstance(data.get("threads"), dict) else {},
        }
        with self._lock:
            self._cached = (modified, state)
            self._good = state
        return state

    def is_active(self) -> bool:
        """Whether there is anyone to notify about anything."""
        state = self.snapshot()
        return bool(state["devices"]) and bool(state["threads"])

    def _update(self, change: Callable[[dict], None]) -> dict:
        self.directory.mkdir(parents=True, exist_ok=True)
        with open(self.directory / "state.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                data = json.loads(self._file.read_text(encoding="utf-8"))
            except (FileNotFoundError, ValueError):
                data = {}
            state = {
                "devices": data.get("devices") if isinstance(data.get("devices"), dict) else {},
                "threads": data.get("threads") if isinstance(data.get("threads"), dict) else {},
            }
            change(state)
            handle, temporary = tempfile.mkstemp(dir=self.directory, prefix="state.", suffix=".tmp")
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(state, out, indent=1, sort_keys=True)
            os.chmod(temporary, 0o600)
            os.replace(temporary, self._file)
        with self._lock:
            self._cached = None
            self._good = state
        return state

    def register(self, device: Optional[dict], threads: list[dict]) -> dict:
        """Adds or updates a device and threads. Nothing is removed. A thread is
        watched by the devices that registered it: each installation of the app has
        its own threads, and is told about those only."""
        now = int(time.time())
        token = str(device["token"]) if device and device.get("token") else ""

        def change(state: dict) -> None:
            if token:
                state["devices"][token] = {
                    "environment": "production" if device.get("environment") == "production" else "sandbox",
                    "bundle_id": str(device.get("bundle_id") or ""),
                    "updated_at": now,
                }
            for thread in threads:
                if not thread.get("id"):
                    continue
                before = state["threads"].get(str(thread["id"])) or {}
                watchers = [str(item) for item in before.get("devices") or []]
                if token and token not in watchers:
                    watchers.append(token)
                state["threads"][str(thread["id"])] = {
                    "agent": str(thread.get("agent") or ""),
                    "agent_name": str(thread.get("agent_name") or thread.get("agent") or ""),
                    "title": str(thread.get("title") or ""),
                    "devices": watchers,
                    "updated_at": now,
                }

        return self._update(change)

    def devices_watching(self, thread: dict) -> dict:
        """The devices to tell about a thread: the ones that registered it. A thread
        registered with no device named goes to every device."""
        devices = self.snapshot()["devices"]
        watchers = thread.get("devices") or []
        if not watchers:
            return dict(devices)
        return {token: devices[token] for token in watchers if token in devices}

    def unwatch(self, thread_id: str) -> dict:
        return self._update(lambda state: state["threads"].pop(str(thread_id), None))

    def remove_watcher(self, thread_id: str, token: str) -> dict:
        """A local unsubscribe; legacy broadcasts have no individual watchers."""
        def change(state: dict) -> None:
            thread = state["threads"].get(thread_id)
            if not thread or token not in (thread.get("devices") or []):
                return
            watchers = [watcher for watcher in thread["devices"] if watcher != token]
            if watchers:
                thread.update(devices=watchers, updated_at=int(time.time()))
            else:
                # An empty watcher list means broadcast, not nobody.
                del state["threads"][thread_id]

        return self._update(change)

    def drop_device(self, token: str) -> dict:
        return self._update(lambda state: state["devices"].pop(str(token), None))

    def apns_config(self) -> Optional[dict]:
        """The APNs key settings, or None when they are missing or incomplete."""
        try:
            data = json.loads((self.directory / "apns.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or not all(data.get(key) for key in ("key_path", "key_id", "team_id")):
            return None
        return data


def hermes_lineage(session_id: str, home: Optional[str]) -> list[str]:
    """The ids a session has had, oldest first. Context compression moves a session to
    a child id; the app knows its thread by the first one."""
    try:
        from hermes_state import SessionDB

        database = SessionDB(db_path=Path(home) / "state.db", read_only=True) if home else SessionDB(read_only=True)
        try:
            return [str(item) for item in database.get_compression_lineage(session_id) or []]
        finally:
            close = getattr(database, "close", None)
            if callable(close):
                close()
    except Exception:
        return []


# --------------------------------------------------------------------------- APNs


class Apns:
    """Sends one notification to one device, with ``curl --http2`` (APNs is HTTP/2
    only, and Hermes's Python has no HTTP/2 client). The provider token and the payload
    reach curl on stdin and in a private file, never on its command line."""

    def __init__(self, store: Store, run: Optional[Callable[..., Any]] = None, now: Callable[[], float] = time.time):
        self.store = store
        self.run = run or subprocess.run
        self.now = now
        self._token: tuple[float, str, str] | None = None  # (made at, key id, jwt)

    def provider_token(self, config: dict) -> str:
        made_at = self.now()
        if self._token and self._token[1] == config["key_id"] and made_at - self._token[0] < JWT_LIFETIME:
            return self._token[2]
        import jwt  # PyJWT, part of Hermes's environment

        key = Path(os.path.expanduser(str(config["key_path"]))).read_text(encoding="utf-8")
        token = jwt.encode(
            {"iss": config["team_id"], "iat": int(made_at)}, key, algorithm="ES256", headers={"kid": config["key_id"]}
        )
        self._token = (made_at, config["key_id"], token)
        return token

    def send(self, token: str, device: dict, payload: dict, collapse_id: str = "") -> str:
        """Returns ``sent``, ``gone`` (the device no longer wants them: forget it), or
        ``failed``."""
        dry_run = os.environ.get("AERIPORTAL_PUSH_DRY_RUN", "").strip()
        if dry_run:
            # For trying the plugin without an APNs key: what would be sent, as lines.
            with open(dry_run, "a", encoding="utf-8") as out:
                out.write(json.dumps({"device": token[:8], "payload": payload}, ensure_ascii=False) + "\n")
            return "sent"
        config = self.store.apns_config()
        if not config:
            return "failed"
        topic = str(device.get("bundle_id", ""))
        if not (re.fullmatch(TOKEN_PATTERN, token) and re.fullmatch(BUNDLE_ID_PATTERN, topic)):
            # Not what the routes accept, so it got into the state file some other
            # way. Nothing made of it is handed to curl, and the device is forgotten.
            log.warning("aeriportal-push: a registered device is not a token and a bundle id; dropped")
            return "gone"
        if not re.fullmatch(THREAD_ID_PATTERN, collapse_id):
            collapse_id = ""
        host = "api.push.apple.com" if device.get("environment") == "production" else "api.sandbox.push.apple.com"
        handle, body_file = tempfile.mkstemp(prefix="aeriportal-push.", suffix=".json")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(payload, out, ensure_ascii=False)
            lines = [
                f'url = "https://{host}/3/device/{token}"',
                f'header = "authorization: bearer {self.provider_token(config)}"',
                f'header = "apns-topic: {topic}"',
                'header = "apns-push-type: alert"',
                'header = "apns-priority: 10"',
                f'header = "apns-expiration: {int(self.now()) + 3600}"',
                'header = "content-type: application/json"',
                f'data-binary = "@{body_file}"',
            ]
            if collapse_id:
                lines.append(f'header = "apns-collapse-id: {collapse_id[:64]}"')
            done = self.run(
                [CURL, "--http2", "-sS", "-m", "15", "-K", "-", "-w", "\n%{http_code}"],
                input="\n".join(lines) + "\n", capture_output=True, text=True, timeout=25,
            )
        except Exception as error:
            log.warning("aeriportal-push: could not send: %s", error)
            return "failed"
        finally:
            try:
                os.unlink(body_file)
            except OSError:
                pass

        answer, _, status = (done.stdout or "").rpartition("\n")
        if status.strip() == "200":
            return "sent"
        try:
            reason = json.loads(answer).get("reason", "")
        except ValueError:
            reason = ""
        if status.strip() == "410" or reason in ("BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"):
            return "gone"
        if status.strip() == "403":
            self._token = None  # a provider token Apple no longer accepts
        log.warning("aeriportal-push: APNs answered %s %s %s", status.strip() or "nothing", reason, (done.stderr or "").strip()[:200])
        return "failed"


# --------------------------------------------------------------------------- notifier


def compose(kind: str, thread_id: str, thread: dict, text: str) -> Optional[dict]:
    """The notification for an event: the agent as title, the thread's title under it,
    and a short preview of what happened.

    ``mutable-content`` hands it to the app's notification extension before it is
    shown, which puts the agent's avatar on it; ``aeriportal.agent`` says whose."""
    words = preview(redacted(text))
    body = {
        "approval": f"Wants to run: {words}" if words else "Needs your approval",
        "question": words or "Has a question for you",
        "finished": words or "Finished",
        "failed": f"Stopped with an error: {words}" if words else "Stopped with an error",
    }.get(kind)
    if body is None:
        return None
    alert = {"title": thread.get("agent_name") or thread.get("agent") or "Agent", "body": preview(body, PREVIEW_LIMIT + 30)}
    if thread.get("title"):
        alert["subtitle"] = preview(redacted(thread["title"]), 80)
    details = {"thread": thread_id, "kind": kind}
    if thread.get("agent"):
        details["agent"] = str(thread["agent"])
    return {
        "aps": {"alert": alert, "sound": "default", "thread-id": thread_id, "mutable-content": 1},
        "aeriportal": details,
    }


class Notifier:
    """Turns hook events into notifications, on one worker thread."""

    def __init__(
        self,
        store: Optional[Store] = None,
        apns: Optional[Apns] = None,
        lineage: Callable[[str, Optional[str]], list[str]] = hermes_lineage,
        now: Callable[[], float] = time.time,
    ):
        self.store = store or Store()
        self.apns = apns or Apns(self.store)
        self.lineage = lineage
        self.now = now
        self.events: queue.Queue = queue.Queue(maxsize=200)
        self._worker: threading.Thread | None = None
        self._start = threading.Lock()
        self._misses: dict[str, float] = {}
        self._replies: dict[str, str] = {}
        self._asked: dict[tuple[str, str], tuple[str, float]] = {}

    # Called from hooks: must be quick and must not raise.

    def submit(self, kind: str, session_id: Any, text: Any = "", home: Optional[str] = None, **details: Any) -> None:
        try:
            if (
                not (_armed or os.environ.get("HERMES_COMPUTE_HOST_CHILD") == "1")
                or not session_id
                or not self.store.is_active()
            ):
                return
            self.events.put_nowait({"kind": kind, "session": str(session_id), "text": text, "home": home, **details})
            self._ensure_worker()
        except Exception:
            pass  # a full queue or a broken state file costs a notification, not a turn

    def _ensure_worker(self) -> None:
        with self._start:
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._run, name="aeriportal-push", daemon=True)
                self._worker.start()

    def _run(self) -> None:
        while True:
            event = self.events.get()
            try:
                self.handle(event)
            except Exception as error:
                log.warning("aeriportal-push: %s", error)

    # On the worker thread.

    def thread_for(self, session_id: str, home: Optional[str]) -> Optional[tuple[str, dict]]:
        """The app's thread a session belongs to: the session itself, or, after
        compression moved it to a child id, the id it started with."""
        threads = self.store.snapshot()["threads"]
        if session_id in threads:
            return session_id, threads[session_id]
        if self._misses.get(session_id, 0) > self.now():
            return None
        for ancestor in self.lineage(session_id, home):
            if ancestor in threads:
                return ancestor, threads[ancestor]
        if len(self._misses) > 2000:
            self._misses.clear()
        self._misses[session_id] = self.now() + MISS_LIFETIME
        return None

    def handle(self, event: dict) -> list[str]:
        """Sends what the event calls for. Returns what happened per device, for tests."""
        found = self.thread_for(event["session"], event.get("home"))
        if not found:
            return []
        thread_id, thread = found
        kind = event["kind"]

        if kind == "reply":
            # Kept for the end of the turn, which is what is notified about.
            self._replies[thread_id] = str(event.get("text") or "")
            return []
        if kind == "turn_end":
            reply = self._replies.pop(thread_id, "")
            if event.get("interrupted"):
                return []  # stopped by hand, or the session closing
            kind = "failed" if event.get("failed") else "finished"
            text = reply if kind == "finished" else str(event.get("text") or reply)
        else:
            text = str(event.get("text") or "")

        payload = compose(kind, thread_id, thread, text)
        if payload is None:
            return []
        if kind in ("approval", "question"):
            asked = payload["aps"]["alert"]["body"]
            before = self._asked.get((thread_id, kind))
            if before and before[0] == asked and self.now() - before[1] < REPEAT_WINDOW:
                return []
            self._asked[(thread_id, kind)] = (asked, self.now())
        results = []
        for token, device in list(self.store.devices_watching(thread).items()):
            result = self.apns.send(token, device, payload, collapse_id=f"{thread_id}-{kind}")
            if result == "gone":
                self.store.drop_device(token)
            results.append(result)
        # What was notified about and how it went; never the words or the device.
        log.info("aeriportal-push: %s for thread %s: %s", kind, thread_id, ", ".join(results) or "no devices")
        return results


_notifier: Notifier | None = None
_notifier_lock = threading.Lock()


def notifier() -> Notifier:
    """The process's one notifier."""
    global _notifier
    with _notifier_lock:
        if _notifier is None:
            _notifier = Notifier()
        return _notifier
