"""Native harness tool hooks normalized onto the rollout interception API."""

from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel

from verifiers.v1.types import ToolMessage

if TYPE_CHECKING:
    from verifiers.v1.runtimes import Runtime

TOOL_HOOK_SCRIPT = Path(__file__).with_name("tool_hook.mjs").read_text()
TOOL_HOOK_SOURCE = TOOL_HOOK_SCRIPT.encode()
HERMES_TOOL_HOOK_SOURCE = Path(__file__).with_name("hermes_tool_hook.py").read_bytes()


def tool_hook_env(url: str, secret: str) -> dict[str, str]:
    return {
        "VF_TOOL_INTERCEPTION_SECRET": secret,
        "VF_TOOL_INTERCEPTION_URL": url,
    }


async def install_tool_hook(
    runtime: "Runtime",
    path: str,
    url: str,
    secret: str,
    source: bytes = TOOL_HOOK_SOURCE,
) -> dict[str, str]:
    """Write the shared native-hook bridge and return its private connection env."""
    await runtime.write(path, source)
    return tool_hook_env(url, secret)


class ToolHookRequest(BaseModel):
    phase: Literal["before", "after", "after_failure"]
    can_rewrite: bool = True
    message: ToolMessage
