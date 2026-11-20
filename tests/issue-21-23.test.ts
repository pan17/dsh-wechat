/**
 * Issue #21 — archived / un-attachable bindings must not swallow messages.
 * Issue #23 — `/new` must be a session command, never forwarded prose.
 *
 * #21 had three independent silent paths, all covered here:
 *   1. `AgentStore.ensure` reused (or resumed) an ARCHIVED session; on DSH
 *      0.2.2+ every turn of it ends `blocked` with no model request, so the
 *      WeChat message was consumed and never answered.
 *   2. A binding whose cwd no longer matches the session was resumed, the host
 *      refused `attachSession`, and the bridge swallowed the error.
 *   3. `turn/end { reason: { kind: "blocked" } }` had no handler at all: no
 *      outbound message, no audit line, no warning.
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
import {
  LOCAL_COMMAND_NAMES,
  commandUsageHint,
  detectUnknownSlashCommand,
  isBypassSlashCommand,
  parseSessionCommand,
} from "../src/bridge/slash.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import type { UserState } from "../src/state.js";

const ARCHIVED_ID = "session-11111111-1111-4111-8111-111111111111";

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

function idleAgent(id: string, received: unknown[]) {
  return {
    id,
    status: "idle" as const,
    options: { provider: "deepseek", model: "deepseek-chat" },
    followup: (message: unknown) => received.push(message),
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
  };
}

interface StoreFixture {
  store: AgentStore;
  get: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  user: UserState;
}

function makeStore(options: {
  archived?: string[];
  live?: unknown;
  resume?: (opts: { resumeSessionId: string }) => Promise<unknown>;
  attach?: (sessionId: string) => Promise<void>;
  received?: unknown[];
}): StoreFixture {
  const received = options.received ?? [];
  const user = makeUser(ARCHIVED_ID);
  const get = vi.fn((id: string) => (id === ARCHIVED_ID ? options.live : undefined));
  const resume = vi.fn(
    options.resume ??
      (async (opts: { resumeSessionId: string }) => ({ agent: idleAgent(opts.resumeSessionId, received) })),
  );
  const create = vi.fn(async (opts: { sessionId: string }) => ({
    agent: idleAgent(opts.sessionId, received),
  }));
  const workspace = {
    path: "C:\\work",
    title: "work",
    sessionIds: [] as string[],
    attachSession: async (id: string) => {
      workspace.sessionIds.push(id);
      await options.attach?.(id);
    },
  };
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return { create, resume, get, list: () => [] };
      if (name === "workspaceRegistry") {
        return {
          archivedSessionIds: options.archived ?? [],
          list: () => [workspace],
          create: async () => workspace,
          resolveByPath: async () => workspace,
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  return { store: new AgentStore(ctx), get, resume, create, user };
}

describe("issue #21 — archived sessions are never reused", () => {
  it("retires a LIVE archived binding without touching the old agent", async () => {
    const received: unknown[] = [];
    const live = idleAgent(ARCHIVED_ID, received);
    const { store, user, resume, create } = makeStore({ archived: [ARCHIVED_ID], live });

    const result = await store.ensure(user, { replaceOnResumeFailure: true });

    expect(result.replacedSessionId).toBe(ARCHIVED_ID);
    expect(result.replacedReason).toBe("archived");
    expect(result.agent).toBeDefined();
    expect(result.agent!.id).not.toBe(ARCHIVED_ID);
    // The archived agent is not fed; a brand-new session was minted instead.
    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
    expect(user.sessionId).toBe(result.agent!.id);
  });

  it("does not even resume an archived session that is not loaded", async () => {
    const { store, user, resume, create } = makeStore({ archived: [ARCHIVED_ID] });

    const result = await store.ensure(user, { replaceOnResumeFailure: true });

    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.replacedReason).toBe("archived");
  });

  it("keeps the binding and mints nothing when replacement is off", async () => {
    const { store, user, create } = makeStore({ archived: [ARCHIVED_ID] });

    const result = await store.ensure(user);

    expect(result.agent).toBeUndefined();
    expect(result.replacedSessionId).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(user.sessionId).toBe(ARCHIVED_ID);
  });

  it("leaves a non-archived session alone", async () => {
    const received: unknown[] = [];
    const live = idleAgent(ARCHIVED_ID, received);
    const { store, user, create } = makeStore({ archived: [], live });

    const result = await store.ensure(user, { replaceOnResumeFailure: true });

    expect(result.agent).toBe(live);
    expect(result.replacedSessionId).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(user.sessionId).toBe(ARCHIVED_ID);
  });
});

describe("issue #21 — a cwd-mismatched binding is replaced, not resurrected", () => {
  it("retires the session when the host refuses the workspace attach", async () => {
    const { store, user, resume, create } = makeStore({
      attach: async (sessionId) => {
        if (sessionId !== ARCHIVED_ID) return;
        throw new Error(
          `cannot attach session "${ARCHIVED_ID}" to workspace "C:\\work": its cwd resolves to "C:\\old"`,
        );
      },
    });

    const result = await store.ensure(user, { replaceOnResumeFailure: true });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.replacedReason).toBe("cwd-mismatch");
    expect(result.replacedSessionId).toBe(ARCHIVED_ID);
    expect(create).toHaveBeenCalledTimes(1);
    expect(user.sessionId).not.toBe(ARCHIVED_ID);
  });

  it("treats any other attach failure as non-fatal", async () => {
    const received: unknown[] = [];
    const live = idleAgent(ARCHIVED_ID, received);
    const { store, user, create } = makeStore({
      live,
      attach: async () => {
        throw new Error("workspace registry is read-only right now");
      },
    });

    const result = await store.ensure(user, { replaceOnResumeFailure: true });

    expect(result.agent).toBe(live);
    expect(result.replacedReason).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(user.sessionId).toBe(ARCHIVED_ID);
  });
});

/** Bridge fixture: one bound WeChat user, an `agents` service, an archive set. */
function makeBridge(options: {
  archived?: string[];
  live?: unknown;
  received: unknown[];
  listEvents?: () => Promise<Array<{ type: string; time: number }>>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-i21-"));
  const created: string[] = [];
  const agentsService = {
    create: async (opts: { sessionId: string }) => {
      created.push(opts.sessionId);
      return { agent: idleAgent(opts.sessionId, options.received) };
    },
    resume: async (opts: { resumeSessionId: string }) => ({
      agent: idleAgent(opts.resumeSessionId, options.received),
    }),
    get: (id: string) => (id === ARCHIVED_ID ? options.live : undefined),
    list: () => [],
  };
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "workspaceRegistry") {
        return {
          archivedSessionIds: options.archived ?? [],
          list: () => [],
          create: async () => ({ attachSession: async () => {} }),
          resolveByPath: async () => undefined,
        };
      }
      if (name === "sessionQuery") {
        return {
          listSessions: async () => [],
          readTitle: async () => undefined,
          listEvents: options.listEvents ?? (async () => []),
        };
      }
      return undefined;
    },
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
  const anyBridge = bridge as unknown as {
    state: {
      ensureUser(u: string, c: string): { sessionId: string };
      update(u: string, p: unknown): void;
      getUser(u: string): { sessionId: string } | undefined;
    };
    handleMessage(m: unknown): Promise<void>;
    handleSessionEvent(sessionId: string, event: { type: string; [k: string]: unknown }): void;
  };
  anyBridge.state.ensureUser("u1", "C:\\work");
  anyBridge.state.update("u1", { sessionId: ARCHIVED_ID });
  return { bridge: anyBridge, storageDir: dir, created };
}

function replies(): string[] {
  return sendTextMessage.mock.calls.map((call) => String(call[1]));
}

describe("issue #21 — WeChat recovers from an archived binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints a new session on the next message and says why", async () => {
    const received: unknown[] = [];
    const live = idleAgent(ARCHIVED_ID, received);
    const { bridge, storageDir, created } = makeBridge({
      archived: [ARCHIVED_ID],
      live,
      received,
    });

    await bridge.handleMessage(wechatTextMessage("你好，还在吗"));

    const user = bridge.state.getUser("u1")!;
    expect(user.sessionId).not.toBe(ARCHIVED_ID);
    expect(created).toEqual([user.sessionId]);
    // The archived agent never received the message; the new one did.
    expect(received).toHaveLength(1);
    expect(replies().some((text) => text.includes(`原会话 ${ARCHIVED_ID} 已在 GUI 归档`))).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(path.join(storageDir, "state.json"), "utf-8")) as {
      users: Record<string, { sessionId: string }>;
    };
    expect(persisted.users.u1!.sessionId).toBe(user.sessionId);
  });
});

describe("issue #21 — /s new escapes an archived (even blank) binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not answer 已在空白会话 for an archived blank session", async () => {
    const received: unknown[] = [];
    const { bridge, created } = makeBridge({
      archived: [ARCHIVED_ID],
      received,
      // A blank session: readable log, never spoken to. Archived + blank is the
      // trap from the issue — "already blank" would park the user there.
      listEvents: async () => [],
    });

    await bridge.handleMessage(wechatTextMessage("/s new"));

    const user = bridge.state.getUser("u1")!;
    expect(user.sessionId).not.toBe(ARCHIVED_ID);
    expect(created).toEqual([user.sessionId]);
    const body = replies().join("\n");
    expect(body).not.toContain("已在空白会话");
    expect(body).toContain(`原会话 ${ARCHIVED_ID} 已在 GUI 归档`);
  });
});

describe("issue #21 — a host-blocked turn is reported instead of silent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the user the session is archived and how to recover", async () => {
    const received: unknown[] = [];
    const { bridge } = makeBridge({ archived: [ARCHIVED_ID], received });

    bridge.handleSessionEvent(ARCHIVED_ID, {
      type: "turn/end",
      seq: 8,
      time: Date.now(),
      data: { turn: 3, reason: { kind: "blocked" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const body = replies().join("\n");
    expect(body).toContain("已在 GUI 归档");
    expect(body).toContain("/s new");
  });

  it("still reports a blocked turn with no archive marker", async () => {
    const received: unknown[] = [];
    const { bridge } = makeBridge({ archived: [], received });

    bridge.handleSessionEvent(ARCHIVED_ID, {
      type: "turn/end",
      seq: 9,
      time: Date.now(),
      data: { turn: 4, reason: { kind: "blocked" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(replies().join("\n")).toContain("turn/end blocked");
  });

  it("stays quiet for an ordinary turn/end", async () => {
    const received: unknown[] = [];
    const { bridge } = makeBridge({ archived: [], received });

    bridge.handleSessionEvent(ARCHIVED_ID, {
      type: "turn/end",
      seq: 10,
      time: Date.now(),
      data: { turn: 5, reason: { kind: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(replies()).toHaveLength(0);
  });
});

describe("issue #23 — /new is /s new", () => {
  it("parses as the session 'new' subcommand", () => {
    expect(parseSessionCommand("/new")).toEqual({ kind: "new" });
    expect(parseSessionCommand("  /new  ")).toEqual({ kind: "new" });
    // Only the exact line: these are not commands (and must keep their old
    // handling: `/news` is prose, `/new x` is a usage error).
    expect(parseSessionCommand("/new x")).toBeNull();
    expect(parseSessionCommand("/news")).toBeNull();
    expect(parseSessionCommand("/newer")).toBeNull();
  });

  it("is wired like every other local command", () => {
    expect(LOCAL_COMMAND_NAMES.has("new")).toBe(true);
    expect(detectUnknownSlashCommand("/new")).toBeNull();
    expect(isBypassSlashCommand("/new")).toBe(true);
    // A bad line for it answers with the session grammar — never a forward.
    const hint = commandUsageHint("/new now")!;
    expect(hint).toContain("没有转发给 agent");
    expect(hint).toContain("/session");
  });

  it("leaves lookalike names to their existing path", () => {
    expect(detectUnknownSlashCommand("/news")).toBe("/news");
    expect(detectUnknownSlashCommand("/newer")).toBe("/newer");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a session from WeChat instead of forwarding the literal line", async () => {
    const received: unknown[] = [];
    const { bridge, created } = makeBridge({ archived: [], received });
    // No binding yet: this is the cold "/new" a user types after onboarding.
    bridge.state.update("u1", { sessionId: "" });

    await bridge.handleMessage(wechatTextMessage("/new"));

    const user = bridge.state.getUser("u1")!;
    expect(user.sessionId).toMatch(/^session-/);
    expect(created).toEqual([user.sessionId]);
    expect(received).toHaveLength(0);
    expect(replies().join("\n")).toContain("已创建新会话");
    expect(replies().some((text) => text.includes("未知命令"))).toBe(false);
  });
});
