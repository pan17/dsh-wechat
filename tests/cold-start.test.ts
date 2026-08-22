/**
 * Cold-start delivery tests: after a DSH restart the in-memory
 * context-token map is empty until the user's first WeChat message. These
 * tests pin the behaviors that close the "GUI-typed replies vanish until I
 * ping WeChat once" gap:
 *
 *   1. handleMessage persists the freshest context token into durable
 *      state (and keeps the in-memory map in sync).
 *   2. restoreContextTokens() reseeds the map from persisted state, so an
 *      assistant/message right after restart delivers with the restored
 *      token instead of being dropped.
 *   3. With NO token available at all, sendReply parks the formatted reply
 *      in the outbound cache (auto-flushed by the next inbound message)
 *      instead of silently dropping it.
 *   4. parkOutbound enforces MAX_OUTBOUND_CACHE, dropping the OLDEST items.
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
import type { UserState } from "../src/state.js";
import { MessageType } from "../src/weixin/types.js";

/** A mock live agent that records followup messages. */
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

interface BridgeOpts {
  /** Seed the in-memory context-token map like forwarding.test.ts does. */
  seedContextToken?: boolean;
  /** Reuse this storage dir (simulates the same deployment after restart). */
  storageDir?: string;
}

function makeBridge(agent: { agent: unknown; received: unknown[] }, opts: BridgeOpts = {}) {
  const dir = opts.storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-cold-"));
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
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "u", savedAt: "" };
  if (opts.seedContextToken) {
    (bridge as unknown as { contextTokens: Map<string, string> }).contextTokens.set("u1", "ctx-token");
  }
  return { bridge, storageDir: dir };
}

function wechatTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function assistantEvent(text: string) {
  return {
    type: "assistant/message",
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text }] } },
  };
}

/** Bind user u1 to session wx-s1 through the same store calls the bridge uses. */
function bindUser(store: { ensureUser(u: string, c: string): UserState }, sessionId: string): void {
  store.ensureUser("u1", "C:\\work");
  (store as unknown as { update(u: string, p: unknown): void }).update("u1", { sessionId });
}

describe("cold start: context-token persistence and restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handleMessage persists the freshest context token into durable state", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock);
    const anyBridge = bridge as unknown as {
      handleMessage(m: unknown): Promise<void>;
      state: { ensureUser(u: string, c: string): UserState; getUser(u: string): UserState | undefined };
      contextTokens: Map<string, string>;
    };

    await anyBridge.handleMessage(wechatTextMessage("重启后第一条"));

    expect(anyBridge.contextTokens.get("u1")).toBe("ctx-token");
    expect(anyBridge.state.getUser("u1")?.lastContextToken).toBe("ctx-token");
  });

  it("restoreContextTokens reseeds the map so a post-restart GUI reply is delivered", async () => {
    // Bridge #1 records the binding + last known token into state.json.
    const mock1 = makeMockAgent("wx-s1");
    const first = makeBridge(mock1);
    bindUser(
      (first.bridge as unknown as { state: { ensureUser(u: string, c: string): UserState } }).state,
      "wx-s1",
    );
    // Simulate a prior inbound WeChat message persisting its token.
    const pre = first.bridge as unknown as {
      state: { getUser(u: string): UserState | undefined };
      handleMessage(m: unknown): Promise<void>;
    };
    await pre.handleMessage(wechatTextMessage("重启前的消息"));
    expect(pre.state.getUser("u1")?.lastContextToken).toBe("ctx-token");

    // Bridge #2 = the same deployment after a DSH restart: fresh instance
    // over the SAME storageDir, EMPTY in-memory context map.
    const mock2 = makeMockAgent("wx-s1");
    const second = makeBridge(mock2, { seedContextToken: false, storageDir: first.storageDir });
    const b2 = second.bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; getUser(u: string): UserState | undefined };
      restoreContextTokens(): void;
      handleSessionEvent(s: string, e: unknown): void;
      contextTokens: Map<string, string>;
    };

    b2.restoreContextTokens();
    expect(b2.contextTokens.get("u1")).toBe("ctx-token");

    // The GUI typed into the bound session after the restart; no new WeChat
    // message has arrived yet. The reply must still go out — with the
    // restored token.
    b2.handleSessionEvent("wx-s1", assistantEvent("重启后的回复"));

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text, callOpts] = sendTextMessage.mock.calls[0]! as [string, string, { contextToken: string }];
    expect(text).toContain("重启后的回复");
    expect(callOpts.contextToken).toBe("ctx-token");
  });
});

describe("cold start: no token at all → park instead of drop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assistant/message parks the formatted reply for the next flush", async () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, { seedContextToken: false });
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): UserState; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      outboundCache: Map<string, Array<{ kind: string; text?: string }>>;
      handleMessage(m: unknown): Promise<void>;
    };
    bindUser(anyBridge.state, "wx-s1");

    // No login token / context token: before the fix this path DROPPED the
    // reply silently.
    anyBridge.handleSessionEvent("wx-s1", assistantEvent("离线期间生成的回复"));
    expect(sendTextMessage).not.toHaveBeenCalled();
    const parked = anyBridge.outboundCache.get("u1");
    expect(parked).toBeTruthy();
    expect(parked).toHaveLength(1);
    expect(parked![0]!.text).toContain("离线期间生成的回复");

    // The user's next WeChat message auto-flushes the parked reply with a
    // fresh context token.
    await anyBridge.handleMessage(wechatTextMessage("我回来了"));
    const flushedCall = sendTextMessage.mock.calls.find((c) =>
      (c[1] as string).includes("离线期间生成的回复"),
    )!;
    expect(flushedCall).toBeTruthy();
    expect(flushedCall[0]).toBe("u1");
    expect((flushedCall[2] as { contextToken: string }).contextToken).toBe("ctx-token");
  });
});

describe("outbound cache cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parkOutbound drops the OLDEST items beyond the cap", () => {
    const mock = makeMockAgent("wx-s1");
    const { bridge } = makeBridge(mock, { seedContextToken: false });
    const anyBridge = bridge as unknown as {
      parkOutbound(userId: string, item: { kind: "text"; text: string }): void;
      outboundCache: Map<string, Array<{ kind: string; text?: string }>>;
    };
    for (let i = 0; i < 105; i++) {
      anyBridge.parkOutbound("u1", { kind: "text", text: `msg-${i}` });
    }
    const cache = anyBridge.outboundCache.get("u1")!;
    expect(cache).toHaveLength(100); // MAX_OUTBOUND_CACHE
    // Oldest five dropped; newest retained in order.
    expect(cache[0]!.text).toBe("msg-5");
    expect(cache[cache.length - 1]!.text).toBe("msg-104");
  });
});
