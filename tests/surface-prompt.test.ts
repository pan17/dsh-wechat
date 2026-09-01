/**
 * Dynamic WeChat surface prompt — per-message-source tracking.
 *
 * The `dsh-wechat-surface` prompt section is global and its text is
 * evaluated per assembly from the bridge's per-session message-source map:
 * the section shows the WeChat prompt exactly while the session's last user
 * message came from WeChat, and hides it (empty string, filtered by
 * renderPrompt) while GUI messages drive the session — for ANY session,
 * old or new, GUI- or WeChat-created.
 *
 * These tests cover the bridge-side source tracking (markWechatMessage /
 * markSessionSource / surfaceSourceFor) and the followup message-id echo
 * matching that tells WeChat-injected messages apart from GUI-typed ones.
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
import { createUserMessage } from "../src/dsh/messages.js";

function makeMockAgent(id: string) {
  const received: Array<{ content: unknown; source: unknown; id?: string }> = [];
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: (m: { content: unknown; source: unknown; id?: string }) => received.push(m),
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received,
  };
}

function makeBridge(agent: { agent: unknown; received: unknown[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-surf-"));
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

describe("createUserMessage mints its own id", () => {
  it("mints a fresh UUID and user role", () => {
    const message = createUserMessage({
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    });
    expect(message.id).toBeTruthy();
    expect(message.role).toBe("user");
  });

  it("mints a distinct id on every call", () => {
    const a = createUserMessage({
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    });
    const b = createUserMessage({
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("message-source tracking (dynamic surface prompt)", () => {
  let bridge: WeChatDSHBridge;
  let mock: ReturnType<typeof makeMockAgent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockAgent("wx-s1");
    bridge = makeBridge(mock);
  });

  it("forwarding a WeChat message marks the session 'wechat' and records the message id", async () => {
    const anyBridge = bridge as unknown as {
      handleMessage(m: unknown): Promise<void>;
      state: { ensureUser(u: string, c: string): unknown; getUser(u: string): { sessionId: string } };
      surfaceSourceFor(s: string): string | undefined;
    };
    await anyBridge.handleMessage(wechatTextMessage("你好"));
    const sessionId = anyBridge.state.getUser("u1").sessionId;
    expect(sessionId).toBeTruthy();
    expect(anyBridge.surfaceSourceFor(sessionId)).toBe("wechat");

    // The followup carried a minted id recorded for echo matching later.
    const sent = mock.received[0] as { id?: string };
    expect(sent.id).toBeTruthy();
    const ids = (bridge as unknown as { wechatMessageIds: Map<string, number> }).wechatMessageIds;
    expect(ids.has(sent.id!)).toBe(true);
  });

  it("an agent/inbox/spliced next-turn enqueue marks the session BEFORE assembly", () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    // Session was wechat-marked before; a GUI followup enqueues a next-turn
    // message with a non-wx id → the marker flips to gui at enqueue time,
    // which is BEFORE the agent assembles its prompt (preStep).
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 2,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "00000000-0000-4000-8000-000000000000", role: "user" }],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("gui");
  });

  it("a next-turn splice with a recorded WeChat message id keeps the session 'wechat'", () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
      markWechatMessage(id: string): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });
    anyBridge.markWechatMessage("wx-recorded-abc123");
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 7,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-recorded-abc123", role: "user" }],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("wechat");
  });

  it("next-step splices (steer/inject) do not change the source marker", () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });
    (bridge as unknown as { markWechatMessage(id: string): void }).markWechatMessage("wx-recorded-xyz");
    // WeChat-marked first.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 8,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-recorded-xyz", role: "user" }],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("wechat");
    // An agent-internal next-step injection must NOT flip it.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 9,
      time: Date.now(),
      data: {
        target: "next-step",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "internal-inject", role: "user" }],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("wechat");
  });

  it("a GUI-typed user/message (id not from WeChat) marks the session 'gui'", () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });

    // WeChat first, then GUI types in the same session.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "user/message",
      seq: 3,
      time: Date.now(),
      data: {
        id: "some-gui-message-id",
        role: "user",
        content: [{ type: "text", text: "from the GUI chat box" }],
        source: { kind: "user" },
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("gui");
  });

  it("the WeChat echo (recorded message id) keeps 'wechat' — even replayed", async () => {
    const anyBridge = bridge as unknown as {
      handleMessage(m: unknown): Promise<void>;
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void; getUser(u: string): { sessionId: string } };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
    };
    await anyBridge.handleMessage(wechatTextMessage("微信消息"));
    const sessionId = anyBridge.state.getUser("u1").sessionId;
    expect(anyBridge.surfaceSourceFor(sessionId)).toBe("wechat");

    const sent = mock.received[0] as { id?: string };
    expect(sent.id).toBeTruthy();
    // The session/event echo arrives asynchronously with the same id.
    anyBridge.handleSessionEvent(sessionId, {
      type: "user/message",
      seq: 4,
      time: Date.now(),
      data: {
        id: sent.id,
        role: "user",
        content: [{ type: "text", text: "微信消息" }],
        source: { kind: "user" },
      },
    });
    // Still wechat (id was recorded at followup time).
    expect(anyBridge.surfaceSourceFor(sessionId)).toBe("wechat");
    // A replayed echo with the same id also keeps wechat. Re-record
    // because the first echo consumes the one-shot membership.
    (bridge as unknown as { markWechatMessage(id: string): void }).markWechatMessage(sent.id!);
    anyBridge.handleSessionEvent(sessionId, {
      type: "user/message",
      seq: 5,
      time: Date.now(),
      data: {
        id: sent.id, // replayed echo — same recorded id
        role: "user",
        content: [{ type: "text", text: "微信消息" }],
        source: { kind: "user" },
      },
    });
    expect(anyBridge.surfaceSourceFor(sessionId)).toBe("wechat");
    // A genuine GUI message (plain UUID id) flips it to gui.
    anyBridge.handleSessionEvent(sessionId, {
      type: "user/message",
      seq: 6,
      time: Date.now(),
      data: {
        id: "00000000-0000-4000-8000-000000000000",
        role: "user",
        content: [{ type: "text", text: "from GUI" }],
        source: { kind: "user" },
      },
    });
    expect(anyBridge.surfaceSourceFor(sessionId)).toBe("gui");
  });

  it("a user/message without an id (unknown surface) marks 'gui'", () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });
    anyBridge.handleSessionEvent("wx-s1", {
      type: "user/message",
      seq: 6,
      time: Date.now(),
      data: {
        role: "user",
        content: [{ type: "text", text: "no id" }],
        source: { kind: "user" },
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("gui");
  });

  it("sessions with no user message yet have no marker (prompt hidden)", () => {
    const anyBridge = bridge as unknown as { surfaceSourceFor(s: string): string | undefined };
    expect(anyBridge.surfaceSourceFor("never-touched")).toBeUndefined();
  });

  it("a pure-deletion next-turn splice (the agent-loop's claim) does NOT overwrite the marker", () => {
    // Regression: the agent-loop emits TWO `agent/inbox/spliced` events per
    // followup. The first (enqueue, inserted=[wx-msg-...]) correctly sets
    // the marker to "wechat". The second (inbox.claim pulling the message
    // out of next-turn for processing, inserted=[]) used to overwrite it
    // with "gui" because the handler treated an empty `inserted` array the
    // same as "no wx-msg- prefix → gui". Prompt assembly then read "gui"
    // and hid the WeChat surface prompt for every turn.
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      handleSessionEvent(s: string, e: unknown): void;
      surfaceSourceFor(s: string): string | undefined;
      markWechatMessage(id: string): void;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "wx-s1" });
    anyBridge.markWechatMessage("wx-recorded-claim-test");

    // Enqueue — what `forwardToAgent` + the inbox.append splice look like.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 1,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "wx-recorded-claim-test", role: "user" }],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("wechat");

    // Claim — what the agent-loop's inbox.claim emits: same target, but
    // removedCount=1 with inserted=[] (pure deletion). Must NOT flip the
    // marker; this is the regression case.
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 2,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 1,
        inserted: [],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("wechat");

    // A subsequent GUI-typed splice still flips it, proving the marker is
    // still mutable through this channel — the fix is "skip pure
    // deletions", not "freeze the marker on next-turn".
    anyBridge.handleSessionEvent("wx-s1", {
      type: "agent/inbox/spliced",
      seq: 3,
      time: Date.now(),
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 0,
        inserted: [{ id: "18454289-7187-4009-8000-000000000000", role: "user" }],
      },
    });
    expect(anyBridge.surfaceSourceFor("wx-s1")).toBe("gui");
  });
});
