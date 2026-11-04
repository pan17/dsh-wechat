/**
 * `/status` 的「会话级状态」详细程度 + `[后台任务]` 段。
 *
 * 两件事在这里钉住：
 *
 *  1. `statusMode`（`brief` / `full`，默认 `brief`）只影响 `/status` 末尾那一段。
 *     `brief` 只出 `[模式]`，`full` 出四段全量；上面的工作区/会话/模型等行
 *     两种模式一模一样——一个"顺手把老行也精简了"的改动必须在这里失败。
 *  2. `[后台任务]` 只统计**当前会话**的后台任务：别的会话的任务、以及不属于
 *     任何会话的无主任务，都不计数也不展示；一个任务都没有时整段不出现
 *     （不留 `共 0 个` 占位）。
 *
 * 纯函数部分（`renderProjectionSection` / `renderBackgroundJobsSection`）直接
 * 断言输出；桥接部分走一次真实的 `/status`，用一个假的 `ctx.jobs` 记录
 * `list()` 收到的 caller 参数——那是"只问当前会话"这条口径的唯一证据。
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
import {
  BACKGROUND_JOB_DETAIL_MAX,
  parseStatusCommand,
  renderBackgroundJobsSection,
  renderProjectionSection,
  type BackgroundJobView,
} from "../src/bridge/slash.js";
import { defaultConfig, type StatusMode } from "../src/config.js";
import { ConfigStore } from "../src/config-store.js";
import { MessageType } from "../src/weixin/types.js";

// ─── harness ──────────────────────────────────────────────────────────────

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

/** Values map with one key in every bucket, so mode filtering is visible. */
const FULL_VALUES: Record<string, unknown> = {
  plan: { active: true },
  goal: { roundsStarted: 0 },
  tokenUsage: { uncachedInputTokens: 100, outputTokens: 20 },
  title: "hello",
  someCustom: { foo: 1 },
};

interface JobSpec {
  id: string;
  kind?: string;
  label: string;
  owner?: string;
  status?: string;
  progress?: string;
  startedAt?: number;
}

function jobView(spec: JobSpec) {
  return {
    id: spec.id,
    kind: spec.kind ?? "bash",
    label: spec.label,
    ...(spec.owner === undefined ? {} : { owner: spec.owner }),
    status: spec.status ?? "running",
    ...(spec.progress === undefined ? {} : { progress: spec.progress }),
    startedAt: spec.startedAt ?? 1_000,
    output: { total: 0, earliest: 0 },
  };
}

interface BridgeOptions {
  sessionId?: string;
  statusMode?: StatusMode;
  values?: Record<string, unknown>;
  /** Jobs the fake registry returns for ANY caller (the host fences, we don't). */
  jobs?: JobSpec[];
  /** Omit the `jobs` service entirely (a minimal headless profile). */
  noJobsService?: boolean;
  /** Make `jobs.list` throw. */
  jobsThrow?: boolean;
  /** Omit `sessionProjections` entirely. */
  noProjections?: boolean;
}

interface Harness {
  bridge: WeChatDSHBridge;
  /** Every `caller` argument `jobs.list` received. */
  jobListCallers: Array<string | undefined>;
  dir: string;
}

function makeBridge(opts: BridgeOptions = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-status-mode-"));
  const sessionId = opts.sessionId ?? "wx-s1";
  const mock = makeMockAgent(sessionId);

  const agentsService = {
    create: async () => mock,
    resume: async () => mock,
    get: (id: string) => (id === mock.agent.id ? mock.agent : undefined),
    list: () => [mock.agent],
  };

  const projections = {
    snapshot: () => ({ asOfSeq: 4, values: opts.values ?? FULL_VALUES }),
  };

  const jobListCallers: Array<string | undefined> = [];
  const jobsService = {
    list: (caller?: string) => {
      jobListCallers.push(caller);
      if (opts.jobsThrow) throw new Error("boom jobs.list failed");
      return (opts.jobs ?? []).map(jobView);
    },
  };

  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "sessionProjections" && !opts.noProjections) return projections;
      if (name === "jobs" && !opts.noJobsService) return jobsService;
      return undefined;
    },
    on: () => () => {},
  };

  const cfg = defaultConfig();
  cfg.storageDir = dir;
  if (opts.statusMode) cfg.statusMode = opts.statusMode;
  // A real ConfigStore over the throwaway dir: `/status brief|full` persists
  // through it exactly as it does in production (`bridge.persistEditable`).
  const configStore = new ConfigStore(dir);
  const bridge = new WeChatDSHBridge(ctx, configStore.resolve(cfg), undefined, configStore);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };

  const stateApi = bridge as unknown as {
    state: {
      ensureUser(u: string, c: string): unknown;
      update(u: string, p: unknown): void;
    };
  };
  stateApi.state.ensureUser("u1", "C:\\work");
  // An explicitly unbound user (sessionId "") is how "no current session"
  // is spelled in state, so honour it instead of always binding.
  if (sessionId) stateApi.state.update("u1", { sessionId });

  return { bridge, jobListCallers, dir };
}

function wechatTextMessage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function runStatus(harness: Harness, text = "/status"): Promise<string> {
  await (harness.bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
    wechatTextMessage(text),
  );
  const calls = sendTextMessage.mock.calls;
  const last = calls[calls.length - 1]! as [string, string];
  return last[1];
}

// ─── 纯函数：投影分段 ─────────────────────────────────────────────────────

describe("renderProjectionSection — 简洁 / 详细", () => {
  it("brief 只出 [模式]，四段里的其余三段一律不出现", () => {
    const joined = renderProjectionSection(FULL_VALUES, { mode: "brief" }).join("\n");
    expect(joined).toContain("[模式]");
    expect(joined).toContain("• plan: on");
    expect(joined).toContain("• goal:");
    expect(joined).not.toContain("[用量与统计]");
    expect(joined).not.toContain("[会话]");
    expect(joined).not.toContain("[其它]");
    expect(joined).not.toContain("• tokenUsage:");
    expect(joined).not.toContain("• someCustom:");
  });

  it("full 四段全出", () => {
    const joined = renderProjectionSection(FULL_VALUES, { mode: "full" }).join("\n");
    for (const banner of ["[模式]", "[用量与统计]", "[会话]", "[其它]"]) {
      expect(joined).toContain(banner);
    }
  });

  it("省略 mode 时按 full 渲染（既有调用方行为不变）", () => {
    expect(renderProjectionSection(FULL_VALUES)).toEqual(
      renderProjectionSection(FULL_VALUES, { mode: "full" }),
    );
  });

  it("brief 且没有 [模式] 的 key 时返回空数组（不留空标题）", () => {
    const lines = renderProjectionSection({ tokenUsage: { outputTokens: 1 }, title: "x" }, { mode: "brief" });
    expect(lines).toEqual([]);
  });

  it("brief 不会因为非 mode 段的坏渲染器打出 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A getter that throws proves the key is never even read in brief mode.
      const values: Record<string, unknown> = { plan: { active: true } };
      Object.defineProperty(values, "someCustom", {
        enumerable: true,
        get() {
          throw new Error("should not be read in brief mode");
        },
      });
      expect(() => renderProjectionSection(values, { mode: "brief" })).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 纯函数：后台任务段 ───────────────────────────────────────────────────

function bgJob(overrides: Partial<BackgroundJobView> = {}): BackgroundJobView {
  return {
    id: "bash-1",
    kind: "bash",
    label: "npm run build",
    status: "running",
    startedAt: 0,
    ...overrides,
  };
}

describe("renderBackgroundJobsSection", () => {
  it("一个任务都没有时整段不出现（不留 `共 0 个` 占位）", () => {
    expect(renderBackgroundJobsSection([])).toEqual([]);
  });

  it("有任务但都不在跑时只出一行计数，不列明细", () => {
    const lines = renderBackgroundJobsSection([
      bgJob({ id: "bash-1", status: "completed" }),
      bgJob({ id: "bash-2", status: "failed" }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("[后台任务]");
    expect(joined).toContain("• ⚪ 共 2 个");
    expect(joined).not.toContain("▶");
    expect(joined).not.toContain("运行中");
  });

  it("运行中 > 0 时出 🟢 计数与每条明细（含进度与已运行时长）", () => {
    const lines = renderBackgroundJobsSection(
      [
        bgJob({ id: "bash-1", label: "npm run build", startedAt: 0 }),
        bgJob({ id: "bash-2", label: "vitest --watch", progress: "编译中", startedAt: 90_000 }),
        bgJob({ id: "bash-3", label: "done already", status: "completed" }),
      ],
      120_000,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("• 🟢 共 3 个 · 运行中 2 个");
    expect(joined).toContain("▶ bash · npm run build（已运行 2m）");
    expect(joined).toContain("▶ bash · vitest --watch（已运行 30s） · 编译中");
    expect(joined).not.toContain("done already");
  });

  it("stopping 也算运行中（还在收尾，用户需要看见）", () => {
    const joined = renderBackgroundJobsSection([bgJob({ status: "stopping" })], 1_000).join("\n");
    expect(joined).toContain("运行中 1 个");
    expect(joined).toContain("▶ bash ·");
  });

  it("运行中按开始时间升序，跑得最久的排最前", () => {
    const joined = renderBackgroundJobsSection(
      [
        bgJob({ id: "bash-new", label: "new", startedAt: 900_000 }),
        bgJob({ id: "bash-old", label: "old", startedAt: 1_000 }),
      ],
      1_000_000,
    ).join("\n");
    expect(joined.indexOf("· old")).toBeLessThan(joined.indexOf("· new"));
  });

  it(`明细最多 ${BACKGROUND_JOB_DETAIL_MAX} 行，其余合成一句`, () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      bgJob({ id: `bash-${i}`, label: `task-${i}`, startedAt: i * 1_000 }),
    );
    const lines = renderBackgroundJobsSection(many, 100_000);
    const details = lines.filter((line) => line.includes("▶"));
    expect(details).toHaveLength(BACKGROUND_JOB_DETAIL_MAX);
    expect(lines.join("\n")).toContain(`… 另有 ${8 - BACKGROUND_JOB_DETAIL_MAX} 个运行中`);
  });

  it("超长 label 被裁剪，不会把一行撑成一面墙", () => {
    const joined = renderBackgroundJobsSection([bgJob({ label: "x".repeat(300) })], 1_000).join("\n");
    for (const line of joined.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(400);
    }
    expect(joined).toContain("…");
  });

  it("缺 label / kind 时退回 id，不出现 undefined", () => {
    const joined = renderBackgroundJobsSection([
      { id: "bash-9", kind: "", label: "", status: "running" },
    ], 1_000).join("\n");
    expect(joined).toContain("bash-9");
    expect(joined).not.toContain("undefined");
  });
});

// ─── 桥接：/status 两种模式 ───────────────────────────────────────────────

describe("/status — statusMode 生效", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("默认简洁：只出 [模式] 与 [后台任务]", async () => {
    const harness = makeBridge({ jobs: [jobView({ id: "bash-1", label: "npm run build", owner: "wx-s1" })] });
    const text = await runStatus(harness);
    expect(text).toContain("── 会话级状态 ──");
    expect(text).toContain("[模式]");
    expect(text).toContain("[后台任务]");
    expect(text).not.toContain("[用量与统计]");
    expect(text).not.toContain("[会话]");
    expect(text).not.toContain("[其它]");
    expect(text).not.toContain("• tokenUsage:");
  });

  it("详细：四段全出，且 [后台任务] 排在最后", async () => {
    const harness = makeBridge({
      statusMode: "full",
      jobs: [jobView({ id: "bash-1", label: "npm run build", owner: "wx-s1" })],
    });
    const text = await runStatus(harness);
    for (const banner of ["[模式]", "[用量与统计]", "[会话]", "[其它]", "[后台任务]"]) {
      expect(text).toContain(banner);
    }
    const idxOther = text.indexOf("[其它]");
    const idxJobs = text.indexOf("[后台任务]");
    expect(idxJobs).toBeGreaterThan(idxOther);
  });

  it("两种模式都保留上面那些老行", async () => {
    for (const statusMode of ["brief", "full"] as const) {
      vi.clearAllMocks();
      const harness = makeBridge({ statusMode });
      const text = await runStatus(harness);
      for (const row of ["📊 当前状态", "• 工作区:", "• 会话:", "• 模型:", "• 工作步骤:", "• 跨会话任务完成提醒:"]) {
        expect(text, `${statusMode}: ${row}`).toContain(row);
      }
    }
  });

  it("投影读不到时仍出 [后台任务]", async () => {
    const harness = makeBridge({
      noProjections: true,
      jobs: [jobView({ id: "bash-1", label: "npm run build", owner: "wx-s1" })],
    });
    const text = await runStatus(harness);
    expect(text).toContain("── 会话级状态 ──");
    expect(text).toContain("[后台任务]");
    expect(text).not.toContain("[模式]");
  });
});

// ─── 桥接：后台任务的统计口径 ─────────────────────────────────────────────

describe("[后台任务] 只统计当前会话的任务", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("别的会话的任务与无主任务都不计数、不展示", async () => {
    const harness = makeBridge({
      sessionId: "wx-s1",
      jobs: [
        jobView({ id: "bash-mine-1", label: "我的构建", owner: "wx-s1" }),
        jobView({ id: "bash-mine-2", label: "我的测试", owner: "wx-s1", status: "completed" }),
        jobView({ id: "bash-other", label: "别人的任务", owner: "wx-other" }),
        jobView({ id: "bash-orphan", label: "无主任务" }),
      ],
    });
    const text = await runStatus(harness);
    expect(text).toContain("• 🟢 共 2 个 · 运行中 1 个");
    expect(text).toContain("我的构建");
    expect(text).not.toContain("别人的任务");
    expect(text).not.toContain("无主任务");
  });

  it("只问一次，且问的是当前会话（host 的 owner fence 才有意义）", async () => {
    const harness = makeBridge({ sessionId: "wx-s1", jobs: [] });
    await runStatus(harness);
    expect(harness.jobListCallers).toEqual(["wx-s1"]);
  });

  it("没有绑定会话时整段省略，且根本不调 jobs.list", async () => {
    const harness = makeBridge({ sessionId: "", jobs: [jobView({ id: "bash-1", label: "x", owner: "wx-s1" })] });
    const text = await runStatus(harness);
    expect(text).not.toContain("[后台任务]");
    expect(harness.jobListCallers).toEqual([]);
  });

  it("0 个任务时整段不出现，不留一行 `共 0 个` 占位", async () => {
    const harness = makeBridge({ jobs: [] });
    const text = await runStatus(harness);
    expect(text).not.toContain("[后台任务]");
    expect(text).not.toContain("共 0 个");
    // The projection section is still there — only the jobs block is gone.
    expect(text).toContain("[模式]");
  });

  it("没有 jobs 服务时整段省略，也不出现「未挂载」", async () => {
    const harness = makeBridge({ noJobsService: true });
    const text = await runStatus(harness);
    expect(text).not.toContain("[后台任务]");
    expect(text).not.toContain("未挂载");
    // The projection section still renders.
    expect(text).toContain("[模式]");
  });

  it("jobs.list 抛错时 /status 照常返回", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = makeBridge({ jobsThrow: true });
      const text = await runStatus(harness);
      expect(text).toContain("📊 当前状态");
      expect(text).toContain("[模式]");
      expect(text).not.toContain("[后台任务]");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 桥接：/status brief | full 切换 ─────────────────────────────────────

describe("/status brief | full — 切换并持久化", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parseStatusCommand 认识两种写法，其它参数仍然不认", () => {
    expect(parseStatusCommand("/status")).toEqual({ kind: "status" });
    expect(parseStatusCommand("/status brief")).toEqual({ kind: "status", mode: "brief" });
    expect(parseStatusCommand("/status full")).toEqual({ kind: "status", mode: "full" });
    expect(parseStatusCommand("  /STATUS   FULL  ")).toEqual({ kind: "status", mode: "full" });
    expect(parseStatusCommand("/status now")).toBeNull();
    expect(parseStatusCommand("/status briefly")).toBeNull();
  });

  it("/status full 切换后当次就按详细渲染", async () => {
    const harness = makeBridge();
    const text = await runStatus(harness, "/status full");
    expect(text).toContain("已切换为详细");
    expect(text).toContain("[后台任务]"); // the confirmation names the block
    expect(text).toContain("[用量与统计]");
    expect(text).toContain("[其它]");
  });

  it("/status brief 切回来，并写进 config.json", async () => {
    const harness = makeBridge({ statusMode: "full" });
    const text = await runStatus(harness, "/status brief");
    expect(text).toContain("已切换为简洁");
    expect(text).toContain("[后台任务]");
    expect(text).not.toContain("[用量与统计]");

    // Persisted: a fresh store over the same directory sees the value, which
    // is the same contract `/steps` has (survives a re-scan).
    const store = new ConfigStore(harness.dir);
    expect(store.stored().statusMode).toBe("brief");
    expect(store.resolve(defaultConfig()).statusMode).toBe("brief");
  });

  it("裸 /status 不写配置（只是看一眼，不改设置）", async () => {
    const harness = makeBridge();
    await runStatus(harness);
    const store = new ConfigStore(harness.dir);
    expect(store.stored().statusMode).toBeUndefined();
  });
});
