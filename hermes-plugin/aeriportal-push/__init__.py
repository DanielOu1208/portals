"""Portals push: a Hermes plugin that notifies the Portals iPhone app when one of its
threads needs an approval, asks a question, or finishes a turn.

The hooks below run inside Hermes's turn, in every process this plugin is enabled in,
for every session. They do no work themselves: each hands a small event to a worker
thread (see ``core.py``) and returns. They never raise, because a hook that raises in
``pre_tool_call`` blocks the tool it was called for.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Callable

_CORE = "aeriportal_push_core"


def load_core():
    """``core.py``, loaded once per process under one name, so the hooks of every
    profile and the HTTP routes share one worker."""
    if _CORE in sys.modules:
        return sys.modules[_CORE]
    spec = importlib.util.spec_from_file_location(_CORE, Path(__file__).resolve().parent / "core.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CORE] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(_CORE, None)
        raise
    return module


def _session_home() -> str | None:
    """The Hermes home of the profile whose turn this is, for looking up the session's
    history later, off this thread."""
    try:
        from hermes_constants import get_hermes_home

        return str(get_hermes_home())
    except Exception:
        return None


def _safely(hook: Callable[..., None]) -> Callable[..., None]:
    def guarded(**kwargs: Any) -> None:
        try:
            hook(**kwargs)
        except Exception:
            pass
        return None

    return guarded


def _approval(**kwargs: Any) -> None:
    # In "smart" approval mode Hermes fires this hook first for its own reviewer, before
    # that has decided anything: most commands it then approves by itself. Only a
    # request put to the user counts, and the echo of one for a parallel tool call
    # (`coalesced`) is the same request again.
    if kwargs.get("surface") == "smart" or kwargs.get("coalesced"):
        return
    session = kwargs.get("session_key") or kwargs.get("session_id")
    load_core().notifier().submit("approval", session, kwargs.get("command") or kwargs.get("description"), _session_home())


def _tool(**kwargs: Any) -> None:
    # The only tool call that needs the user is the clarify tool: it is the question.
    if kwargs.get("tool_name") != "clarify":
        return
    questions = (kwargs.get("args") or {}).get("questions") or []
    first = questions[0].get("question") if questions and isinstance(questions[0], dict) else ""
    load_core().notifier().submit("question", kwargs.get("session_id"), first, _session_home())


def _reply(**kwargs: Any) -> None:
    load_core().notifier().submit("reply", kwargs.get("session_id"), kwargs.get("assistant_response"), _session_home())


def _turn_end(**kwargs: Any) -> None:
    load_core().notifier().submit(
        "turn_end", kwargs.get("session_id"), kwargs.get("turn_exit_reason"), _session_home(),
        failed=bool(kwargs.get("failed")), interrupted=bool(kwargs.get("interrupted")),
    )


def register(ctx: Any) -> None:
    ctx.register_hook("pre_approval_request", _safely(_approval))
    ctx.register_hook("pre_tool_call", _safely(_tool))
    ctx.register_hook("post_llm_call", _safely(_reply))
    ctx.register_hook("on_session_end", _safely(_turn_end))
