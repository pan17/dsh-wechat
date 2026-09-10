/**
 * `/history` provenance filtering:
 *   - Only genuine human turns are listed. The host stamps synthesized
 *     user-role messages with `source.kind` (`plugin` for context injections
 *     and compaction checkpoints, `goal` for goal rounds, `session-reference`
 *     for recalls), and the GUI sidebar lists only `kind === "user"`.
 *   - The persisted fallback prefers `sessionQuery.readSurface()` (current
 *     model surface) and only then `readSession()` (complete raw log).
 *   - Legacy payloads without a `source` stay visible, so nothing real is
 *     hidden by the filter.
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

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: () => Promise.resolve(undefined),
  getConfig: () => Promise.resolve({ typing_ticket: "tk" }),
  isSessionTimeoutError: () => false,
  isMessageLimitError: () => false,
  isInvalidRequestError: () => false,
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";

interface EventLike {
  type: string;
  time?: number;
  data?: unknown;
}

/** Host shape: `user/message` data is the message itself (role/source/content). */
function humanEvent(text: string, time = 1): EventLike {
  return {
    type: "user/message",
    time,
    data: { id: `user-${time}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

/** Host shape: compaction checkpoints / context injections are user-role too. */
function injectedEvent(text: string, kind = "plugin", time = 2): EventLike {
  return {
    type: "user/message",
    time,
    data: {
      id: `checkpoint-${time}`,
      role: "user",
      source: kind === "plugin" ? { kind, plugin: "compact" } : { kind, goalId: "g1", revision: 1, round: 0 },
      content: [{ type: "text", text }],
    },
  };
}

function assistantEvent(text: string, time = 3): EventLike {
  return {
    type: "assistant/message",
    time,
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text }] } },
  };
}

function boundBridge(ctx: { get(name: string): unknown; on(): () => void }): WeChatDSHBridge {
  const cfg = defaultConfig();
  cfg.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-hist-prov-"));
  const bridge = new WeChatDSHBridge(ctx as never, cfg);
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://x", token: "t" };
  const state = (bridge as unknown as {
    state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
  }).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "wx-1" });
  return bridge;
}

function makeLiveBridge(events: EventLike[]): WeChatDSHBridge {
  const agent = { session: { events } };
  const agentsService = {
    create: async () => undefined,
    resume: async () => undefined,
    get: (id: string) => (id === "wx-1" ? (agent as never) : undefined),
    list: () => [agent as never],
  };
  return boundBridge({ get: (name: string) => (name === "agents" ? agentsService : undefined), on: () => () => {} });
}

function makeColdBridge(query: Record<string, unknown>): WeChatDSHBridge {
  return boundBridge({ get: (name: string) => (name === "sessionQuery" ? query : undefined), on: () => () => {} });
}

async function runHistory(bridge: WeChatDSHBridge): Promise<string> {
  sendTextMessage.mockClear();
  await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage({
    message_type: 1,
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [{ type: 1, text_item: { text: "/history" } }],
  });
  return sendTextMessage.mock.calls.map((c) => String(c[1])).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

describe("/history provenance", () => {
  it("live history hides injected user-role messages but keeps human turns", async () => {
    const bridge = makeLiveBridge([
      humanEvent("人类提问", 1),
      injectedEvent("【压缩检查点】被替换掉的历史正文", "plugin", 2),
      assistantEvent("助手回复", 3),
    ]);

    const text = await runHistory(bridge);

    expect(text).toContain("人类提问");
    expect(text).toContain("助手回复");
    expect(text).not.toContain("压缩检查点");
  });

  it("live history hides goal-round user messages too", async () => {
    const bridge = makeLiveBridge([
      humanEvent("人类提问", 1),
      injectedEvent("目标续跑提示词", "goal", 2),
    ]);

    const text = await runHistory(bridge);

    expect(text).toContain("人类提问");
    expect(text).not.toContain("目标续跑提示词");
  });

  it("legacy payloads without a source stay visible", async () => {
    const bridge = makeLiveBridge([
      { type: "user/message", time: 1, data: { message: { content: [{ type: "text", text: "legacy user" }] } } },
    ]);

    const text = await runHistory(bridge);

    expect(text).toContain("legacy user");
  });

  it("cold history prefers readSurface and applies the same provenance filter", async () => {
    const readSession = vi.fn(async () => ({
      events: [humanEvent("raw-log user", 1), assistantEvent("raw-log assistant", 2)],
    }));
    const bridge = makeColdBridge({
      listSessions: async () => [],
      readTitle: async () => undefined,
      listEvents: async () => [],
      readSurface: async () => ({
        events: [
          humanEvent("surface user", 1),
          injectedEvent("【压缩检查点】surface 注入", "plugin", 2),
          assistantEvent("surface assistant", 3),
        ],
      }),
      readSession,
    });

    const text = await runHistory(bridge);

    expect(text).toContain("surface user");
    expect(text).toContain("surface assistant");
    expect(text).not.toContain("压缩检查点");
    expect(readSession).not.toHaveBeenCalled();
  });

  it("cold history falls back to readSession when no surface is exposed", async () => {
    const bridge = makeColdBridge({
      listSessions: async () => [],
      readTitle: async () => undefined,
      listEvents: async () => [],
      readSession: async () => ({ events: [humanEvent("cold user", 1), assistantEvent("cold assistant", 2)] }),
    });

    const text = await runHistory(bridge);

    expect(text).toContain("cold user");
    expect(text).toContain("cold assistant");
  });
});
