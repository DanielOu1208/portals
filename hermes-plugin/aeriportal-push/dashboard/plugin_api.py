"""HTTP routes for the Portals iPhone app, mounted by the Hermes dashboard server at
``/api/plugins/aeriportal-push/`` behind its usual sign-in.

- ``PUT  registration``   the device to notify and the threads to notify about
- ``DELETE threads/{id}/watcher`` stop notifying this device about a thread
- ``DELETE threads/{id}`` stop notifying every device about a thread
- ``GET  status``         how many devices and threads are registered, whether the
                          APNs key is in place, and ``features``: ``watcher`` for the
                          route above that stops notifying one device
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Path as PathParameter
from pydantic import BaseModel, Field

_CORE = "aeriportal_push_core"


def _core():
    if _CORE in sys.modules:
        return sys.modules[_CORE]
    spec = importlib.util.spec_from_file_location(_CORE, Path(__file__).resolve().parent.parent / "core.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CORE] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(_CORE, None)
        raise
    return module


# The token, the bundle id and the thread id end up in the request the plugin has curl
# send to Apple, so they are held to the characters they are made of. `core.Apns.send`
# checks the same patterns again, for values that reached the state file another way.
class Device(BaseModel):
    token: str = Field(min_length=32, max_length=200, pattern=_core().TOKEN_PATTERN)
    environment: str = "sandbox"
    bundle_id: str = Field(min_length=1, max_length=200, pattern=_core().BUNDLE_ID_PATTERN)


class Thread(BaseModel):
    id: str = Field(min_length=1, max_length=200, pattern=_core().THREAD_ID_PATTERN)
    agent: str = ""
    agent_name: str = ""
    title: str = ""


class Registration(BaseModel):
    device: Optional[Device] = None
    threads: List[Thread] = Field(default_factory=list, max_length=2000)


class Watcher(BaseModel):
    device_token: str = Field(min_length=32, max_length=200, pattern=_core().TOKEN_PATTERN)


router = APIRouter()

# The server that mounts these routes is the one the app's sessions run in: from here
# on the hooks in this process do their work.
_core().arm()


def _summary(state: dict) -> dict:
    store = _core().notifier().store
    return {"devices": len(state["devices"]), "threads": len(state["threads"]), "apns_configured": store.apns_config() is not None}


@router.put("/registration")
def register(body: Registration) -> dict:
    store = _core().notifier().store
    state = store.register(body.device.model_dump() if body.device else None, [thread.model_dump() for thread in body.threads])
    return _summary(state)


@router.delete("/threads/{thread_id}")
def unwatch(thread_id: str) -> dict:
    return _summary(_core().notifier().store.unwatch(thread_id))


@router.delete("/threads/{thread_id}/watcher")
def remove_watcher(
    body: Watcher,
    thread_id: str = PathParameter(min_length=1, max_length=200, pattern=_core().THREAD_ID_PATTERN),
) -> dict:
    return _summary(_core().notifier().store.remove_watcher(thread_id, body.device_token))


@router.get("/status")
def status() -> dict:
    # `watcher`: the route that stops notifying one device is here. The app asks before
    # using it; a plugin from before it answers without, and gets the global DELETE.
    return {**_summary(_core().notifier().store.snapshot()), "features": ["watcher"]}
