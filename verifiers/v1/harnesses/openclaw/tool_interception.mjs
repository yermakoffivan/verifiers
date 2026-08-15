/** Bridge OpenClaw's native tool hooks to the rollout's /tool policy. */

const PLUGIN_ID = "verifiers-tool-interception";
const TOOL_URL = process.env.VF_TOOL_INTERCEPTION_URL;
const TOOL_SECRET = process.env.VF_TOOL_INTERCEPTION_SECRET;
const UNAVAILABLE = "Tool interception is unavailable.";

function contentText(content) {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? part.text : part.image_url?.url || JSON.stringify(part),
    )
    .join("\n");
}

function toMessageContent(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  const converted = content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      };
    }
    return { type: "text", text: JSON.stringify(part) };
  });
  return converted.every((part) => part.type === "text")
    ? converted.map((part) => part.text).join("\n")
    : converted;
}

function toOpenClawContent(content) {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const converted = parts.map((part) => {
    if (part.type === "text") return part;
    const url = part.image_url.url;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    return match
      ? { type: "image", mimeType: match[1], data: match[2] }
      : { type: "text", text: url };
  });
  return converted.length ? converted : [{ type: "text", text: "" }];
}

async function intercept(phase, toolCallId, name, content) {
  if (!TOOL_URL || !TOOL_SECRET || !toolCallId) throw new Error(UNAVAILABLE);
  const response = await fetch(TOOL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOOL_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phase,
      can_rewrite: true,
      message: {
        role: "tool",
        tool_call_id: toolCallId,
        content,
        name,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`tool interception returned ${response.status}`);
  const decision = await response.json();
  if (!["allow", "rewrite", "stop"].includes(decision.action)) {
    throw new Error("tool interception returned an invalid action");
  }
  if (
    decision.action === "rewrite" &&
    (!decision.message || !("content" in decision.message))
  ) {
    throw new Error("tool interception omitted the rewritten result");
  }
  return decision;
}

function terminalResult(result, reason) {
  return {
    ...result,
    content: [{ type: "text", text: reason }],
    details: { status: "error", toolInterceptionStopped: true },
  };
}

export default {
  id: PLUGIN_ID,
  name: "Verifiers tool interception",
  register(api) {
    const blockedToolCalls = new Set();
    let halted = false;
    api.on(
      "before_tool_call",
      async (event) => {
        if (halted) {
          if (event.toolCallId) blockedToolCalls.add(event.toolCallId);
          return { block: true, blockReason: UNAVAILABLE };
        }
        let decision;
        try {
          decision = await intercept(
            "before",
            event.toolCallId,
            event.toolName,
            "",
          );
        } catch {
          halted = true;
          if (event.toolCallId) blockedToolCalls.add(event.toolCallId);
          return { block: true, blockReason: UNAVAILABLE };
        }
        if (decision.action === "allow") return undefined;
        if (decision.action === "stop") halted = true;
        if (event.toolCallId) blockedToolCalls.add(event.toolCallId);
        return {
          block: true,
          blockReason:
            decision.action === "rewrite"
              ? contentText(decision.message.content)
              : decision.reason || "Rollout terminated by interception.",
        };
      },
      { timeoutMs: 35_000 },
    );

    api.registerAgentToolResultMiddleware(
      async (event) => {
        // OpenClaw emits `tool_result` for a pre-execution veto. The before hook
        // already supplied that synthetic result to Verifiers, so do not process it twice.
        if (blockedToolCalls.delete(event.toolCallId)) return undefined;
        let decision;
        try {
          decision = await intercept(
            "after",
            event.toolCallId,
            event.toolName,
            toMessageContent(event.result.content),
          );
        } catch {
          halted = true;
          return { result: terminalResult(event.result, UNAVAILABLE) };
        }
        if (decision.action === "allow") return undefined;
        if (decision.action === "stop") {
          halted = true;
          return {
            result: terminalResult(
              event.result,
              decision.reason || "Rollout terminated by interception.",
            ),
          };
        }
        return {
          result: {
            ...event.result,
            content: toOpenClawContent(decision.message.content),
          },
        };
      },
      { runtimes: ["openclaw"] },
    );
  },
};
