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
  /** Static list snapshot returned by `list`. Defaults to descriptors derived from `registry`. */
  listSnapshot?: Array<{ name: string; description?: string; input?: { hint?: string } }>;
}

function makeMockCommands({ registry, executeThrows, findThrows, listSnapshot }: MockCommandsOptions) {
  return {
    find: (agent: unknown, name: string) => {
      if (findThrows) throw findThrows;
      const entry = registry.get(name);
      if (!entry) return undefined;
      return { name, description: entry.description };
    },
    // The real `execute` returns `CommandExecution` = `{ commandId, result }`,
    // where `result` is the `CommandResult` = `{ kind: 'success', text? } |
    // { kind: 'error', text }` that the handler returned. We key on the
    // name parsed off the leading-slash line so the bridge sees a
    // faithful surface.
    execute: async (agent: unknown, line: string) => {
      if (executeThrows) throw executeThrows;
      const nameMatch = /^\/([a-z_][a-z0-9_-]*)/.exec(line);
      if (!nameMatch) return undefined;
      const entry = registry.get(nameMatch[1]!);
      if (!entry) return undefined;
      return { commandId: `cmd-${nameMatch[1]}`, result: entry.reply };
    },
    list: (agent: unknown) => {
      if (listSnapshot) return listSnapshot;
      return Array.from(registry.entries()).map(([name, e]) => ({
        name,
        description: e.description,
      }));
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
      // Real `execute` returns `CommandExecution` = `{ commandId, result }`.
      execute: async (agent: unknown, line: string) => {
        capturedLines.push(line);
        return { commandId: "cmd-goal", result: { kind: "success" as const, text: "ok" } };
      },
      list: () => [],
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

  it("renders a success result with no text via the ✅ <name> fallback", async () => {
    // Per the host contract, success.text is optional (commands may
    // reply through `sourceEventSeq` instead). The bridge falls back
    // to a localized acknowledgement so the WeChat user always sees
    // something — never a silent success.
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        ["plan", { description: "Enter or leave plan mode", reply: { kind: "success" } }],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/plan"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toBe("✅ plan");
    expect(mock.received.length).toBe(0);
  });

  it("renders the error text from the registry (no fallback; error.text is required)", async () => {
    // This case is the one the user observed before the fix:
    // the legacy code read `result.kind` on the raw CommandExecution
    // wrapper, fell into the error branch with no text, and printed
    // `⚠️ 命令出错：<description>`. After the fix the bridge unwraps
    // `execution.result` and surfaces the handler's actual error
    // verbatim — the description never leaks through.
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        [
          "plan",
          {
            description: "Enter or leave plan mode",
            reply: { kind: "error", text: "Plan mode entry cancelled." },
          },
        ],
      ]),
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/plan"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toBe("⚠️ 命令出错：Plan mode entry cancelled.");
    // Make sure the description did NOT leak into the reply.
    expect(text).not.toContain("Enter or leave plan mode");
  });
});

describe("/help discovery of native commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends a 'DSH 原生命令' section listing everything the host registered", async () => {
    const mock = makeMockAgent("wx-s1");
    const commands = makeMockCommands({
      registry: new Map([
        ["plan", { description: "Enter or leave plan mode", reply: { kind: "success", text: "" } }],
        ["goal", { description: "set or view the goal for a long-running task", reply: { kind: "success", text: "" } }],
      ]),
      listSnapshot: [
        { name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]" } },
        { name: "goal", description: "set or view the goal for a long-running task", input: { hint: "[<objective>|clear|edit|pause|resume]" } },
      ],
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/help"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("── DSH 原生命令（当前 profile 已注册）──");
    expect(text).toContain("/plan  [off|message] — Enter or leave plan mode");
    expect(text).toContain("/goal  [<objective>|clear|edit|pause|resume] — set or view the goal for a long-running task");
    // Local entries stay authoritative — no native duplicates for /status etc.
    expect(text).toContain("/status — 当前会话");
  });

  it("de-duplicates names that already exist in the local whitelist", async () => {
    const mock = makeMockAgent("wx-s1");
    // Suppose a future bundle re-registered /compact (the current
    // `dsh-command-compact` does, in fact — `name: 'compact'`). The
    // local row carries the full subcommand grammar; the native row
    // must NOT also appear, or users would see two entries for one
    // command.
    const commands = makeMockCommands({
      registry: new Map([
        ["compact", { description: "Manual compact", reply: { kind: "success", text: "" } }],
      ]),
      listSnapshot: [
        { name: "compact", description: "Manual compact", input: { hint: "" } },
      ],
    });
    const bridge = makeBridge({ agent: mock, commands });

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/help"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    // The local /compact row exists once.
    const compactLocalMatches = text.match(/• \/compact/g);
    expect(compactLocalMatches?.length).toBe(1);
    // The "DSH 原生命令" section appears (we have at least one
    // command listed) but compact is filtered out of it.
    const nativeSection = text.split("── DSH 原生命令")[1] ?? "";
    expect(nativeSection).not.toMatch(/\/compact/);
  });

  it("falls back to the local help text when commandsCtx is unavailable", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock }); // no commands

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/help"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    // The native section is suppressed when the registry isn't composed.
    expect(text).not.toContain("DSH 原生命令（当前 profile 已注册）");
    expect(text).toContain("/status");
  });
});