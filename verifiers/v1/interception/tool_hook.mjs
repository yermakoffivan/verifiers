/** Bridge native Claude Code and Pi hooks to the rollout's /tool policy. */

const TOOL_URL = process.env.VF_TOOL_INTERCEPTION_URL;
const TOOL_SECRET = process.env.VF_TOOL_INTERCEPTION_SECRET;

function jsonText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function contentText(content) {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
}

async function intercept(
  phase,
  toolCallId,
  name,
  content,
  canRewrite = true,
) {
  const response = await fetch(TOOL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOOL_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phase,
      can_rewrite: canRewrite,
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
  if (decision.action === "rewrite" && !decision.message) {
    throw new Error("tool interception omitted the rewritten result");
  }
  return decision;
}

function claudeCanRewrite(hook) {
  return (
    typeof hook.tool_response === "string" ||
    hook.tool_name === "Bash" ||
    hook.tool_name.startsWith("mcp__")
  );
}

function claudeToolOutput(hook, content) {
  const text = contentText(content);
  if (typeof hook.tool_response === "string" || hook.tool_name.startsWith("mcp__")) {
    return text;
  }
  if (
    hook.tool_name === "Bash" &&
    hook.tool_response &&
    typeof hook.tool_response === "object" &&
    !Array.isArray(hook.tool_response)
  ) {
    return { ...hook.tool_response, stdout: text, stderr: "" };
  }
  throw new Error(`Claude cannot replace ${hook.tool_name}'s structured output`);
}

function nativeDecision(hook, decision) {
  if (decision.action === "allow") return undefined;
  const reason = decision.reason || "Rollout terminated by interception.";
  if (decision.action === "stop") {
    return { continue: false, stopReason: reason };
  }

  const content = decision.message.content;
  if (hook.hook_event_name === "PreToolUse") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: contentText(content),
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: claudeToolOutput(hook, content),
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function runCommandHook() {
  try {
    const hook = JSON.parse(await readStdin());
    const before = hook.hook_event_name === "PreToolUse";
    const failed = hook.hook_event_name === "PostToolUseFailure";
    const content = before
      ? ""
      : failed
        ? hook.error || "Tool execution failed."
        : jsonText(hook.tool_response);
    const decision = await intercept(
      before ? "before" : failed ? "after_failure" : "after",
      hook.tool_use_id,
      hook.tool_name,
      content,
      before || (!failed && claudeCanRewrite(hook)),
    );
    const output = nativeDecision(hook, decision);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    const output = {
      continue: false,
      stopReason: "Tool interception is unavailable.",
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

function piContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
  const converted = parts.map((part) => {
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

function toPiContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return part;
    const match = /^data:([^;,]+);base64,(.*)$/.exec(part.image_url.url);
    return match
      ? { type: "image", mimeType: match[1], data: match[2] }
      : { type: "text", text: part.image_url.url };
  });
}

export default function toolInterceptionExtension(pi) {
  pi.on("tool_call", async (event, ctx) => {
    // Pi's Responses provider appends its item id after `|`; the model call id
    // before it is the identity stored in the Verifiers trace.
    const toolCallId = event.toolCallId.split("|", 1)[0];
    let decision;
    try {
      decision = await intercept(
        "before",
        toolCallId,
        event.toolName,
        "",
      );
    } catch {
      ctx.abort();
      return {
        block: true,
        reason: "Tool interception is unavailable.",
      };
    }
    if (decision.action === "allow") return undefined;
    if (decision.action === "stop") ctx.abort();
    return {
      block: true,
      reason:
        decision.action === "rewrite"
          ? contentText(decision.message.content)
          : decision.reason || "Rollout terminated by interception.",
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolCallId = event.toolCallId.split("|", 1)[0];
    let decision;
    try {
      decision = await intercept(
        "after",
        toolCallId,
        event.toolName,
        piContent(event.content),
      );
    } catch {
      ctx.abort();
      return {
        content: [{ type: "text", text: "Tool interception is unavailable." }],
        isError: true,
      };
    }
    if (decision.action === "allow") return undefined;
    if (decision.action === "stop") {
      ctx.abort();
      return {
        content: [
          {
            type: "text",
            text: decision.reason || "Rollout terminated by interception.",
          },
        ],
        isError: true,
      };
    }
    return { content: toPiContent(decision.message.content) };
  });
}

if (process.argv.includes("claude")) await runCommandHook();
