/**
 * Native command dispatch — verifies the WeChat-side integration with
 * DSH's `ctx.commands` plugin-owned registry (`@deepseek-ai/dsh-commands`).
 *
 * The bridge routes a leading-slash line through three layers in order:
 *   1. `ctx.commands.find` — host-side native registry. Hit → run the
 *      handler, render to WeChat. Miss → fall through.
 *   2. Local whitelist — `parseXxxCommand` parsers (`/silent`, `/next`,
 *      `/workspace`, `/session`, ...).
 *   3. Forward to agent — every remaining `/xxx` becomes a user prompt.
 *
 * These cases cover (1) end-to-end. The local whitelist and forwarding
 * layers are covered by `forwarding.test.ts` / `bridge-core.test.ts` and
 * are unchanged by this change — the cases here exercise the new layer
 * in isolation against a hand-built `ctx.commands` mock, and confirm
 * the existing layers stay intact when `commandsCtx` is `undefined`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

function makeMockAgent(id: string) {
  const received: Array<{ content: unknown; source: unknown }> = [];
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: (m: { content: unknown; source: unknown }) => received.push(m),
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received,
  };
}

interface MockCommandsOptions {
  /** Map of `name → { description, reply }`. Unmapped names return undefined from `find`. */
  registry: Map<string, { description: string; reply: unknown }>;
  /** Throw on every execute call. */
  executeThrows?: unknown;
  /** Find throws on every call. */
  findThrows?: unknown;
}

function makeMockCommands({ registry, executeThrows, findThrows }: MockCommandsOptions) {
  return {
    find: (agent: unknown, name: string) => {
      if (findThrows) throw findThrows;
      const entry = registry.get(name);
      if (!entry) return undefined;
      return { name, description: entry.description };
    },
    execute: async (agent: unknown, line: string) => {
      if (executeThrows) throw executeThrows;
      // Convention used by the real @deepseek-ai/dsh-commands: the
      // handler returns `undefined` for unknown names, a `CommandResult`
      // otherwise. We key on the name parsed off the leading-slash
      // line so the bridge sees a faithful surface.
      const nameMatch = /^\/([a-z_][a-z0-9_-]*)/.exec(line);
      if (!nameMatch) return undefined;
      const entry = registry.get(nameMatch[1]!);
      if (!entry) return undefined;
      return entry.reply as { kind: "success" | "error"; text?: string };
    },
  };
}

function makeBridge(opts: {
  agent: { agent: unknown; received: unknown[] };
  commands?: unknown;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-nat-"));
  const agentsService = {
    create: async () => opts.agent,
    resume: async () => opts.agent,
    get: (id: string) => (id === opts.agent.agent.id ? opts.agent.agent : undefined),
    list: () => [opts.agent.agent],
  };
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "commands" && opts.commands) return opts.commands;
      return undefined;
    },
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  // Skip the monitor / login flow: we only test handleMessage.
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  (bridge as unknown as { contextTokens: Map<string, string> }).contextTokens.set(
    "u1",
    "ctx-token",
  );
  if (opts.commands) {
    bridge.attachCommands(opts.commands as never);
  }
  return bridge;
}

function wechatTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("Native command dispatch via ctx.commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the success CommandResult and does not forward to the agent", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        ["plan", { description: "Enter or leave plan mode", reply: { kind: "success", text: "Plan mode off." } }],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/plan off"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toBe("Plan mode off.");
    // The agent must NOT see the command text — native handlers stay on
    // the UI plane, never entering the model prompt.
    expect(mock.received.length).toBe(0);
  });

  it("renders the error CommandResult with a localized prefix", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        [
          "goal",
          {
            description: "set or view the goal for a long-running task",
            reply: { kind: "error", text: "No goal is currently set." },
          },
        ],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/goal 写一个"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toBe("⚠️ 命令出错：No goal is currently set.");
    expect(mock.received.length).toBe(0);
  });

  it("falls through to the local whitelist when the name is not registered", async () => {
    const mock = makeMockAgent("wx-s1");
    // `commands` is composed but `/silent` is not registered — the
    // bridge must NOT error out; the existing local silent branch runs.
    const commands = makeMockCommands({
      registry: new Map([
        ["plan", { description: "Enter or leave plan mode", reply: { kind: "success", text: "Plan mode off." } }],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/silent on"),
    );

    // Silent mode flips silently — no sendTextMessage call expected for
    // the command itself (a separate reply is only emitted when the
    // agent's first reply lands). The point: nothing crashed, nothing
    // routed to the agent.
    expect(mock.received.length).toBe(0);
    const user = (bridge as unknown as { state: { getUser(u: string): { silent: boolean } } }).state.getUser("u1");
    expect(user?.silent).toBe(true);
  });

  it("forwards an unregistered /foo bar to the agent verbatim (fallback)", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({ registry: new Map() });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/foo bar"),
    );

    // Not registered, no local whitelist match: forwarded as user text.
    expect(mock.received.length).toBe(1);
    const content = (mock.received[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0]!.text).toBe("/foo bar");
  });

  it("matches v0.4.3 behavior when commandsCtx is unavailable", async () => {
    // No commands attached — must be transparent to existing users.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock }); // commands omitted

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/plan off"),
    );

    // Without ctx.commands, /plan off falls through to forwarding
    // (same as any unrecognized /xxx). The user's prompt is sent as
    // user text — the GUI-installed plan plugin (if any) can still
    // see it via the same DSH process; they share the agent loop.
    // The bridge ALSO emits the existing "未知命令 /plan" hint so the
    // WeChat user knows their /xxx was not consumed locally — this
    // is the v0.4.3 contract and must not regress.
    expect(mock.received.length).toBe(1);
    const content = (mock.received[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0]!.text).toBe("/plan off");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, hintText] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(hintText).toContain("未知命令 /plan");
  });

  it("bypasses a pending approval card when the line is a registered native command", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        ["plan", { description: "Enter or leave plan mode", reply: { kind: "success", text: "Plan mode off." } }],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    // Seed a pending approval card for the current session.
    const anyBridge = bridge as unknown as {
      pendingApprovals: Map<string, Array<{ rpcId: string; sessionId: string; timer: NodeJS.Timeout }>>;
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });
    anyBridge.pendingApprovals.set("u1", [
      { rpcId: "rpc-1", sessionId: "wx-s1", timer: setTimeout(() => {}, 60_000) },
    ]);

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/plan off"),
    );

    // The native handler ran and replied; the card was NOT consumed as
    // an answer (it stays for someone else / next decision).
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toBe("Plan mode off.");
    expect(mock.received.length).toBe(0);
    expect(anyBridge.pendingApprovals.get("u1")?.length).toBe(1);
  });

  it("preserves the full rawInput when calling the native handler", async () => {
    const mock = makeMockAgent("wx-s1");
    const capturedLines: string[] = [];
    const commands = {
      find: (agent: unknown, name: string) =>
        name === "goal" ? { name, description: "set or view the goal for a long-running task" } : undefined,
      execute: async (agent: unknown, line: string) => {
        capturedLines.push(line);
        return { kind: "success", text: "ok" };
      },
    };
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/goal 写一个 demo 包含中文"),
    );

    expect(capturedLines).toEqual(["/goal 写一个 demo 包含中文"]);
  });

  it("catches a thrown native handler and renders a localized error reply", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        ["plan", { description: "Enter or leave plan mode", reply: { kind: "success" } }],
      ]),
      executeThrows: new Error("boom handler crashed"),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/plan off"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("⚠️ 命令执行异常");
    expect(text).toContain("boom handler crashed");
    // We must NOT fall through and forward the malformed command as a
    // user prompt — a thrown handler must not masquerade as text input.
    expect(mock.received.length).toBe(0);
  });

  it("does NOT treat /rp or /rq as native commands (card semantics preserved)", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      // Even if the registry happened to have these names registered
      // (a hypothetical third-party plugin), dsh-wechat keeps them on
      // the local card-management path.
      registry: new Map([
        ["rp", { description: "reject permissions", reply: { kind: "success", text: "rejected all" } }],
        ["rq", { description: "reject questions", reply: { kind: "success", text: "rejected all" } }],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/rp"),
    );
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/rq"),
    );

    // Native handler must NOT have been called for either; both were
    // routed through the existing local-whitelist branches. Since
    // there are no pending cards, both /rp and /rq short-circuit
    // silently on the local side (existing behavior); the important
    // invariant is that no "✅ rejected all" string leaked out.
    const allReplies = sendTextMessage.mock.calls.map((c) => c[1] as string);
    expect(allReplies.some((t) => t.includes("rejected all"))).toBe(false);
    expect(mock.received.length).toBe(0);
  });
});