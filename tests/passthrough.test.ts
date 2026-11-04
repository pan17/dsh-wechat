/**
 * 强制透传 (`/raw`) — the gateway stops intercepting.
 *
 * The request: "输入强制透传的斜杠指令后面跟着的斜杠指令和文本强制透传，网关完全不拦截".
 * So once armed, nothing in `handleMessage` may act on the line — no native
 * dispatch, no local parser, no usage reply, no unknown-command hint, no card
 * answer — and the raw text arrives at the agent exactly as typed.
 *
 * The three design decisions this suite pins:
 *
 *   1. `/raw` ITSELF stays a command while passthrough is on. A switch that
 *      cannot be switched off from the chat is a trap;
 *   2. the mode is never persisted. A restart must come back with the
 *      interceptors on, because an operator restarting the plugin cannot tell
 *      that the bot has gone deaf to commands;
 *   3. `/raw once` spends itself on exactly one message, so the common "paste
 *      this one /whatever" case cannot leave a mode behind.
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
import { isBypassSlashCommand, parseRawCommand } from "../src/bridge/slash.js";

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

function makeBridge(agent: ReturnType<typeof makeMockAgent>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-raw-"));
  const agentsService = {
    create: async () => agent,
    resume: async () => agent,
    get: (id: string) => (id === agent.agent.id ? agent.agent : undefined),
    list: () => [agent.agent],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.mergeSilenceMs = 0;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
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

async function send(bridge: WeChatDSHBridge, text: string) {
  await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
    wechatTextMessage(text),
  );
}

function replies(): string[] {
  return sendTextMessage.mock.calls.map((call) => (call as [string, string])[1]);
}

function lastReply(): string {
  const all = replies();
  return all.length === 0 ? "" : all[all.length - 1]!;
}

/** The text blocks the agent received for the most recent turn. */
function forwardedText(mock: ReturnType<typeof makeMockAgent>, index = -1): string {
  const message = mock.received.at(index) as { content: Array<{ type: string; text?: string }> };
  return (message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

// ─── Parser ────────────────────────────────────────────────────────────────

describe("parseRawCommand", () => {
  it("accepts the documented forms", () => {
    expect(parseRawCommand("/raw")).toEqual({ kind: "raw", mode: "status" });
    expect(parseRawCommand("/raw status")).toEqual({ kind: "raw", mode: "status" });
    expect(parseRawCommand("/raw on")).toEqual({ kind: "raw", mode: "on" });
    expect(parseRawCommand("/raw off")).toEqual({ kind: "raw", mode: "off" });
    expect(parseRawCommand("/raw once")).toEqual({ kind: "raw", mode: "once" });
    // Casing and surrounding whitespace are forgiven, like every other parser.
    expect(parseRawCommand("  /RAW  ON  ")).toEqual({ kind: "raw", mode: "on" });
  });

  it("rejects anything else", () => {
    expect(parseRawCommand("/rawx")).toBeNull();
    expect(parseRawCommand("/raw onnow")).toBeNull();
    expect(parseRawCommand("/raw on extra")).toBeNull();
    expect(parseRawCommand("raw on")).toBeNull();
  });

  it("bypasses a pending card, being the escape hatch", () => {
    expect(isBypassSlashCommand("/raw on")).toBe(true);
    expect(isBypassSlashCommand("/raw off")).toBe(true);
    expect(isBypassSlashCommand("/raw")).toBe(true);
  });
});

// ─── The gate ──────────────────────────────────────────────────────────────

describe("强制透传: /raw on stops every interception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Each line is something the gateway WOULD have answered or rerouted.
  const intercepted = [
    "/status",            // local parser
    "/help",              // help branch
    "/s lsit",            // mistyped → usage reply
    "/workspacelist",     // glued → "少了空格吗"
    "/stauts",            // typo-corrected name
    "/nope",              // unknown-command hint
    "/stop",              // stop handler
    "/steps 极简",        // mode switch
    "/model switch x/y",  // management command
    "/at nope",           // /at usage reply
  ];

  for (const line of intercepted) {
    it(`forwards ${line} verbatim instead of handling it`, async () => {
      const mock = makeMockAgent("wx-s1");
      const bridge = makeBridge(mock);
      await send(bridge, "/raw on");
      vi.clearAllMocks();

      await send(bridge, line);

      // One message reached the agent, carrying the line unchanged.
      expect(mock.received).toHaveLength(1);
      expect(forwardedText(mock)).toContain(line);
      // And the gateway said NOTHING — no usage line, no hint, no report.
      expect(replies()).toHaveLength(0);
    });
  }

  it("forwards ordinary prose unchanged too", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    await send(bridge, "/raw on");
    vi.clearAllMocks();

    await send(bridge, "帮我看看 /etc/hosts 这个文件");
    expect(mock.received).toHaveLength(1);
    expect(forwardedText(mock)).toContain("/etc/hosts");
    expect(replies()).toHaveLength(0);
  });

  it("keeps /raw itself working — the way out", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    await send(bridge, "/raw on");
    vi.clearAllMocks();

    // A status query still answers while the switch is on.
    await send(bridge, "/raw");
    expect(lastReply()).toContain("强制透传: on");
    expect(mock.received).toHaveLength(0);

    // And off restores the command layer.
    await send(bridge, "/raw off");
    expect(replies().at(-1)).toContain("已关闭");
    vi.clearAllMocks();
    await send(bridge, "/status");
    expect(mock.received).toHaveLength(0);
    expect(lastReply()).toContain("状态");
    expect(replies().at(-1)).not.toContain("用法");
  });

  it("goes past a pending approval card without answering it", async () => {
    // "完全不拦截" has to include the card path, or a pending question could
    // still claim the passthrough message as its answer.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    const inner = bridge as unknown as {
      pendingApprovals: Map<string, Array<{ rpcId: string; sessionId: string; timer: NodeJS.Timeout }>>;
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
    };
    inner.state.ensureUser("u1", "C:\\work");
    inner.state.update("u1", { sessionId: "wx-s1" });
    inner.pendingApprovals.set("u1", [
      { rpcId: "rpc-1", sessionId: "wx-s1", timer: setTimeout(() => {}, 30_000) },
    ]);
    try {
      await send(bridge, "/raw on");
      vi.clearAllMocks();
      await send(bridge, "/status");

      // Forwarded, NOT treated as a card answer.
      expect(mock.received).toHaveLength(1);
      expect(inner.pendingApprovals.get("u1") ?? []).toHaveLength(1);
    } finally {
      for (const card of inner.pendingApprovals.get("u1") ?? []) clearTimeout(card.timer);
    }
  });
});

// ─── One-shot ──────────────────────────────────────────────────────────────

describe("/raw once spends itself on exactly one message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the next message through, then intercepts again", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    await send(bridge, "/raw once");
    expect(lastReply()).toContain("下一条消息");
    vi.clearAllMocks();

    // The armed message bypasses a parser that would otherwise answer it.
    // `mock.received` is a plain array (not a vi mock), so it is compared by
    // DELTA across the whole test rather than reset in between.
    await send(bridge, "/status");
    expect(mock.received).toHaveLength(1);
    expect(replies()).toHaveLength(0);

    // The message AFTER it is a command again: still exactly one forward.
    vi.clearAllMocks();
    await send(bridge, "/status");
    expect(mock.received).toHaveLength(1);
    expect(replies()).toHaveLength(1);
  });

  it("does not leave the sticky switch on", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    await send(bridge, "/raw once");
    await send(bridge, "/status");
    const config = (bridge as unknown as { config: { passthrough: boolean } }).config;
    expect(config.passthrough).toBe(false);
  });

  it("is cancelled by /raw on and by /raw off", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);

    await send(bridge, "/raw once");
    await send(bridge, "/raw off");
    vi.clearAllMocks();
    // The one-shot was cancelled: a command is intercepted again. The counter
    // is compared by DELTA — `mock.received` is a plain array.
    await send(bridge, "/status");
    expect(mock.received).toHaveLength(0);
    expect(replies()).toHaveLength(1);

    await send(bridge, "/raw once");
    await send(bridge, "/raw on");
    vi.clearAllMocks();
    // Now the sticky switch governs, so everything passes through.
    await send(bridge, "/status");
    expect(mock.received).toHaveLength(1);
    expect(replies()).toHaveLength(0);
  });
});

// ─── Persistence ───────────────────────────────────────────────────────────

describe("passthrough never survives a restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is not part of the editable config surface", async () => {
    // `EDITABLE_KEYS` is what the settings page can write and what a restart
    // re-reads. Passthrough absent from it means a fresh bridge always starts
    // with interceptors on.
    const { EDITABLE_KEYS } = await import("../src/config-store.js");
    expect(EDITABLE_KEYS).not.toContain("passthrough");
  });

  it("starts off in a fresh config", () => {
    expect(defaultConfig().passthrough).toBe(false);
  });
});
