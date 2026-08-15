"""Hermes plugin that applies the rollout's two-phase tool policy."""

import json
import os
from typing import Any
from urllib.request import Request, build_opener

TOOL_URL = os.environ["VF_TOOL_INTERCEPTION_URL"]
TOOL_SECRET = os.environ["VF_TOOL_INTERCEPTION_SECRET"]
OPENER = build_opener()


def _text(content: Any) -> str:
    return (
        content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    )


def _intercept(
    phase: str, tool_call_id: str, tool_name: str, content: Any
) -> dict[str, Any]:
    body = json.dumps(
        {
            "phase": phase,
            "message": {
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content,
                "name": tool_name,
            },
        }
    ).encode()
    request = Request(
        TOOL_URL,
        body,
        {
            "Authorization": f"Bearer {TOOL_SECRET}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with OPENER.open(request, timeout=30) as response:
        decision = json.load(response)
    if decision.get("action") not in {"allow", "rewrite", "stop"}:
        raise ValueError("tool interception returned an invalid action")
    if decision["action"] == "rewrite" and not decision.get("message"):
        raise ValueError("tool interception omitted the rewritten result")
    return decision


def _pre_tool_call(
    tool_name: str, tool_call_id: str = "", **_: Any
) -> dict[str, str] | None:
    try:
        decision = _intercept("before", tool_call_id, tool_name, "")
    except Exception:  # noqa: BLE001 - native hooks must fail closed
        return {"action": "block", "message": "Tool interception is unavailable."}
    if decision["action"] == "allow":
        return None
    if decision["action"] == "rewrite":
        return {"action": "block", "message": _text(decision["message"]["content"])}
    return {
        "action": "block",
        "message": decision.get("reason") or "Rollout terminated by interception.",
    }


def _transform_tool_result(
    tool_name: str, result: str, tool_call_id: str = "", **_: Any
) -> str | None:
    try:
        decision = _intercept("after", tool_call_id, tool_name, result)
    except Exception:  # noqa: BLE001 - native hooks must fail closed
        return json.dumps({"error": "Tool interception is unavailable."})
    if decision["action"] == "allow":
        return None
    if decision["action"] == "rewrite":
        return _text(decision["message"]["content"])
    return json.dumps(
        {"error": decision.get("reason") or "Rollout terminated by interception."}
    )


def register(ctx: Any) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("transform_tool_result", _transform_tool_result)
