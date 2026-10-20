/**
 * 结论模式 / final-only (per-TASK hold) — `config.finalOnly`.
 *
 * The flood this feature exists for: one request creates a goal whose
 * round-driver auto-continues for N rounds, and EVERY round is its own DSH
 * turn. `silent` is per-TURN, so it still emits N messages; `finalOnly` holds
 * everything and emits exactly one conclusion once the task goes quiet.
 *
 * Covers:
 * - the headline case: 8 goal rounds on the bound session → exactly 1 message
 * - the gap it closes: the same 8 rounds under `silent` → 8 messages
 * - `finalOnly` off → every assistant text is pushed as it happens
 * - a new human message flushes the previous task's held conclusion first
 * - goal continuations do NOT flush (they are not the human speaking)
 * - the hard ceiling delivers even if the session never goes quiet
 * - `agent/status` running cancels the countdown, idle arms it
 * - `/flush` delivers immediately, and is a bypass command
 * - `/final on|off|status` (alias `/fo`) is the WeChat-side switch: it
 *   persists, `off` delivers the hold first, and `/f` stays `/flush`
 * - approvals / questions are never held (they are answerable, not narration)
 * - an agent error drops the hold instead of following it with a stale digest
 * - stop() DELIVERS the hold (dispose is not a peer rebind); re-bind discards
 * - cross-session task notices collapse to one message as well
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
import { ConfigStore } from "../src/config-store.js";
import { isBypassSlashCommand, parseFinalCommand, parseFlushCommand } from "../src/bridge/slash.js";
import { MessageType } from "../src/weixin/types.js";

/**
 * Every bridge built by a case is stopped in `afterEach`: a hold left armed
 * would otherwise fire its timer after the test ended and land in the NEXT
 * case's `sendTextMessage` mock.
 */
const live: any[] = [];

/** Idle window used by most cases — short so the test does not sleep. */
const IDLE_MS = 20;

function makeBridge(patch: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-final-"));
  const ctx: any = {
    get: (name: string) => {
      if (name === "workspaceRegistry") {
        return {
          list: () => [
            { path: "C:\\work", title: "work", sessionIds: ["sess-A", "sess-B"], createdAt: "", id: "ws1" },
          ],
          archivedSessionIds: [],
        };
      }
      if (name === "sessionQuery") {
        return {
          listSessions: async () => [
            { header: { id: "sess-A", cwd: "C:\\work", createdAt: Date.now() }, live: true, persisted: true },
            { header: { id: "sess-B", cwd: "C:\\work", createdAt: Date.now() }, live: true, persisted: true },
          ],
          readTitle: async (id: string) => ({ title: id === "sess-A" ? "当前会话" : "后台任务" }),
          listEvents: async () => [],
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.finalOnly = true;
  cfg.finalOnlyIdleMs = IDLE_MS;
  cfg.finalOnlyCeilingMs = 60_000;
  Object.assign(cfg, patch);
  const bridge = new WeChatDSHBridge(ctx, cfg);
  const state: any = (bridge as any).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId: "sess-A" });
  state.watchSession("u1", "sess-B");
  (bridge as any).token = { baseUrl: "https://x", token: "t" };
  (bridge as any).ops.readSessionTitle = async (id: string) =>
    id === "sess-A" ? "当前会话" : "后台任务";
  live.push(bridge);
  return bridge as any;
}

const assistant = (text: string) => ({
  type: "assistant/message",
  time: Date.now(),
  data: { message: { content: [{ type: "text", text }] } },
});

const humanTurn = () => ({
  type: "user/message",
  time: Date.now(),
  data: { source: { kind: "user" }, id: "m-human" },
});

const goalTurn = (round: number) => ({
  type: "user/message",
  time: Date.now(),
  data: { source: { kind: "goal", goalId: "g1", revision: 1, round } },
});

const turnEnd = () => ({ type: "turn/end", time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } });

/** One full auto-continued round, in the host's real event order. */
function goalRound(bridge: any, round: number, text: string) {
  bridge.handleSessionEvent("sess-A", goalTurn(round));
  bridge.handleSessionEvent("sess-A", assistant(text));
  bridge.handleSessionEvent("sess-A", turnEnd());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flushTicks = () => new Promise<void>((r) => setImmediate(r));

function texts(): string[] {
  return sendTextMessage.mock.calls.map((c: any) => c[1] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  // stop() also discards any hold still armed, so nothing fires later.
  for (const bridge of live.splice(0)) {
    await bridge.stop().catch(() => {});
  }
  await flushTicks();
});

describe("结论模式: the 8-round goal flood", () => {
  it("collapses 8 auto-continued rounds into exactly one conclusion", async () => {
    const bridge = makeBridge();
    for (let round = 1; round <= 8; round += 1) {
      goalRound(bridge, round, `本轮进展（第 ${round}/8 轮）：…`);
    }
    // Nothing may be pushed while the chain is still running.
    await flushTicks();
    expect(texts()).toHaveLength(0);

    await sleep(IDLE_MS + 60);
    const delivered = texts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("第 8/8 轮");
    expect(delivered[0]).toContain("共 8 轮");
    // …and none of the intermediate narration leaked.
    expect(delivered[0]).not.toContain("第 1/8 轮");
  });

  it("the per-turn `silent` switch does NOT fix it (the gap this feature fills)", async () => {
    const bridge = makeBridge({ finalOnly: false, silent: true });
    for (let round = 1; round <= 8; round += 1) {
      goalRound(bridge, round, `本轮进展（第 ${round}/8 轮）：…`);
    }
    await flushTicks();
    await sleep(IDLE_MS + 60);
    // silent is per-TURN: one message per round, i.e. the flood remains.
    expect(texts()).toHaveLength(8);
  });

  it("with the hold off, every assistant text is pushed as it happens", async () => {
    const bridge = makeBridge({ finalOnly: false });
    goalRound(bridge, 1, "第一段");
    await flushTicks();
    expect(texts()).toEqual(["第一段"]);
  });

  it("delivers the last body of a task, not a concatenation of the rounds", async () => {
    const bridge = makeBridge();
    goalRound(bridge, 1, "第一轮结论将被覆盖");
    goalRound(bridge, 2, "最终结论");
    await sleep(IDLE_MS + 60);
    const delivered = texts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("最终结论");
    expect(delivered[0]).not.toContain("第一轮结论将被覆盖");
  });
});

describe("结论模式: what must never be held", () => {
  it("a permission card is pushed immediately while a conclusion is held", async () => {
    const bridge = makeBridge({ crossSessionNotify: true });
    goalRound(bridge, 1, "进行中");
    await flushTicks();
    expect(texts()).toHaveLength(0);
    bridge.handleMuxFrame({
      type: "server-request",
      rpcId: "a-rpc",
      method: "approval/requested",
      payload: {
        type: "approval/requested",
        sessionId: "sess-A",
        approvalId: "ap1",
        toolName: "pwsh",
      },
    });
    await flushTicks();
    await sleep(10);
    expect(texts().some((t) => t.includes("pwsh"))).toBe(true);
  });

  it("an agent error drops the hold so no stale conclusion follows it", async () => {
    const bridge = makeBridge();
    goalRound(bridge, 1, "旧结论不应再补发");
    bridge.handleAgentError("sess-A", new Error("boom"));
    await flushTicks();
    await sleep(IDLE_MS + 60);
    const delivered = texts();
    expect(delivered.some((t) => t.includes("Agent 出错"))).toBe(true);
    expect(delivered.some((t) => t.includes("旧结论不应再补发"))).toBe(false);
  });
});

describe("结论模式: delivery triggers", () => {
  it("a new human message flushes the previous task's conclusion first", async () => {
    const bridge = makeBridge();
    goalRound(bridge, 1, "上一件事的结论");
    bridge.handleSessionEvent("sess-A", humanTurn());
    await flushTicks();
    await sleep(10);
    expect(texts().some((t) => t.includes("上一件事的结论"))).toBe(true);
  });

  it("a goal continuation does NOT flush the hold", async () => {
    const bridge = makeBridge();
    goalRound(bridge, 1, "不应被下一轮冲掉");
    bridge.handleSessionEvent("sess-A", goalTurn(2));
    await flushTicks();
    await sleep(10);
    expect(texts()).toHaveLength(0);
  });

  it("the hard ceiling delivers even when the session never goes quiet", async () => {
    const bridge = makeBridge({ finalOnlyIdleMs: 60_000, finalOnlyCeilingMs: IDLE_MS });
    goalRound(bridge, 1, "长任务阶段结论");
    await sleep(IDLE_MS + 60);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("长任务阶段结论");
  });

  it("agent/status=running cancels the countdown and idle re-arms it", async () => {
    const bridge = makeBridge({ finalOnlyIdleMs: 60, finalOnlyCeilingMs: 60_000 });
    goalRound(bridge, 1, "运行中");
    bridge.handleAgentStatus("sess-A", "running");
    await sleep(120);
    expect(texts()).toHaveLength(0);
    bridge.handleAgentStatus("sess-A", "idle");
    await sleep(120);
    expect(texts()).toHaveLength(1);
  });
});

describe("结论模式: /flush escape hatch", () => {
  it("parses /flush and /f, and both are bypass commands", () => {
    expect(parseFlushCommand("/flush")).toBe(true);
    expect(parseFlushCommand("/f")).toBe(true);
    expect(parseFlushCommand("/flush now")).toBe(false);
    expect(isBypassSlashCommand("/flush")).toBe(true);
    expect(isBypassSlashCommand("/f")).toBe(true);
  });

  it("delivers the held conclusion immediately", async () => {
    const bridge = makeBridge({ finalOnlyIdleMs: 60_000 });
    goalRound(bridge, 1, "立即取回我");
    await flushTicks();
    expect(texts()).toHaveLength(0);
    await bridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "ct",
      item_list: [{ type: 1, text_item: { text: "/flush" } }],
    } as any);
    await flushTicks();
    await sleep(10);
    expect(texts().some((t) => t.includes("立即取回我"))).toBe(true);
  });
});

describe("结论模式: cross-session notices", () => {
  it("collapses a background session's 8 rounds into one message", async () => {
    const bridge = makeBridge({ notifyTaskEvents: true });
    // sess-B is watched but not bound: the bound user is on sess-A.
    for (let round = 1; round <= 8; round += 1) {
      bridge.handleSessionEvent(
        "sess-B",
        { type: "assistant/message", time: Date.now(), data: { message: { content: [{ type: "text", text: `后台第 ${round} 轮` }] } } },
      );
      bridge.handleSessionEvent("sess-B", { type: "turn/end", time: Date.now(), data: {} });
    }
    await flushTicks();
    await sleep(IDLE_MS + 80);
    const completed = texts().filter((t) => t.includes("任务已完成"));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toContain("后台第 8 轮");
  });
});

describe("结论模式: lifecycle hygiene", () => {
  it("stop() DELIVERS the hold (plugin dispose is not a peer rebind)", async () => {
    // The hold is a conclusion the agent already produced. Plugin dispose /
    // host shutdown does not change who the WeChat peer is, so destroying
    // the answer would lose the task's only output; only logout / re-login /
    // re-bind (resetPeerBinding, discardQueuedOutbound) may discard it.
    const bridge = makeBridge({ finalOnlyIdleMs: 60_000 });
    goalRound(bridge, 1, "停用前必须发出");
    await bridge.stop();
    await flushTicks();
    await sleep(30);
    expect(texts().some((t) => t.includes("停用前必须发出"))).toBe(true);
  });

  it("re-binding the peer discards the hold", async () => {
    const bridge = makeBridge({ finalOnlyIdleMs: 60_000 });
    goalRound(bridge, 1, "换绑后不应发出");
    (bridge as any).resetPeerBinding("test");
    await flushTicks();
    await sleep(30);
    expect(texts().some((t) => t.includes("换绑后不应发出"))).toBe(false);
  });

  it("hasPendingFinal reflects the hold, and /status reports the mode", async () => {
    const bridge = makeBridge({ finalOnlyIdleMs: 60_000 });
    expect(bridge.hasPendingFinal("sess-A")).toBe(false);
    goalRound(bridge, 1, "持有中");
    expect(bridge.hasPendingFinal("sess-A")).toBe(true);
  });
});

/**
 * `/final` (alias `/fo`) is the WeChat-side switch for 结论模式. Before it
 * existed the mode was reachable ONLY from the desktop settings page or a
 * hand-edited `config.json`, so a user driving everything from WeChat could
 * see the mode in `/status` but never change it.
 */
describe("结论模式: /final command", () => {
  /** Same harness as `makeBridge`, but wired to a real ConfigStore. */
  function makeStoredBridge(patch: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-finalcmd-"));
    const store = new ConfigStore(dir);
    const cfg = store.resolve(defaultConfig());
    cfg.storageDir = dir;
    cfg.finalOnly = false;
    cfg.finalOnlyIdleMs = IDLE_MS;
    cfg.finalOnlyCeilingMs = 60_000;
    Object.assign(cfg, patch);
    const ctx: any = { get: () => undefined, on: () => () => {} };
    const bridge = new WeChatDSHBridge(ctx, cfg, undefined, store);
    const state: any = (bridge as any).state;
    state.ensureUser("u1", "C:\\work");
    state.update("u1", { sessionId: "sess-A" });
    (bridge as any).token = { baseUrl: "https://x", token: "t" };
    live.push(bridge);
    return { bridge: bridge as any, dir, store };
  }

  const send = (bridge: any, text: string) =>
    bridge.handleMessage({
      message_type: MessageType.USER,
      from_user_id: "u1",
      context_token: "ct",
      item_list: [{ type: 1, text_item: { text } }],
    } as any);

  it("parses /final and /fo but leaves /f to /flush", () => {
    expect(parseFinalCommand("/final")).toEqual({ kind: "final", mode: "status" });
    expect(parseFinalCommand("/fo on")).toEqual({ kind: "final", mode: "on" });
    expect(parseFinalCommand("/final off")).toEqual({ kind: "final", mode: "off" });
    expect(parseFinalCommand("/final maybe")).toBeNull();
    expect(parseFinalCommand("/f")).toBeNull();
    expect(isBypassSlashCommand("/final on")).toBe(true);
    expect(isBypassSlashCommand("/fo")).toBe(true);
  });

  it("/final on switches the mode and persists it to config.json", async () => {
    const { bridge, dir } = makeStoredBridge();
    expect(bridge.finalOnlyEnabled()).toBe(false);

    await send(bridge, "/final on");
    await flushTicks();
    await sleep(10);

    expect(bridge.finalOnlyEnabled()).toBe(true);
    // Persisted, not just in-memory: a re-scan / restart must keep it.
    expect(new ConfigStore(dir).stored().finalOnly).toBe(true);
    expect(texts().some((t) => t.includes("结论模式已开启"))).toBe(true);
  });

  it("/final off switches back and delivers whatever was held", async () => {
    const { bridge, dir } = makeStoredBridge({ finalOnly: true, finalOnlyIdleMs: 60_000 });
    goalRound(bridge, 1, "关闭前暂存的结论");
    await flushTicks();
    // Still held: the idle window is 60s.
    expect(texts()).toHaveLength(0);

    await send(bridge, "/final off");
    await flushTicks();
    await sleep(10);

    expect(bridge.finalOnlyEnabled()).toBe(false);
    expect(new ConfigStore(dir).stored().finalOnly).toBe(false);
    // The hold is output the agent already produced — turning the mode off
    // hands it over instead of destroying it.
    expect(texts().some((t) => t.includes("关闭前暂存的结论"))).toBe(true);
  });

  it("/final status reports the mode and the held count", async () => {
    const { bridge } = makeStoredBridge({ finalOnlyIdleMs: 60_000 });
    await send(bridge, "/final");
    await flushTicks();
    await sleep(10);
    expect(texts().some((t) => t.includes("结论模式: off"))).toBe(true);

    sendTextMessage.mockClear();
    await send(bridge, "/final on");
    await flushTicks();
    await sleep(10);
    sendTextMessage.mockClear();

    goalRound(bridge, 1, "暂存中");
    await send(bridge, "/fo");
    await flushTicks();
    await sleep(10);
    const status = texts().find((t) => t.includes("结论模式: on"));
    expect(status).toBeDefined();
    expect(status).toContain("暂存 1 条");
  });

  it("with the mode on via /final, the 8-round flood is collapsed", async () => {
    const { bridge } = makeStoredBridge();
    await send(bridge, "/final on");
    await flushTicks();
    await sleep(10);
    sendTextMessage.mockClear();

    for (let round = 1; round <= 8; round += 1) {
      goalRound(bridge, round, `本轮进展（第 ${round}/8 轮）：…`);
    }
    await flushTicks();
    expect(texts()).toHaveLength(0);

    await sleep(IDLE_MS + 60);
    const delivered = texts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("第 8/8 轮");
    expect(delivered[0]).toContain("共 8 轮");
  });
});

/**
 * The user-facing docs must describe the switch that actually exists.
 *
 * README is the only place a WeChat-only user can discover `/final` before
 * typing it, and its command table is the canonical list `/help` mirrors. A
 * row that silently disappears (or that drifts back to advertising `/f` as
 * the alias — the one alias this command must NOT have) is the same class of
 * bug as a parser that no longer matches its help text.
 *
 * README is deliberately terse (see docs/DEVELOPMENT.md for the details), so
 * the `/f` exclusion is asserted where it is documented in full: the dev doc's
 * command table and the CHANGELOG.
 */
describe("结论模式: the docs describe /final", () => {
  const readDoc = (name: string) =>
    fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf-8");

  it("README lists the command with its alias", () => {
    const readme = readDoc("README.md");
    expect(readme).toContain("/final on\\|off\\|status");
    expect(readme).toContain("`/fo`");
  });

  it("the dev doc keeps the /f exclusion and the off-delivers-first semantics", () => {
    const dev = readDoc("docs/DEVELOPMENT.md");
    // `/f` belongs to /flush; a reader must not assume the obvious
    // abbreviation works.
    expect(dev).toMatch(/`\/f`\s*是\s*`\/flush`\s*的别名/);
    expect(dev).toContain("**不是** `/final` 的");
    expect(dev).toContain("先交付");
  });

  it("CHANGELOG records the command under the release that adds it", () => {
    const changelog = readDoc("CHANGELOG.md");
    expect(changelog).toContain("`/final on|off|status`（别名 `/fo`）");
    // The two deliberate semantics must stay documented, not just the syntax.
    expect(changelog).toContain("`/f` 不当别名");
    expect(changelog).toContain("先交付再关闭");
  });
});
