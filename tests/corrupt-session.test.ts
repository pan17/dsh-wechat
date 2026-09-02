/**
 * Corrupt-session recovery:
 * - AgentStore.ensure unbinds and mints when resume fails and
 *   replaceOnResumeFailure is on.
 * - Ordinary WeChat text replaces the binding and tells the user.
 * - `/s new` does not call agents.resume (local whitelist skips native ensure).
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
import { AgentStore } from "../src/dsh/sessions.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import type { UserState } from "../src/state.js";

const CORRUPT_ID = "session-6bc101a5-501f-4b6c-bdb2-77bc083d30eb";

function makeUser(sessionId: string): UserState {
  return {
    userId: "u1",
    sessionId,
    cwd: "C:\\work",
    silent: false,
    crossSessionNotify: "inherit",
    watchedSessions: sessionId ? [sessionId] : [],
  };
}

function wechatTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

describe("AgentStore.ensure replaceOnResumeFailure", () => {
  it("returns undefined and keeps the binding when replacement is off", async () => {
    const resume = vi.fn(async () => {
      throw new Error("SessionPersistenceCorruptionError: stored session failed validation");
    });
    const create = vi.fn();
    const store = new AgentStore({
      get: (name: string) =>
        name === "agents"
          ? { create, resume, get: () => undefined, list: () => [] }
          : undefined,
      on: () => () => {},
    });
    const user = makeUser(CORRUPT_ID);
    const result = await store.ensure(user);
    expect(result.agent).toBeUndefined();
    expect(result.replacedSessionId).toBeUndefined();
    expect(user.sessionId).toBe(CORRUPT_ID);
    expect(create).not.toHaveBeenCalled();
  });

  it("unbinds and mints a replacement session when resume fails", async () => {
    const resume = vi.fn(async () => {
      throw new Error("SessionPersistenceCorruptionError: stored session failed validation");
    });
    const create = vi.fn(async (opts: { sessionId: string }) => ({
      agent: { id: opts.sessionId, status: "idle", followup: () => {}, steer: () => {}, cancel: () => {}, whenIdle: async () => {}, options: {} },
    }));
    const store = new AgentStore({
      get: (name: string) =>
        name === "agents"
          ? { create, resume, get: () => undefined, list: () => [] }
          : undefined,
      on: () => () => {},
    });
    const user = makeUser(CORRUPT_ID);
    const result = await store.ensure(user, { replaceOnResumeFailure: true });
    expect(result.agent).toBeDefined();
    expect(result.replacedSessionId).toBe(CORRUPT_ID);
    expect(user.sessionId).toMatch(/^session-/);
    expect(user.sessionId).not.toBe(CORRUPT_ID);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("forwarding replaces a corrupt bound session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints a new session, persists the binding, and tells the user", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-corr-"));
    const created: string[] = [];
    const received: unknown[] = [];
    const agentsService = {
      create: async (opts: { sessionId: string }) => {
        created.push(opts.sessionId);
        return {
          agent: {
            id: opts.sessionId,
            status: "idle",
            options: { provider: "deepseek", model: "deepseek-chat" },
            followup: (m: unknown) => received.push(m),
            steer: () => {},
            cancel: () => {},
            whenIdle: async () => {},
          },
        };
      },
      resume: async () => {
        throw new Error(
          `SessionPersistenceCorruptionError: stored session "${CORRUPT_ID}" failed validation: Error: invalid seed event at index 460: session event "assistant/message" sourceEventSeqs must densely contain non-negative safe integers`,
        );
      },
      get: () => undefined,
      list: () => [],
    };
    const ctx = {
      get: (name: string) => (name === "agents" ? agentsService : undefined),
      on: () => () => {},
    };
    const cfg = defaultConfig();
    cfg.storageDir = dir;
    const bridge = new WeChatDSHBridge(ctx, cfg);
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    };
    const anyBridge = bridge as unknown as {
      state: {
        ensureUser(u: string, c: string): { sessionId: string };
        update(u: string, p: unknown): void;
        getUser(u: string): { sessionId: string } | undefined;
      };
      handleMessage(m: unknown): Promise<void>;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: CORRUPT_ID });

    await anyBridge.handleMessage(wechatTextMessage("你好啊"));

    const user = anyBridge.state.getUser("u1")!;
    expect(user.sessionId).not.toBe(CORRUPT_ID);
    expect(user.sessionId).toMatch(/^session-/);
    expect(created).toEqual([user.sessionId]);
    expect(received.length).toBe(1);

    const replies = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(replies.some((t) => t.includes(`原会话 ${CORRUPT_ID} 已损坏`))).toBe(true);
    expect(replies.some((t) => t.includes(`已新建会话 ${user.sessionId}`))).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8")) as {
      users: Record<string, { sessionId: string }>;
    };
    expect(persisted.users.u1.sessionId).toBe(user.sessionId);
  });
});

describe("/s new does not resume the bound session via native dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips agents.resume when handling /s new with a corrupt binding", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-snew-"));
    const resume = vi.fn(async () => {
      throw new Error("SessionPersistenceCorruptionError: stored session failed validation");
    });
    const create = vi.fn(async (opts: { sessionId: string }) => ({
      agent: {
        id: opts.sessionId,
        status: "idle",
        options: {},
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: async () => {},
      },
    }));
    const commands = {
      find: () => undefined,
      execute: async () => undefined,
      list: () => [],
    };
    const ctx = {
      get: (name: string) => {
        if (name === "agents") return { create, resume, get: () => undefined, list: () => [] };
        if (name === "commands") return commands;
        if (name === "sessionQuery") {
          return {
            listSessions: async () => [],
            readTitle: async () => undefined,
            listEvents: async () => {
              throw new Error("stored session failed validation");
            },
          };
        }
        return undefined;
      },
      on: () => () => {},
    };
    const cfg = defaultConfig();
    cfg.storageDir = dir;
    const bridge = new WeChatDSHBridge(ctx, cfg);
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw",
      token: "t",
      accountId: "b1",
      userId: "u",
      savedAt: "",
    };
    bridge.attachCommands(commands as never);
    const anyBridge = bridge as unknown as {
      state: {
        ensureUser(u: string, c: string): { sessionId: string };
        update(u: string, p: unknown): void;
        getUser(u: string): { sessionId: string } | undefined;
      };
      handleMessage(m: unknown): Promise<void>;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: CORRUPT_ID });

    await anyBridge.handleMessage(wechatTextMessage("/s new"));

    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const user = anyBridge.state.getUser("u1")!;
    expect(user.sessionId).not.toBe(CORRUPT_ID);
    expect(user.sessionId).toMatch(/^session-/);
    const body = String(sendTextMessage.mock.calls[0]?.[1]);
    expect(body).toContain(`原会话 ${CORRUPT_ID} 已损坏`);
    expect(body).toContain("已新建会话");
  });
});
