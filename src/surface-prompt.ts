/**
 * WeChat surface-prompt helpers: session-id extraction for prompt assembly
 * and the model-facing runtime-context text.
 *
 * DSH interpolates `{{variable}}` in runtime-context text; an unknown
 * reference throws and aborts the turn. User-edited prompts must not be
 * able to introduce those groups, so `{{` is broken up before injection.
 */

export function sessionIdFrom(session: unknown): string | undefined {
  if (!session || typeof session !== "object") return undefined;
  const s = session as {
    id?: unknown;
    header?: { id?: unknown };
    session?: { id?: unknown; header?: { id?: unknown } };
  };
  const candidates = [s.id, s.header?.id, s.session?.header?.id, s.session?.id];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}

/**
 * Session id for one `systemPrompt.context` evaluation.
 *
 * `assembleContextFor(agent)` still puts the live agent on `context.agent`
 * (and as `context.scope`). The public `AssembleContext` type no longer
 * declares `agent`, so we also accept `scope` and walk the same id paths
 * `sessionIdFrom` uses.
 */
export function sessionIdFromAssembleContext(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const c = context as { agent?: unknown; scope?: unknown };
  // Agent shape: prefer session.header.id then session.id then agent.id
  // (same cascade as the pre-0.8.0 callback). Session-shaped `scope`
  // falls through to sessionIdFrom.
  const fromAgentLike = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const a = value as {
      id?: unknown;
      session?: { id?: unknown; header?: { id?: unknown } };
    };
    const candidates = [a.session?.header?.id, a.session?.id, a.id];
    for (const id of candidates) {
      if (typeof id === "string" && id) return id;
    }
    return sessionIdFrom(value);
  };
  return fromAgentLike(c.agent) ?? fromAgentLike(c.scope);
}

/** Neutralize DSH `{{variable}}` interpolation in user-authored context text. */
export function sanitizeRuntimeContextText(text: string): string {
  return text.replaceAll("{{", "{ {");
}

export function weChatSurfaceText(opts: {
  enabled: boolean;
  prompt: string;
  source: "wechat" | "gui" | undefined;
}): string {
  if (!opts.enabled || opts.source !== "wechat") return "";
  const prompt = opts.prompt.trim();
  if (!prompt) return "";
  return sanitizeRuntimeContextText(prompt);
}
