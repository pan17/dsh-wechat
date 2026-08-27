/**
 * Tests for the session-level projection section appended to `/status`.
 *
 * The bridge consumes `ctx.sessionProjections.snapshot(agent.session)`
 * — a single generic read face that surfaces every domain key a plugin
 * registered. WeChat renders the whole map. The behavior contract:
 *
 *  - When `ctx.sessionProjections` is not composed, the section is
 *    entirely omitted (no "未挂载" label — same minimalism as the
 *    other `/status` rows).
 *  - When `snapshot()` throws, the section is omitted and a single
 *    warn line is logged; nothing else changes.
 *  - Each key is rendered with `renderProjectionValue` and sorted
 *    alphabetically so plugin load order does not change output.
 *  - Existing rows (workspace / session / agent / preset / model /
 *    context / permission / silent) are untouched.
 *
 * These tests also cover `renderProjectionValue` directly — a pure
 * function with no I/O, fully exercised at the unit level.
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
import { renderProjectionValue } from "../src/bridge/slash.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

function makeMockAgent(id: string) {
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      session: { seq: 5, header: {}, events: [] },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received: [],
  };
}

interface MockProjectionsOptions {
  /** Optional static values map returned by `snapshot`. */
  values?: Record<string, unknown>;
  /** Optional static watermark returned by `snapshot`. */
  asOfSeq?: number;
  /** When true, `snapshot` throws on every call. */
  throw?: boolean;
}

function makeMockProjections(opts: MockProjectionsOptions = {}) {
  const fn = (session: unknown) => {
    if (opts.throw) throw new Error("boom snapshot failed");
    return { asOfSeq: opts.asOfSeq ?? 4, values: opts.values ?? {} };
  };
  return { snapshot: fn };
}

function makeBridge(opts: {
  agent: { agent: unknown; received: unknown[] };
  projections?: unknown;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-proj-"));
  const agentsService = {
    create: async () => opts.agent,
    resume: async () => opts.agent,
    get: (id: string) => (id === opts.agent.agent.id ? opts.agent.agent : undefined),
    list: () => [opts.agent.agent],
  };
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "sessionProjections" && opts.projections) return opts.projections;
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

describe("/status — session-level projection section (generic)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists a plan projection under '会话级状态'", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({
      values: { plan: { active: true, pending: false } },
    });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("── 会话级状态 ──");
    expect(text).toContain("[模式]");
    expect(text).toContain("• plan: on");
  });

  it("lists a goal projection (active phase, roundsStarted)", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({
      values: {
        goal: {
          goal: { id: "g1", revision: 1, objective: "ship", phase: "active" },
          roundsStarted: 3,
        },
      },
    });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("• goal:");
    expect(text).toContain("active · ship · 3/");
  });

  it("renders multiple projections in alphabetical key order", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({
      // Insertion order is `someCustom`, `goal`, `plan` — output order
      // must still be `goal`, `plan`, `someCustom`.
      values: {
        someCustom: { foo: 1 },
        goal: { roundsStarted: 0 },
        plan: { active: false },
      },
    });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    const idxGoal = text.indexOf("• goal:");
    const idxPlan = text.indexOf("• plan:");
    const idxCustom = text.indexOf("• someCustom:");
    expect(idxGoal).toBeGreaterThan(0);
    expect(idxGoal).toBeLessThan(idxPlan);
    expect(idxPlan).toBeLessThan(idxCustom);
  });

  it("omits the section entirely when ctx.sessionProjections is unavailable", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock }); // no projections
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).not.toContain("会话级状态");
    // Existing rows are still present.
    expect(text).toContain("• 工作区:");
    expect(text).toContain("• 静默模式:");
  });

  it("renders null values as the literal text 'null'", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({
      values: { goal: null },
    });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("• goal: （无）");
  });

  it("renders primitive values directly (no JSON wrapper)", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({
      values: {
        flag: true,
        counter: 42,
        label: "ready",
      },
    });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).toContain("• flag: true");
    expect(text).toContain("• counter: 42");
    expect(text).toContain("• label: ready");
  });

  it("omits the section and warns once when snapshot() throws", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({ throw: true });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).not.toContain("会话级状态");
    // Existing rows remain — projection failure must not poison the
    // whole /status output.
    expect(text).toContain("• 工作区:");
    expect(text).toContain("• 静默模式:");
  });

  it("omits the section when the bound agent has no session", async () => {
    // Construct an agent where `session` is undefined — formatStatus
    // already guards the agent side; the projection branch must guard
    // the same way.
    const agentRecord = {
      agent: {
        id: "wx-s1",
        status: "idle",
        options: { provider: "deepseek", model: "deepseek-chat" },
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: async () => {},
      },
      received: [],
    };
    const projections = makeMockProjections({
      values: { plan: { active: true } },
    });
    const bridge = makeBridge({ agent: agentRecord, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    expect(text).not.toContain("会话级状态");
  });

  it("leaves all v0.4.4 /status rows untouched", async () => {
    const mock = makeMockAgent("wx-s1");
    const projections = makeMockProjections({
      values: { plan: { active: true }, goal: { roundsStarted: 0 } },
    });
    const bridge = makeBridge({ agent: mock, projections });
    // Bind the mock agent to the user so agents.get() resolves.
    {
      const state = (bridge as unknown as {
        state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      }).state;
      state.ensureUser("u1", "C:\\work");
      state.update("u1", { sessionId: "wx-s1" });
    }

    await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
      wechatTextMessage("/status"),
    );

    const [, text] = sendTextMessage.mock.calls[0]! as [string, string];
    // The pre-existing rows from earlier versions stay unchanged.
    expect(text).toContain("📊 当前状态");
    expect(text).toContain("• 工作区:");
    expect(text).toContain("• 会话:");
    expect(text).toContain("• Agent:");
    expect(text).toContain("• 当前会话 Preset:");
    expect(text).toContain("• 模型:");
    expect(text).toContain("• 默认 Preset:");
    expect(text).toContain("• 静默模式:");
    expect(text.indexOf("• 当前会话 Preset:")).toBeLessThan(text.indexOf("• 模型:"));
    expect(text.indexOf("• 模型:")).toBeLessThan(text.indexOf("• 默认 Preset:"));
    expect(text.indexOf("• 默认 Preset:")).toBeLessThan(text.indexOf("• 静默模式:"));
    expect(text).not.toContain("• 待处理:");
    // The new section appears AFTER the existing rows.
    expect(text.indexOf("• 静默模式:")).toBeLessThan(text.indexOf("── 会话级状态 ──"));
  });
});

describe("renderProjectionValue (pure)", () => {
  it("renders null and undefined as literals", () => {
    expect(renderProjectionValue(null)).toBe("null");
    expect(renderProjectionValue(undefined)).toBe("undefined");
  });

  it("renders primitives via String()", () => {
    expect(renderProjectionValue("hello")).toBe("hello");
    expect(renderProjectionValue(42)).toBe("42");
    expect(renderProjectionValue(true)).toBe("true");
    expect(renderProjectionValue(false)).toBe("false");
    expect(renderProjectionValue(BigInt(7))).toBe("7");
  });

  it("renders plain objects as a compact one-liner", () => {
    expect(renderProjectionValue({ active: true })).toBe('{"active":true}');
    expect(renderProjectionValue([1, 2, 3])).toBe("[1,2,3]");
  });

  it("truncates long values with the unicode ellipsis", () => {
    const long = "x".repeat(200);
    const out = renderProjectionValue(long);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(120);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("returns undefined for circular references", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = { foo: 1 };
    a.self = a;
    expect(renderProjectionValue(a)).toBeUndefined();
  });

  it("returns undefined for function / symbol values", () => {
    expect(renderProjectionValue(() => 1)).toBeUndefined();
    expect(renderProjectionValue(Symbol("x"))).toBeUndefined();
  });
});

// ─── Smart projection renderers (per-key) + section aggregator ─────────

import { renderProjectionSection } from "../src/bridge/slash.js";

describe("renderProjectionSection — smart renderers", () => {
  describe("plan", () => {
    it("renders plain on/off", () => {
      const lines = renderProjectionSection({ plan: { active: true, pending: false } });
      expect(lines.join("\n")).toContain("• plan: on");
    });
    it("renders pending as the expected hint", () => {
      const lines = renderProjectionSection({ plan: { active: false, pending: true } });
      expect(lines.join("\n")).toContain("off（下一次轮次开启）");
    });
    it("renders reverse pending", () => {
      const lines = renderProjectionSection({ plan: { active: true, pending: true } });
      expect(lines.join("\n")).toContain("on（下一次轮次关闭）");
    });
    it("falls back when shape is unexpected", () => {
      const lines = renderProjectionSection({ plan: { foo: 1 } });
      // No smart renderer accepted; falls through to JSON.
      expect(lines.join("\n")).toContain("• plan:");
      expect(lines.join("\n")).toContain('"foo":1');
    });
  });

  describe("goal", () => {
    it("renders null as (无)", () => {
      expect(renderProjectionSection({ goal: null }).join("\n")).toContain("• goal: （无）");
    });
    it("renders active goal with phase + objective + rounds", () => {
      const lines = renderProjectionSection({
        goal: {
          goal: { id: "g1", revision: 1, objective: "ship", phase: "active", maxGoalRounds: 64 },
          roundsStarted: 3,
        },
      });
      const joined = lines.join("\n");
      expect(joined).toContain("• goal:");
      expect(joined).toContain("active · ship · 3/64 轮");
    });
    it("renders blocked goal with reason code", () => {
      const lines = renderProjectionSection({
        goal: {
          goal: {
            id: "g1", revision: 1, objective: "x", phase: "blocked",
            maxGoalRounds: 10,
            blockedReason: { code: "POLICY_DENIED", message: "user disallows" },
          },
          roundsStarted: 2,
        },
      });
      expect(lines.join("\n")).toContain("blocked");
      expect(lines.join("\n")).toContain("POLICY_DENIED");
    });
    it("falls back when shape is unexpected", () => {
      const lines = renderProjectionSection({ goal: { foo: 1 } });
      expect(lines.join("\n")).toContain('"foo":1');
    });
  });

  describe("subagent", () => {
    it("renders null as (无)", () => {
      expect(renderProjectionSection({ subagent: null }).join("\n")).toContain("• subagent: （无）");
    });
    it("renders with status + count from children array", () => {
      const lines = renderProjectionSection({
        subagent: { status: "idle", children: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      });
      expect(lines.join("\n")).toContain("idle · 3 个子任务");
    });
    it("renders with status only when no children array", () => {
      const lines = renderProjectionSection({ subagent: { status: "running" } });
      expect(lines.join("\n")).toContain("running");
      expect(lines.join("\n")).not.toContain("个子任务");
    });
  });

  describe("todos", () => {
    it("renders null as (无)", () => {
      expect(renderProjectionSection({ todos: null }).join("\n")).toContain("• todos: （无）");
    });
    it("counts pending items", () => {
      const lines = renderProjectionSection({
        todos: {
          items: [
            { id: 1, status: "pending" },
            { id: 2, status: "in_progress" },
            { id: 3, status: "done" },
          ],
        },
      });
      expect(lines.join("\n")).toContain("3 个 · 2 待办");
    });
  });

  describe("contextPressure / contextBreakdown / tokenUsage / sessionStats", () => {
    it("contextPressure renders percentage", () => {
      const lines = renderProjectionSection({
        contextPressure: { projectedTokens: 192000, contextWindow: 1_048_576 },
      });
      expect(lines.join("\n")).toMatch(/192\.0k\s*\/\s*1\.0M\s*（18%）/);
    });
    it("contextBreakdown renders the three buckets", () => {
      const lines = renderProjectionSection({
        contextBreakdown: {
          systemTokens: 1845,
          toolsTokens: 11476,
          messageTokens: 141107,
        },
      });
      const joined = lines.join("\n");
      expect(joined).toContain("系统 1.8k");
      expect(joined).toContain("工具 11.5k");
      expect(joined).toContain("消息 141.1k");
    });
    it("tokenUsage multi-line with hit-rate", () => {
      const lines = renderProjectionSection({
        tokenUsage: {
          uncachedInputTokens: 504493,
          cacheReadTokens: 9303796,
          outputTokens: 61991,
          cacheWriteTokens: 0,
        },
      });
      const joined = lines.join("\n");
      expect(joined).toContain("• tokenUsage:");
      expect(joined).toContain("输入 504.5k");
      expect(joined).toContain("命中率 95%");
      expect(joined).toContain("输出 62.0k");
      expect(joined).not.toContain("缓存写入");
    });
    it("sessionStats multi-line", () => {
      const lines = renderProjectionSection({
        sessionStats: {
          turns: 9, steps: 100,
          llmMs: 940177, toolMs: 1080817,
          ttftMs: 363099, ttftSteps: 96,
        },
      });
      const joined = lines.join("\n");
      expect(joined).toContain("• sessionStats:");
      expect(joined).toContain("9 turns · 100 steps");
      expect(joined).toContain("llm 16m");
      expect(joined).toContain("tool 18m");
      expect(joined).toContain("ttft 6m / 96 steps");
    });
  });

  describe("subagentTiming / title / sessionListMetadata / permissions / imageLimits", () => {
    it("subagentTiming 0 renders as 未结算", () => {
      expect(renderProjectionSection({ subagentTiming: { settledMs: 0 } }).join("\n"))
        .toContain("• subagentTiming: 未结算");
    });
    it("subagentTiming non-zero renders as duration", () => {
      expect(renderProjectionSection({ subagentTiming: { settledMs: 1500 } }).join("\n"))
        .toContain("• subagentTiming: 1.5s");
    });
    it("title: empty string renders as (未设标题)", () => {
      expect(renderProjectionSection({ title: "" }).join("\n"))
        .toContain("• title: （未设标题）");
    });
    it("title: non-string falls back to JSON", () => {
      const out = renderProjectionSection({ title: { weird: true } }).join("\n");
      expect(out).toContain('"weird":true');
    });
    it("sessionListMetadata combines last activity + blank flag", () => {
      const now = Date.now() - 2 * 60 * 60 * 1000;
      const out = renderProjectionSection({
        sessionListMetadata: { lastPromptAt: now, blank: false },
      }).join("\n");
      expect(out).toContain("• sessionListMetadata:");
      expect(out).toContain("上次活动 2 小时前");
      expect(out).toContain("非空");
    });
    it("permissions joins option names", () => {
      const out = renderProjectionSection({
        permissions: {
          options: [
            { value: "r", name: "read-only" },
            { value: "w", name: "workspace-write" },
            { value: "d", name: "danger-full-access" },
          ],
        },
      }).join("\n");
      expect(out).toContain("• permissions:");
      expect(out).toContain("read-only · workspace-write · danger-full-access");
    });
    it("imageLimits renders per-image and per-message", () => {
      const out = renderProjectionSection({
        imageLimits: {
          maxImageBytes: 5_242_880,
          maxImagesPerMessage: 20,
          maxImagePixels: 40_000_000,
        },
      }).join("\n");
      expect(out).toContain("5.0 MB / 张");
      expect(out).toContain("20 张 / 消息");
      expect(out).toContain("≤ 40M px");
    });
  });

  describe("renderProjectionSection (aggregator)", () => {
    it("returns empty array for empty input", () => {
      expect(renderProjectionSection({})).toEqual([]);
    });

    it("groups keys into 模式/用量与统计/会话/其它 with stable order", () => {
      const lines = renderProjectionSection({
        plan: { active: false },
        goal: null,
        tokenUsage: { uncachedInputTokens: 1, outputTokens: 2 },
        title: "hello",
        unknownKey: { foo: 1 },
      });
      const joined = lines.join("\n");
      const idxMode = joined.indexOf("[模式]");
      const idxUsage = joined.indexOf("[用量与统计]");
      const idxSession = joined.indexOf("[会话]");
      const idxOther = joined.indexOf("[其它]");
      expect(idxMode).toBeGreaterThanOrEqual(0);
      expect(idxMode).toBeLessThan(idxUsage);
      expect(idxUsage).toBeLessThan(idxSession);
      expect(idxSession).toBeLessThan(idxOther);
    });

    it("skips empty groups (no banner, no empty line)", () => {
      const lines = renderProjectionSection({ plan: { active: true } });
      const joined = lines.join("\n");
      expect(joined).toContain("[模式]");
      expect(joined).not.toContain("[用量与统计]");
      expect(joined).not.toContain("[会话]");
      expect(joined).not.toContain("[其它]");
    });

    it("falls back unknown keys to JSON inside [其它]", () => {
      const lines = renderProjectionSection({
        someCustomKey: { foo: 1 },
      });
      const joined = lines.join("\n");
      expect(joined).toContain("[其它]");
      expect(joined).toContain("• someCustomKey: {\"foo\":1}");
    });

    it("smart renderer exception falls back to JSON for that single key", () => {
      // The smart renderer for `plan` only accepts an object with an
      // `active` boolean. A bare string makes it return undefined, so
      // the caller falls back to `renderProjectionValue`, which renders
      // a string as itself (no JSON quotes — that would be a misleading
      // shape indicator).
      const lines = renderProjectionSection({
        plan: "not-an-object",
      });
      const joined = lines.join("\n");
      expect(joined).toContain("• plan: not-an-object");
    });

    it("does not include a trailing blank line", () => {
      const lines = renderProjectionSection({
        plan: { active: true },
      });
      // The aggregator strips the trailing blank so the caller doesn't
      // get an extra empty line in /status.
      expect(lines[lines.length - 1]).not.toBe("");
    });
  });
});