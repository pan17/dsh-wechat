/**
 * `/history` 的来源（provenance）：轮次里的提问只能是**真人**说的那句话。
 *
 * 宿主把合成消息也塞进 user 角色：压缩检查点、插件上下文、goal 续跑、
 * 会话召回（`source.kind` = `plugin` / `goal` / `session-reference` /
 * `agent-message`）。GUI 侧边栏只列 `kind === "user"`，`turnOutline` 的折叠规则
 * 也是如此——`/history` 与 `/fork` 共用这套折叠，所以「系统消息」在微信里没有
 * 任何展示入口，也不会被误当成你说过的话。
 *
 * 另外钉住数据来源：冷会话必须读**完整原始日志**（`sessionQuery.readSession`），
 * 不能读 `readSurface`——后者是压缩后的模型视图，重启一次就会丢掉已被压缩的
 * 真人提问。
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
import { MessageType } from "../src/weixin/types.js";

interface EventLike {
  type: string;
  time?: number;
  data?: unknown;
  seq?: number;
}

/** Host shape: `user/message` data is the message itself (role/source/content). */
function humanEvent(seq: number, text: string): EventLike {
  return {
    type: "user/message",
    seq,
    time: seq * 1000,
    data: { id: `user-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

/** Compaction checkpoints / context injections are user-role too. */
function injectedEvent(seq: number, text: string, kind = "plugin"): EventLike {
  return {
    type: "user/message",
    seq,
    time: seq * 1000,
    data: {
      id: `checkpoint-${seq}`,
      role: "user",
      source: kind === "plugin" ? { kind, plugin: "compact" } : { kind, goalId: "g1", revision: 1, round: 0 },
      content: [{ type: "text", text }],
    },
  };
}

function assistantEvent(seq: number, text: string): EventLike {
  return {
    type: "assistant/message",
    seq,
    time: seq * 1000,
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  };
}

const turnStart = (seq: number, turn: number): EventLike => ({
  type: "turn/start",
  seq,
  time: seq * 1000,
  data: { turn },
});
const turnEnd = (seq: number, turn: number): EventLike => ({
  type: "turn/end",
  seq,
  time: seq * 1000,
  data: { turn },
});

/** One completed turn whose log also carries the given injected messages. */
function turnWithInjection(injected: EventLike[]): EventLike[] {
  return [
    turnStart(0, 1),
    ...injected,
    humanEvent(10, "真正的提问"),
    assistantEvent(11, "回答"),
    turnEnd(12, 1),
  ];
}

function textMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const lastReply = () => String(sendTextMessage.mock.calls.at(-1)?.[1] ?? "");

function boundBridge(ctx: { get(name: string): unknown; on(): () => void }): WeChatDSHBridge {
  const cfg = defaultConfig();
  cfg.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-hist-prov-"));
  const bridge = new WeChatDSHBridge(ctx as never, cfg);
  (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t" };
  const state = (bridge as unknown as {
    state: { ensureUser(u: string, cwd: string): unknown; update(u: string, p: unknown): void };
  }).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "wx-1", cwd: "C:\\work" });
  return bridge;
}

function makeLiveBridge(events: EventLike[]): WeChatDSHBridge {
  const agent = { session: { snapshotEvents: () => events } };
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

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

describe("/history provenance", () => {
  it("a compaction checkpoint never becomes the turn's prompt", async () => {
    const bridge = makeLiveBridge(turnWithInjection([injectedEvent(5, "【压缩检查点】被替换掉的历史正文")]));
    await asInbound(bridge).handleMessage(textMessage("/history"));
    const text = lastReply();
    expect(text).toContain("真正的提问");
    expect(text).not.toContain("压缩检查点");
    // There is no "system message" view left to ask for.
    expect(text).not.toContain("⚙️ 系统");
  });

  it("a goal-round prompt never becomes the turn's prompt", async () => {
    const bridge = makeLiveBridge(turnWithInjection([injectedEvent(5, "目标续跑提示词", "goal")]));
    await asInbound(bridge).handleMessage(textMessage("/history"));
    expect(lastReply()).toContain("真正的提问");
    expect(lastReply()).not.toContain("目标续跑提示词");
  });

  it("legacy payloads without a source still count as human", async () => {
    // No `source` at all: nothing may be hidden just because the host version
    // that wrote this log predates the field.
    const bridge = makeLiveBridge([
      turnStart(0, 1),
      { type: "user/message", seq: 1, time: 1000, data: { id: "m-1", role: "user", content: [{ type: "text", text: "legacy user" }] } },
      assistantEvent(2, "legacy reply"),
      turnEnd(3, 1),
    ]);
    await asInbound(bridge).handleMessage(textMessage("/history"));
    expect(lastReply()).toContain("legacy user");
  });

  it("cold history prefers readSession over the compacted surface", async () => {
    const readSurface = vi.fn(async () => ({
      events: [turnStart(0, 1), humanEvent(1, "surface user"), assistantEvent(2, "surface reply"), turnEnd(3, 1)],
    }));
    const readSession = vi.fn(async () => ({
      events: [turnStart(0, 1), humanEvent(1, "raw-log user"), assistantEvent(2, "raw-log reply"), turnEnd(3, 1)],
    }));
    const bridge = makeColdBridge({
      listSessions: async () => [],
      readTitle: async () => undefined,
      listEvents: async () => [],
      readSurface,
      readSession,
    });
    await asInbound(bridge).handleMessage(textMessage("/history"));
    const text = lastReply();
    expect(text).toContain("raw-log user");
    expect(text).toContain("raw-log reply");
    expect(text).not.toContain("surface");
    expect(readSession).toHaveBeenCalled();
    expect(readSurface).not.toHaveBeenCalled();
  });
});
