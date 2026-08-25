/**
 * /s list and /status preset display: the bridge must report what a
 * session *actually runs* — the latest `agent-preset/selected` event —
 * not just the creation-time `header.agentPreset`. A session switched
 * after creation (the user manually chose cordis on an originally-
 * standard header) must show its live preset with the metadata
 * display name, mirroring the GUI.
 *
 * The bridge's `ops.resolveSessionPreset` reads the raw session log
 * via `session-log.cjs` (multi-frame Zstandard). Tests build a fake
 * `$DSH_HOME` and write real session.jsonl.zstd artifacts so the
 * production code path is exercised end-to-end, including the frame
 * scanner. Setting `DSH_HOME` is done per-test so it can be unset
 * afterwards.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Use namespace import — the default-import shape of `node:zlib` does not
// expose the Zstd helpers (`zstdCompressSync` / `zstdDecompressSync`)
// under Node 24 + vitest's ESM resolver, which CI runs. Namespace import
// resolves to the module namespace and surfaces every named export.
import * as zlib from "node:zlib";

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

// ─── helpers: build a real session.jsonl.zstd under a temp $DSH_HOME ───

/**
 * Reproduce `projectKey` (encoded workspace path) — identical to the
 * helper inside `session-log.cjs`, kept in sync by both reading the
 * `dsh-session-persistence-jsonl` source. We re-derive it here so the
 * test setup doesn't need to import the production helper (which
 * would couple the test to a CJS module load).
 */
function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Write a real multi-frame Zstandard session artifact. The host
 * persists one frame per write batch, so most sessions look like
 * `{header}\n` followed by N frames of events. We honour that
 * shape so the scanner in `session-log.cjs` (and the host's own
 * scanner) both decode cleanly.
 */
function writeSessionLog(opts: {
  dshHome: string;
  cwd: string;
  sessionId: string;
  headerAgentPreset?: string;
  events?: Array<{ type: string; data?: unknown; seq?: number; time?: number }>;
}) {
  const { dshHome, cwd, sessionId, headerAgentPreset, events = [] } = opts;
  const dir = path.join(dshHome, "sessions", projectKey(cwd), encodeURIComponent(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  // Build header + events as one newline-delimited JSON string.
  const headerObj = {
    type: "session",
    version: 0,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    delegationDepth: 0,
    ...(headerAgentPreset ? { agentPreset: headerAgentPreset } : {}),
  };
  const lines: string[] = [JSON.stringify(headerObj)];
  for (const ev of events) lines.push(JSON.stringify(ev));
  const text = lines.join("\n") + "\n";
  // The host writes frames of ~1024 lines or until close; here we
  // split the header off (its own frame) and the rest as one frame,
  // matching the simplest realistic layout.
  const headerLine = lines[0]!;
  const eventText = lines.slice(1).join("\n") + "\n";
  // One frame for the header, one frame for events (if any).
  const headerFrame = zlib.zstdCompressSync(Buffer.from(headerLine + "\n"));
  const eventFrame = events.length > 0
    ? zlib.zstdCompressSync(Buffer.from(eventText))
    : null;
  const buf = eventFrame
    ? Buffer.concat([headerFrame, eventFrame])
    : headerFrame;
  fs.writeFileSync(path.join(dir, "session.jsonl.zstd"), buf);
}

interface FakeSessionQuery {
  listSessions: () => Promise<Array<{ header: { id: string; createdAt: number; cwd?: string; agentPreset?: string }; live: boolean; persisted: boolean }>>;
  readTitle: (sessionId: string) => Promise<{ title?: string } | undefined>;
}

function makeBridge(opts: {
  agent: { agent: { id: string; status: string } };
  query: FakeSessionQuery;
  agentPresets?: Array<{ id: string; name?: string; description?: string }>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-preset-"));
  const agentsService = {
    create: async () => opts.agent,
    resume: async () => opts.agent,
    get: (id: string) => (id === opts.agent.agent.id ? opts.agent.agent : undefined),
    list: () => [opts.agent.agent],
  };
  const presetList = opts.agentPresets ?? [];
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "sessionQuery") return opts.query;
      if (name === "agentPresets") return {
        list: async () => presetList,
        defaultId: presetList.find((p) => p.id === "standard")?.id ?? "standard",
        recompose: async () => undefined,
      };
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
  (bridge as unknown as { contextTokens: Map<string, string> }).contextTokens.set(
    "u1",
    "ctx-token",
  );
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

describe("preset display — session list uses live preset (event-aware)", () => {
  let dshHome: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
    originalEnv = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalEnv;
  });

  it("shows the metadata display name for a session switched to cordis after creation", async () => {
    // Three sessions in the same cwd. Only s-b's log carries an
    // `agent-preset/selected { agentPreset: "cordis" }` event — the
    // exact bug repro on disk. Headers are all "standard" (frozen
    // at creation).
    const cwd = "C:\\work";
    writeSessionLog({
      dshHome, cwd, sessionId: "s-a",
      headerAgentPreset: "standard",
    });
    writeSessionLog({
      dshHome, cwd, sessionId: "s-b",
      headerAgentPreset: "standard",
      events: [
        { type: "user/message", data: {}, seq: 1, time: 1000 },
        { type: "agent-preset/selected", data: { agentPreset: "cordis" }, seq: 3, time: 1100 },
      ],
    });
    writeSessionLog({
      dshHome, cwd, sessionId: "s-c",
      headerAgentPreset: "standard",
    });
    const sessions = [
      { header: { id: "s-a", createdAt: 100, cwd, agentPreset: "standard" }, live: true, persisted: true },
      { header: { id: "s-b", createdAt: 200, cwd, agentPreset: "standard" }, live: true, persisted: true },
      { header: { id: "s-c", createdAt: 300, cwd, agentPreset: "standard" }, live: true, persisted: true },
    ];
    const query: FakeSessionQuery = {
      listSessions: async () => sessions,
      readTitle: async () => undefined,
    };
    const bridge = makeBridge({
      agent: { agent: { id: "s-current", status: "idle" } },
      query,
      agentPresets: [
        { id: "standard", name: "标准模式" },
        { id: "cordis", name: "创造模式" },
      ],
    });
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", cwd);
      state.update("u1", { sessionId: "s-b" });
    }
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/s list"),
    );
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("Preset:创造模式");
    // Other sessions, with no switch event, fall back to header value.
    expect(text).toContain("Preset:标准模式");
    // Bug repro check: raw ids must NOT leak after the marker.
    expect(text).not.toMatch(/Preset:standard\b/);
    expect(text).not.toMatch(/Preset:cordis\b/);
  });

  it("does not re-scan the session roster once per /s list row", async () => {
    const cwd = "C:\\work";
    writeSessionLog({ dshHome, cwd, sessionId: "s-a", headerAgentPreset: "standard" });
    writeSessionLog({ dshHome, cwd, sessionId: "s-b", headerAgentPreset: "standard" });
    writeSessionLog({ dshHome, cwd, sessionId: "s-c", headerAgentPreset: "standard" });
    const sessions = [
      { header: { id: "s-a", createdAt: 100, cwd, agentPreset: "standard" }, live: true, persisted: true },
      { header: { id: "s-b", createdAt: 200, cwd, agentPreset: "standard" }, live: true, persisted: true },
      { header: { id: "s-c", createdAt: 300, cwd, agentPreset: "standard" }, live: true, persisted: true },
    ];
    const listSessions = vi.fn(async () => sessions);
    const query: FakeSessionQuery = {
      listSessions,
      readTitle: async () => undefined,
    };
    const bridge = makeBridge({
      agent: { agent: { id: "s-a", status: "idle" } },
      query,
      agentPresets: [{ id: "standard", name: "标准模式" }],
    });
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown };
      }).state;
      state.ensureUser("u1", cwd);
    }
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/s list"),
    );
    // One roster read for the list itself — not one extra per displayed row.
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("shows '（默认）' suffix when the session has no preset on record", async () => {
    const cwd = "C:\\work";
    writeSessionLog({
      dshHome, cwd, sessionId: "s-empty",
      // header has no agentPreset at all
    });
    const query: FakeSessionQuery = {
      listSessions: async () => [
        { header: { id: "s-empty", createdAt: 100, cwd }, live: true, persisted: true },
      ],
      readTitle: async () => undefined,
    };
    const bridge = makeBridge({
      agent: { agent: { id: "s-empty", status: "idle" } },
      query,
      agentPresets: [
        { id: "standard", name: "标准模式" },
        { id: "cordis", name: "创造模式" },
      ],
    });
    {
      const state = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown } }).state;
      state.ensureUser("u1", cwd);
    }
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    // No sessionId binding → default row is the deployment default;
    // the session row says unbound rather than inventing a live value.
    expect(text).toMatch(/• 默认 Preset:\s*标准模式/);
    expect(text).toMatch(/• 当前会话 Preset:\s*（未绑定）/);
  });

  it("shows the live preset in /status (event-aware, not header-only)", async () => {
    const cwd = "C:\\work";
    writeSessionLog({
      dshHome, cwd, sessionId: "s-live",
      headerAgentPreset: "standard",
      events: [
        { type: "user/message", data: {}, seq: 1, time: 1000 },
        { type: "agent-preset/selected", data: { agentPreset: "cordis" }, seq: 3, time: 1100 },
      ],
    });
    const query: FakeSessionQuery = {
      listSessions: async () => [
        { header: { id: "s-live", createdAt: 100, cwd, agentPreset: "standard" }, live: true, persisted: true },
      ],
      readTitle: async () => undefined,
    };
    const bridge = makeBridge({
      agent: { agent: { id: "s-live", status: "idle" } },
      query,
      agentPresets: [
        { id: "standard", name: "标准模式" },
        { id: "cordis", name: "创造模式" },
      ],
    });
    {
      const state = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void } }).state;
      state.ensureUser("u1", cwd);
      state.update("u1", { sessionId: "s-live" });
    }
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toMatch(/• 默认 Preset:\s*标准模式/);
    expect(text).toMatch(/• 当前会话 Preset:\s*创造模式/);
    expect(text.indexOf("• 当前会话 Preset:")).toBeLessThan(text.indexOf("• 模型:"));
    expect(text.indexOf("• 模型:")).toBeLessThan(text.indexOf("• 默认 Preset:"));
    expect(text.indexOf("• 默认 Preset:")).toBeLessThan(text.indexOf("• 静默模式:"));
    expect(text).not.toMatch(/• 当前会话 Preset:\s*标准模式/);
    expect(text).not.toMatch(/Preset:\s*standard\b/);
    expect(text).not.toMatch(/Preset:\s*cordis\b/);
  });

  it("reads the *newest* agent-preset/selected when there are several switches", async () => {
    // A session that flipped standard → cordis → minimal must end up
    // as "minimal" — same newest-wins rule the host applies.
    const cwd = "C:\\work";
    writeSessionLog({
      dshHome, cwd, sessionId: "s-flips",
      headerAgentPreset: "standard",
      events: [
        { type: "agent-preset/selected", data: { agentPreset: "cordis" }, seq: 1, time: 100 },
        { type: "user/message", data: {}, seq: 2, time: 200 },
        { type: "agent-preset/selected", data: { agentPreset: "minimal" }, seq: 3, time: 300 },
      ],
    });
    const query: FakeSessionQuery = {
      listSessions: async () => [
        { header: { id: "s-flips", createdAt: 100, cwd, agentPreset: "standard" }, live: true, persisted: true },
      ],
      readTitle: async () => undefined,
    };
    const bridge = makeBridge({
      agent: { agent: { id: "s-flips", status: "idle" } },
      query,
      agentPresets: [
        { id: "standard", name: "标准模式" },
        { id: "cordis", name: "创造模式" },
        { id: "minimal", name: "极简模式" },
      ],
    });
    {
      const state = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void } }).state;
      state.ensureUser("u1", cwd);
      state.update("u1", { sessionId: "s-flips" });
    }
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toMatch(/• 默认 Preset:\s*标准模式/);
    expect(text).toMatch(/• 当前会话 Preset:\s*极简模式/);
    expect(text).not.toMatch(/• 当前会话 Preset:\s*创造模式/);
    expect(text).not.toMatch(/• 当前会话 Preset:\s*标准模式/);
  });

  it("shows the deployment default on /preset status, not the session live preset", async () => {
    const cwd = "C:\\work";
    writeSessionLog({
      dshHome, cwd, sessionId: "s-live",
      headerAgentPreset: "standard",
      events: [
        { type: "agent-preset/selected", data: { agentPreset: "cordis" }, seq: 3, time: 1100 },
      ],
    });
    const query: FakeSessionQuery = {
      listSessions: async () => [
        { header: { id: "s-live", createdAt: 100, cwd, agentPreset: "standard" }, live: true, persisted: true },
      ],
      readTitle: async () => undefined,
    };
    const bridge = makeBridge({
      agent: { agent: { id: "s-live", status: "idle" } },
      query,
      agentPresets: [
        { id: "standard", name: "标准模式" },
        { id: "cordis", name: "创造模式" },
      ],
    });
    {
      const state = (bridge as unknown as { state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void } }).state;
      state.ensureUser("u1", cwd);
      state.update("u1", { sessionId: "s-live" });
    }
    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/preset status"),
    );
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toMatch(/默认 Preset:\s*标准模式/);
    expect(text).toMatch(/当前会话:\s*创造模式/);
    expect(text).not.toMatch(/^🤖 Preset:\s*创造模式/m);
    expect(text).not.toMatch(/Agent:/);
  });
});