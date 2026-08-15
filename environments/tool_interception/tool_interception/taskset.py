"""Block a tool, rewrite a completed result, and observe a failed result."""

import verifiers.v1 as vf

BLOCKED_SENTINEL = ".vf-tool-interception-blocked"
BLOCKED_COMMAND = f"touch {BLOCKED_SENTINEL}"
SUCCESS_MARKER = "vf-native-tool-result"
SUCCESS_COMMAND = f"printf {SUCCESS_MARKER}"
FAILURE_MARKER = "vf-native-tool-failure"
FAILURE_COMMAND = f"sh -c 'printf {FAILURE_MARKER} >&2; exit 1'"
BLOCKED_RESULT = f"The command was blocked. Now use the shell exactly once to run `{SUCCESS_COMMAND}`."
SUCCESS_RESULT = (
    "The command ran, but this text replaced its result before the agent saw it. "
    f"Now use the shell exactly once to run `{FAILURE_COMMAND}`, then finish."
)


def issuing_call(request: vf.Request, result: vf.ToolMessage) -> vf.ToolCall | None:
    for message in reversed(request.messages[:-1]):
        if not isinstance(message, vf.AssistantMessage):
            continue
        return next(
            (
                call
                for call in message.tool_calls or []
                if call.id == result.tool_call_id
            ),
            None,
        )
    return None


class ToolInterceptionTask(vf.Task):
    @vf.intercept
    def rewrite_tool_result(
        self, request: vf.Request, trace: vf.Trace
    ) -> vf.Request | None:
        if not request.messages or not isinstance(request.messages[-1], vf.ToolMessage):
            return None
        result = request.messages[-1]
        call = issuing_call(request, result)
        if call is None:
            return None
        if FAILURE_MARKER in str(result.content):
            trace.info["native_failure_observed"] = True
            return None
        replacement = None
        if not result.content and BLOCKED_SENTINEL in call.arguments:
            replacement = BLOCKED_RESULT
        elif SUCCESS_MARKER in str(result.content):
            replacement = SUCCESS_RESULT
        if replacement is None:
            return None
        return request.model_copy(
            update={
                "messages": [
                    *request.messages[:-1],
                    result.model_copy(update={"content": replacement}),
                ]
            }
        )

    @vf.reward
    async def intercepted(self, trace: vf.Trace, runtime: vf.Runtime) -> float:
        blocked = (
            await runtime.run(["test", "-e", BLOCKED_SENTINEL], {})
        ).exit_code == 0
        results = [str(message.content) for message in trace.tool_messages]
        return float(
            not blocked
            and any(BLOCKED_RESULT in result for result in results)
            and any(SUCCESS_RESULT in result for result in results)
            and trace.info.get("native_failure_observed") is True
            and trace.num_branches == 1
        )


class ToolInterceptionTaskset(vf.Taskset[ToolInterceptionTask]):
    def load(self) -> list[ToolInterceptionTask]:
        prompt = (
            f"Use a shell tool exactly once to run `{BLOCKED_COMMAND}`. Follow the tool "
            "result's next instruction exactly, then stop using tools and finish."
        )
        return [
            ToolInterceptionTask(vf.TaskData(idx=0, prompt=prompt), self.config.task)
        ]
