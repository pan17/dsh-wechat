/**
 * Session-management fixes:
 * - listSessions() filters archived sessions (GUI "archive" hides them).
 * - mintSessionId() uses the GUI's `session-<uuid>` format.
 * - `/session new` reuses a blank session in the current cwd (GUI's
 *   "reuse-or-create its blank session") instead of always creating.
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
import { DshOps } from "../src/dsh/ops.js";
import { mintSessionId } from "../src/dsh/sessions.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-sess-"));
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

describe("mintSessionId uses the GUI session id format", () => {
  it("produces `session-<uuid>` ids", () => {
    const id = mintSessionId();
    expect(id).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toMatch(/^wx-/);
    // Unique across calls.
    expect(mintSessionId()).not.toBe(id);
  });
});

describe("listSessions filters archived sessions", () => {
  function makeOps(
    archived: string[],
    sessions: unknown[],
    listEvents: () => Promise<Array<{ type: string; time: number }>> = async () => [],
  ) {
    const ctx = {
      get: (name: string) => {
        if (name === "sessionQuery") {
          return { listSessions: async () => sessions, readTitle: async () => undefined, listEvents };
        }
        if (name === "workspaceRegistry") {
          return { archivedSessionIds: archived };
        }
        return undefined;
      },
      on: () => () => {},
    };
    return new DshOps(ctx as never);
  }

  it("drops archived sessions and keeps the rest", async () => {
    const ops = makeOps(
      ["archived-1"],
      [
        { header: { id: "s-1", createdAt: 1, cwd: "C:\\w" }, live: false, persisted: true },
        { header: { id: "archived-1", createdAt: 2, cwd: "C:\\w" }, live: false, persisted: true },
        { header: { id: "sub-1", createdAt: 3, cwd: "C:\\w", origin: "subagent" }, live: false, persisted: true },
      ],
    );
    const result = await ops.listSessions();
    expect(result.map((r) => r.header.id)).toEqual(["s-1"]);
  });

  it("inspectSessionActivity reports the last user/message time", async () => {
    const ops = makeOps([], [], async () => [
      { type: "assistant/message", time: 1 },
      { type: "user/message", time: 42 },
      { type: "assistant/message", time: 50 },
    ]);
    await expect(ops.inspectSessionActivity("s-1")).resolves.toEqual({ ok: true, lastUserMessageTime: 42 });
  });

  it("inspectSessionActivity treats an empty readable log as blank, not corrupt", async () => {
    const ops = makeOps([], []);
    await expect(ops.inspectSessionActivity("s-1")).resolves.toEqual({ ok: true });
  });

  it("inspectSessionActivity returns ok:false when listEvents throws", async () => {
    const ops = makeOps([], [], async () => {
      throw new Error("stored session failed validation");
    });
    await expect(ops.inspectSessionActivity("s-1")).resolves.toEqual({
      ok: false,
      error: "stored session failed validation",
    });
  });

  it("keeps everything when nothing is archived", async () => {
    const ops = makeOps(
      [],
      [
        { header: { id: "s-1", createdAt: 1, cwd: "C:\\w" }, live: false, persisted: true },
        { header: { id: "s-2", createdAt: 2, cwd: "C:\\w" }, live: false, persisted: true },
      ],
    );
    const result = await ops.listSessions();
    expect(result.map((r) => r.header.id)).toEqual(["s-1", "s-2"]);
  });
});

describe("/session new reuses a blank session", () => {
  let bridge: WeChatDSHBridge;
  let mock: ReturnType<typeof makeMockAgent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockAgent("session-aaaaaaaa-0000-4000-8000-000000000000");
    bridge = makeBridge(mock);
  });

  async function setupWithSessions(
    sessions: Array<{ id: string; createdAt: number; cwd?: string }>,
    userActivity?: (id: string) => number | undefined,
    unreadable?: (id: string) => boolean,
  ) {
    const anyBridge = bridge as unknown as {
      state: {
        ensureUser(u: string, c: string): { userId: string; cwd: string; sessionId: string; silent: boolean };
        update(u: string, p: unknown): void;
        getUser(u: string): { userId: string; cwd: string; sessionId: string; silent: boolean };
      };
      ops: {
        listSessions(): Promise<Array<{ header: { id: string; createdAt: number; cwd?: string } }>>;
        lastUserMessageTime(id: string): Promise<number | undefined>;
        inspectSessionActivity(id: string): Promise<
          { ok: true; lastUserMessageTime?: number } | { ok: false; error: string }
        >;
      };
      handleSessionCommand(u: string, cmd: { kind: "new" }): Promise<void>;
    };
    const activity = userActivity ?? (() => undefined);
    const isUnreadable = unreadable ?? (() => false);
    anyBridge.ops.listSessions = async () =>
      sessions.map((s) => ({
        header: { id: s.id, createdAt: s.createdAt, ...(s.cwd ? { cwd: s.cwd } : {}) },
      }));
    anyBridge.ops.lastUserMessageTime = async (id: string) => activity(id);
    anyBridge.ops.inspectSessionActivity = async (id: string) => {
      if (isUnreadable(id)) return { ok: false, error: "corrupt" };
      const t = activity(id);
      return t === undefined ? { ok: true } : { ok: true, lastUserMessageTime: t };
    };
    const user = anyBridge.state.ensureUser("u1", "C:\\work");
    (user as { sessionId: string }).sessionId = "";
    return anyBridge;
  }

  it("reuses the newest blank session in the cwd instead of creating", async () => {
    const anyBridge = await setupWithSessions(
      [
        { id: "blank-old", createdAt: 100, cwd: "C:\\work" },
        { id: "blank-new", createdAt: 200, cwd: "C:\\work" },
        { id: "used", createdAt: 300, cwd: "C:\\work" },
        { id: "other-cwd", createdAt: 400, cwd: "D:\\other" },
      ],
      (id) => (id === "used" ? 999 : undefined), // only "used" has activity
    );
    await anyBridge.handleSessionCommand("u1", { kind: "new" });
    const user = anyBridge.state.getUser("u1");
    expect(user.sessionId).toBe("blank-new"); // newest blank
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("已复用空白会话"),
      expect.anything(),
    );
  });

  it("keeps the current session when it is already blank", async () => {
    const anyBridge = await setupWithSessions([
      { id: "blank-old", createdAt: 100, cwd: "C:\\work" },
    ]);
    const user = anyBridge.state.getUser("u1");
    user.sessionId = "current-blank";
    await anyBridge.handleSessionCommand("u1", { kind: "new" });
    expect(user.sessionId).toBe("current-blank");
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("已在空白会话"),
      expect.anything(),
    );
  });

  it("creates a fresh session when no blank exists", async () => {
    const anyBridge = await setupWithSessions(
      [{ id: "used", createdAt: 100, cwd: "C:\\work" }],
      () => 999,
    );
    const user = anyBridge.state.getUser("u1");
    user.sessionId = "";
    // Force minted session: the mock create returns the fixed agent, and
    // ensure() writes the minted id into user.sessionId.
    const before = user.sessionId;
    await anyBridge.handleSessionCommand("u1", { kind: "new" });
    expect(user.sessionId).not.toBe(before);
    expect(user.sessionId).toMatch(/^session-/);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("已创建新会话"),
      expect.anything(),
    );
  });

  it("creates a fresh session when the current binding is unreadable", async () => {
    const anyBridge = await setupWithSessions(
      [{ id: "session-corrupt", createdAt: 100, cwd: "C:\\work" }],
      () => undefined,
      (id) => id === "session-corrupt",
    );
    const user = anyBridge.state.getUser("u1");
    user.sessionId = "session-corrupt";
    await anyBridge.handleSessionCommand("u1", { kind: "new" });
    expect(user.sessionId).not.toBe("session-corrupt");
    expect(user.sessionId).toMatch(/^session-/);
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("原会话 session-corrupt 已损坏"),
      expect.anything(),
    );
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("已新建会话"),
      expect.anything(),
    );
  });

  it("does not reuse an unreadable candidate as a blank session", async () => {
    const anyBridge = await setupWithSessions(
      [
        { id: "corrupt-blank", createdAt: 300, cwd: "C:\\work" },
        { id: "real-blank", createdAt: 200, cwd: "C:\\work" },
        { id: "used", createdAt: 100, cwd: "C:\\work" },
      ],
      (id) => (id === "used" ? 999 : undefined),
      (id) => id === "corrupt-blank",
    );
    await anyBridge.handleSessionCommand("u1", { kind: "new" });
    const user = anyBridge.state.getUser("u1");
    expect(user.sessionId).toBe("real-blank");
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("已复用空白会话"),
      expect.anything(),
    );
  });
});

describe("/workspace list counts exclude archived sessions", () => {
  let bridge: WeChatDSHBridge;
  let mock: ReturnType<typeof makeMockAgent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockAgent("session-aaaaaaaa-0000-4000-8000-000000000000");
    bridge = makeBridge(mock);
  });

  it("shows visible session counts per workspace", async () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): { userId: string; cwd: string; sessionId: string; silent: boolean } };
      ops: {
        listWorkspaces(): Array<{ id: string; path: string; title: string; sessionIds: string[] }>;
        archivedSessionIds(): string[];
      };
      handleWorkspaceCommand(u: string, cmd: { kind: "list" }): Promise<void>;
    };
    anyBridge.ops.listWorkspaces = () => [
      { id: "w1", path: "C:\\work", title: "work", sessionIds: ["s-1", "s-2", "s-archived"] },
      { id: "w2", path: "D:\\other", title: "other", sessionIds: ["s-3"] },
    ];
    anyBridge.ops.archivedSessionIds = () => ["s-archived"];
    anyBridge.state.ensureUser("u1", "C:\\work");
    await anyBridge.handleWorkspaceCommand("u1", { kind: "list" });
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("C:\\work（2 会话）"),
      expect.anything(),
    );
    expect(sendTextMessage).toHaveBeenCalledWith(
      "u1",
      expect.stringContaining("D:\\other（1 会话）"),
      expect.anything(),
    );
  });
});

describe("/workspace switch reports the restored session", () => {
  let bridge: WeChatDSHBridge;
  let mock: ReturnType<typeof makeMockAgent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockAgent("session-aaaaaaaa-0000-4000-8000-000000000000");
    bridge = makeBridge(mock);
  });

  function setupWorkspaces(
    workspaces: Array<{ id: string; path: string; title: string; sessionIds: string[] }>,
    archived: string[],
    titles: Record<string, string | undefined>,
  ) {
    const anyBridge = bridge as unknown as {
      state: {
        ensureUser(u: string, c: string): { userId: string; cwd: string; sessionId: string; silent: boolean };
        getUser(u: string): { userId: string; cwd: string; sessionId: string };
      };
      ops: {
        listWorkspaces(): Array<{ id: string; path: string; title: string; sessionIds: string[] }>;
        archivedSessionIds(): string[];
        readSessionTitle(id: string): Promise<string | undefined>;
      };
      handleWorkspaceCommand(u: string, cmd: { kind: "switch"; target: string }): Promise<void>;
    };
    anyBridge.ops.listWorkspaces = () => workspaces;
    anyBridge.ops.archivedSessionIds = () => archived;
    anyBridge.ops.readSessionTitle = async (id: string) => titles[id];
    anyBridge.state.ensureUser("u1", "C:\\work");
    return anyBridge;
  }

  it("shows restored session name and full id", async () => {
    const anyBridge = setupWorkspaces(
      [{ id: "w1", path: "C:\\work", title: "work", sessionIds: ["session-visible-1"] }],
      [],
      { "session-visible-1": "修切换回显" },
    );
    await anyBridge.handleWorkspaceCommand("u1", { kind: "switch", target: "1" });
    const user = anyBridge.state.getUser("u1");
    expect(user.sessionId).toBe("session-visible-1");
    const body = String(sendTextMessage.mock.calls[0]?.[1]);
    expect(body).toContain("已切换到工作区: work — C:\\work");
    expect(body).toContain("已恢复会话: 修切换回显（session-visible-1）");
  });

  it("skips archived sessions and restores the next visible one", async () => {
    const anyBridge = setupWorkspaces(
      [{ id: "w1", path: "C:\\work", title: "work", sessionIds: ["s-archived", "s-visible"] }],
      ["s-archived"],
      { "s-visible": "可见会话" },
    );
    await anyBridge.handleWorkspaceCommand("u1", { kind: "switch", target: "1" });
    const user = anyBridge.state.getUser("u1");
    expect(user.sessionId).toBe("s-visible");
    const body = String(sendTextMessage.mock.calls[0]?.[1]);
    expect(body).toContain("已恢复会话: 可见会话（s-visible）");
    expect(body).not.toContain("s-archived");
  });

  it("says no session when the workspace has none visible", async () => {
    const anyBridge = setupWorkspaces(
      [{ id: "w1", path: "C:\\work", title: "work", sessionIds: ["s-archived"] }],
      ["s-archived"],
      {},
    );
    await anyBridge.handleWorkspaceCommand("u1", { kind: "switch", target: "1" });
    const user = anyBridge.state.getUser("u1");
    expect(user.sessionId).toBe("");
    const body = String(sendTextMessage.mock.calls[0]?.[1]);
    expect(body).toContain("已切换到工作区: work — C:\\work");
    expect(body).toContain("该工作区暂无会话，发送消息将创建");
  });
});

describe("/session switch reports the session name", () => {
  let bridge: WeChatDSHBridge;
  let mock: ReturnType<typeof makeMockAgent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = makeMockAgent("session-aaaaaaaa-0000-4000-8000-000000000000");
    bridge = makeBridge(mock);
  });

  it("includes title and full id in the switch reply", async () => {
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): { userId: string; cwd: string; sessionId: string; silent: boolean } };
      ops: {
        listSessions(): Promise<Array<{ header: { id: string; createdAt: number; cwd?: string } }>>;
        readSessionTitle(id: string): Promise<string | undefined>;
      };
      handleSessionCommand(u: string, cmd: { kind: "switch"; index: number }): Promise<void>;
    };
    anyBridge.ops.listSessions = async () => [
      { header: { id: "session-old", createdAt: 100, cwd: "C:\\work" } },
      { header: { id: "session-new", createdAt: 200, cwd: "C:\\work" } },
    ];
    anyBridge.ops.readSessionTitle = async (id: string) => (id === "session-new" ? "最新会话" : "旧会话");
    anyBridge.state.ensureUser("u1", "C:\\work");
    await anyBridge.handleSessionCommand("u1", { kind: "switch", index: 1 });
    const body = String(sendTextMessage.mock.calls[0]?.[1]);
    expect(body).toContain("已切换到会话 最新会话（session-new） — C:\\work");
    expect(body).toContain("Agent");
  });
});
