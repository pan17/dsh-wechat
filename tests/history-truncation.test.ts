/**
 * `/history` 渲染与桥接：按轮次回看，与 `/fork` 同一套折叠。
 *
 * 三件事在这里钉住：
 *   1. 每轮一行只有「你的提示词 → 该轮最终回复」，过程中间的助手消息不出现；
 *   2. **末轮全文、其余简写**（30/50 字 + `…`）——旧版「最近一条助手消息不截断」
 *      的等价物，只是现在连提问也一起给全；
 *   3. 编号是全表行号（1…N），窗口只影响显示，所以 `/history show 25` 在只印 5 行时
 *      照样能到第 25 轮。
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
import {
  renderForkList,
  renderHistoryDetail,
  renderHistoryList,
  type TurnView,
} from "../src/bridge/slash.js";
import { DshOps } from "../src/dsh/ops.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

type Ev = { type: string; time?: number; data?: unknown; seq?: number };

const turnStart = (seq: number, turn: number): Ev => ({ type: "turn/start", seq, time: seq * 1000, data: { turn } });
const turnEnd = (seq: number, turn: number): Ev => ({ type: "turn/end", seq, time: seq * 1000, data: { turn } });
const userMessage = (seq: number, text: string, kind = "user"): Ev => ({
  type: "user/message",
  seq,
  time: seq * 1000,
  data: { id: `m-${seq}`, role: "user", content: [{ type: "text", text }], source: { kind } },
});
const assistantMessage = (seq: number, text: string): Ev => ({
  type: "assistant/message",
  seq,
  time: seq * 1000,
  data: { message: { role: "assistant", content: [{ type: "text", text }] } },
});

/** Turn 1 has an intermediate assistant message; turn 2 is still running. */
const TWO_TURNS: Ev[] = [
  turnStart(0, 1),
  userMessage(1, "帮我看看登录逻辑"),
  assistantMessage(2, "先读一下代码"),
  assistantMessage(3, "已把 token 刷新挪到拦截器"),
  turnEnd(4, 1),
  turnStart(5, 2),
  userMessage(6, "继续优化"),
  assistantMessage(7, "正在处理"),
];

/**
 * A turn as `/history` renders it, without going through a log.
 *
 * No timestamps by default: the layout cases below assert the row text, and the
 * two clocks get their own dedicated case.
 */
const view = (prompt: string, reply: string, endSeq?: number): TurnView => ({
  prompt,
  reply,
  ...(endSeq === undefined ? {} : { endSeq }),
});

/** A turn with both clocks set (ms ago). */
const timedView = (
  prompt: string,
  reply: string,
  endSeq: number,
  promptAgoMs: number,
  replyAgoMs: number,
): TurnView => ({
  prompt,
  reply,
  endSeq,
  promptTime: Date.now() - promptAgoMs,
  replyTime: Date.now() - replyAgoMs,
});

// ─── Rendering ──────────────────────────────────────────────────────────────

describe("renderHistoryList", () => {
  it("prints one numbered row per turn: prompt → final reply", () => {
    const text = renderHistoryList([view("第一问", "第一答", 1), view("第二问", "第二答", 2)]);
    expect(text).toContain("📜 会话轮次（共 2 轮）");
    expect(text).toContain("1. 👤 第一问 → 🤖 第一答");
    // The newest turn is the full block, not a row.
    expect(text).toContain("2. 👤 你\n\n第二问");
    expect(text).toContain("🤖 助手\n\n第二答");
  });

  it("stamps both sides with their own clock, in a row and in the last block", () => {
    const text = renderHistoryList([
      timedView("旧问题", "旧回答", 1, 7_200_000, 7_100_000),
      timedView("新问题", "新回答", 2, 120_000, 60_000),
    ]);
    // Preview row: the stamp sits BEFORE each side, so a `…` preview never
    // swallows it.
    expect(text).toContain("1. 👤 2 小时前 · 旧问题 → 🤖 1 小时前 · 旧回答");
    // Last block: each label carries its own stamp.
    expect(text).toContain("2. 👤 你 · 2 分钟前");
    expect(text).toContain("🤖 助手 · 1 分钟前");
  });

  it("omits a missing stamp instead of printing 未知时间", () => {
    const text = renderHistoryList([view("在做", "", undefined)]);
    expect(text).toContain("🤖 助手\n\n（进行中）");
    expect(text).not.toContain("未知时间");
  });

  it("separates every block with a blank line so WeChat cannot glue them", () => {
    // A single `\n` is a SOFT break once WeChat parses the message as markdown
    // (one `**bold**` in a reply is enough): it renders as a SPACE, which is
    // exactly how `🤖 助手` and `看全文: …` ended up welded onto the reply on
    // desktop WeChat. Blank lines are paragraph breaks under both renderers.
    const text = renderHistoryList([
      view("第一问", "**加粗**的回答", 1),
      view("第二问", "**加粗**的最新回答", 2),
    ]);
    expect(text).toContain("第二问\n\n🤖 助手\n\n**加粗**的最新回答\n\n看全文: /history show 2");
    // Never a SINGLE newline before a block (that is the soft break WeChat
    // collapses into a space).
    expect(text).not.toMatch(/[^\n]\n🤖 助手/);
    expect(text).not.toMatch(/[^\n]\n看全文/);
  });

  it("separates /fork list rows the same way", () => {
    // Same failure mode, same fix: a preview that happens to carry `**` must
    // not weld row 1 onto row 2.
    const text = renderForkList([view("第一问", "**加粗**的回答", 1), view("第二问", "第二答", 2)]);
    expect(text).toContain("🤖 **加粗**的回答\n\n2. 👤 第二问");
  });

  it("prints the newest turn in full and previews the older ones", () => {
    const longPrompt = "老".repeat(60);
    const longReply = "旧".repeat(120);
    const newestPrompt = "最新一轮的完整提问".repeat(8);
    const newestReply = "最新一轮的完整回复".repeat(20);
    const text = renderHistoryList([
      view(longPrompt, longReply, 1),
      view(newestPrompt, newestReply, 2),
    ]);
    const rows = text.split("\n").filter((line) => line.startsWith("1. "));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("…");
    // The newest turn is not truncated: naming the last turn means reading it.
    expect(text).toContain(newestPrompt);
    expect(text).toContain(newestReply);
  });

  it("keeps absolute numbers inside a tail window", () => {
    const turns = Array.from({ length: 12 }, (_, i) => view(`问${i + 1}`, `答${i + 1}`, i + 1));
    const text = renderHistoryList(turns, { limit: 2 });
    expect(text).toContain("共 12 轮");
    expect(text).toContain("11. 👤 问11 → 🤖 答11");
    expect(text).toContain("12. 👤 你\n\n问12");
    expect(text).toContain("显示 2/12，看更早的: /history list all");
    expect(text).toContain("看全文: /history show 12");
    // Rows outside the window are not printed, but the printed rows keep their
    // absolute numbers (11 and 12, not 1 and 2).
    const numbered = text.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(numbered.map((line) => line.slice(0, line.indexOf(".")))).toEqual(["11", "12"]);
  });

  it("shows every turn with `all` and drops the window hint", () => {
    const turns = Array.from({ length: 8 }, (_, i) => view(`问${i + 1}`, `答${i + 1}`, i + 1));
    const text = renderHistoryList(turns, { all: true });
    expect(text).toContain("1. 👤 问1 → 🤖 答1");
    expect(text).not.toContain("显示 ");
  });

  it("defaults to the last five turns", () => {
    const turns = Array.from({ length: 12 }, (_, i) => view(`问${i + 1}`, `答${i + 1}`, i + 1));
    const text = renderHistoryList(turns);
    expect(text).toContain("8. 👤 问8");
    expect(text).not.toContain("7. 👤 问7");
    expect(text).toContain("显示 5/12");
  });

  it("marks a running newest turn instead of inventing a reply", () => {
    const text = renderHistoryList([view("在做", "", undefined)]);
    expect(text).toContain("（进行中）");
    expect(text).toContain("看全文: /history show 1");
  });

  it("distinguishes an empty prompt from an empty reply", () => {
    const text = renderHistoryList([view("", "", 5)]);
    expect(text).toContain("（无文字）");
    expect(text).toContain("（无回复）");
  });

  it("never prints an unusable hint for an empty list", () => {
    const text = renderHistoryList([]);
    expect(text).toContain("暂无历史消息");
    expect(text).not.toContain("/history show 0");
  });

  it("prints the same rows /fork prints (same fold, same numbers)", () => {
    const turns = [view("第一问", "第一答", 1), view("第二问", "第二答", 2), view("第三问", "第三答", 3)];
    const history = renderHistoryList(turns, { all: true }).split("\n");
    const fork = renderForkList(turns, { all: true }).split("\n");
    // Row 1 and 2 are previews in both; the newest row is full in /history and
    // a preview in /fork, which is the ONLY intended difference.
    expect(history).toContain(fork.find((line) => line.startsWith("1. "))!);
    expect(history).toContain(fork.find((line) => line.startsWith("2. "))!);
  });
});

describe("renderHistoryDetail", () => {
  it("prints the full prompt and reply verbatim", () => {
    const prompt = "把这段很长的需求完整显示出来\n第二行";
    const reply = "完整回复".repeat(400);
    const text = renderHistoryDetail(view(prompt, reply, 9), 3);
    expect(text).toContain("📜 第 3 轮");
    expect(text).toContain(prompt);
    expect(text).toContain(reply);
    expect(text).not.toContain("…");
    expect(text).toContain("从那轮分叉: /fork switch 3");
  });

  it("refuses to suggest a fork for a running turn", () => {
    const text = renderHistoryDetail(view("在做", "", undefined), 4);
    expect(text).toContain("这一轮还在进行中");
    expect(text).toContain("这一轮结束后才能分叉");
    expect(text).not.toContain("/fork switch");
  });
});

// ─── The fold behind it ─────────────────────────────────────────────────────

function makeOps(events: readonly Ev[], sessionId = "wx-1"): DshOps {
  const ctx = {
    get: (name: string) =>
      name === "agents"
        ? { get: (id: string) => (id === sessionId ? { session: { snapshotEvents: () => events } } : undefined) }
        : undefined,
    on: () => () => {},
  };
  return new DshOps(ctx as never);
}

describe("the turn fold /history prints", () => {
  it("keeps only the LAST assistant message of a turn", async () => {
    const turns = await makeOps(TWO_TURNS).readSessionTurns("wx-1");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toBe("帮我看看登录逻辑");
    expect(turns[0]!.reply).toBe("已把 token 刷新挪到拦截器");
    expect(turns[0]!.reply).not.toContain("先读一下代码");
  });

  it("never turns a synthesized user-role injection into a prompt", async () => {
    const events: Ev[] = [
      turnStart(0, 1),
      userMessage(1, "【压缩检查点】被替换掉的历史正文", "plugin"),
      userMessage(2, "真正的提问"),
      assistantMessage(3, "回答"),
      turnEnd(4, 1),
    ];
    const turns = await makeOps(events).readSessionTurns("wx-1");
    expect(turns[0]!.prompt).toBe("真正的提问");
    const text = renderHistoryList(turns);
    expect(text).not.toContain("压缩检查点");
  });
});

// ─── Bridge integration ─────────────────────────────────────────────────────

const SESSION_ID = "session-33333333-0000-4000-8000-000000000000";

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

function makeBridge(events: readonly Ev[], sessionId = SESSION_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-hist-"));
  const agent = {
    id: sessionId,
    status: "idle",
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { id: sessionId, cwd: "C:\\work" }, snapshotEvents: () => events },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
  };
  const agentsService = {
    create: async () => ({ agent }),
    resume: async () => ({ agent }),
    get: (id: string) => (id === sessionId ? agent : undefined),
    list: () => [agent],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  const bridge = new WeChatDSHBridge(ctx as never, cfg);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  const state = (bridge as unknown as {
    state: { ensureUser(u: string, cwd: string): unknown; update(u: string, p: unknown): void };
  }).state;
  state.ensureUser("u1", "C:\\work");
  state.update("u1", { sessionId, cwd: "C:\\work" });
  return bridge;
}

describe("/history in the bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTextMessage.mockResolvedValue(undefined);
    sendMediaMessage.mockResolvedValue(undefined);
  });

  it("lists the bound session's turns and forwards nothing", async () => {
    const bridge = makeBridge(TWO_TURNS);
    await asInbound(bridge).handleMessage(textMessage("/history"));
    const reply = lastReply();
    expect(reply).toContain("📜 会话轮次（共 2 轮）");
    // One row: number, user side with its stamp, arrow, reply side with its
    // stamp. The fixture log carries `seq * 1000` timestamps, so the exact
    // wording of the stamp is not pinned here — only that both sides have one.
    expect(reply).toMatch(/1\. 👤 .+ · 帮我看看登录逻辑 → 🤖 .+ · 已把 token 刷新挪到拦截器/);
    // The intermediate assistant message never reaches the reader.
    expect(reply).not.toContain("先读一下代码");
    expect(reply).toContain("看全文: /history show 2");
  });

  it("treats /history list as the same command", async () => {
    const bridge = makeBridge(TWO_TURNS);
    await asInbound(bridge).handleMessage(textMessage("/history list"));
    expect(lastReply()).toContain("共 2 轮");
  });

  it("shows one turn in full", async () => {
    const bridge = makeBridge(TWO_TURNS);
    await asInbound(bridge).handleMessage(textMessage("/history show 1"));
    const reply = lastReply();
    expect(reply).toContain("📜 第 1 轮");
    expect(reply).toContain("帮我看看登录逻辑");
    expect(reply).toContain("已把 token 刷新挪到拦截器");
    expect(reply).toContain("从那轮分叉: /fork switch 1");
  });

  it("reports the range instead of guessing an out-of-range number", async () => {
    const bridge = makeBridge(TWO_TURNS);
    await asInbound(bridge).handleMessage(textMessage("/history show 9"));
    expect(lastReply()).toContain("没有第 9 轮（共 2 轮）");
    expect(lastReply()).toContain("发 /history 查看编号");
  });

  it("says so when the session has no readable turns", async () => {
    const bridge = makeBridge([]);
    await asInbound(bridge).handleMessage(textMessage("/history"));
    expect(lastReply()).toContain("暂无历史消息");
  });

  it("asks for a session when none is bound", async () => {
    const bridge = makeBridge(TWO_TURNS);
    const state = (bridge as unknown as { state: { update(u: string, p: unknown): void } }).state;
    state.update("u1", { sessionId: undefined });
    await asInbound(bridge).handleMessage(textMessage("/history"));
    expect(lastReply()).toContain("暂无会话");
  });

  it("cold history falls back to sessionQuery.readSession", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-hist-cold-"));
    const query = {
      listSessions: async () => [],
      readTitle: async () => undefined,
      listEvents: async () => [],
      readSession: async () => ({ events: TWO_TURNS }),
    };
    const ctx = {
      get: (name: string) => (name === "sessionQuery" ? query : undefined),
      on: () => () => {},
    };
    const cfg = defaultConfig();
    cfg.storageDir = dir;
    const bridge = new WeChatDSHBridge(ctx as never, cfg);
    (bridge as unknown as { token: unknown }).token = { baseUrl: "https://gw", token: "t" };
    const state = (bridge as unknown as {
      state: { ensureUser(u: string, cwd: string): unknown; update(u: string, p: unknown): void };
    }).state;
    state.ensureUser("u1", "C:\\work");
    state.update("u1", { sessionId: "cold-session", cwd: "C:\\work" });
    await asInbound(bridge).handleMessage(textMessage("/history"));
    const reply = lastReply();
    expect(reply).toContain("帮我看看登录逻辑");
    expect(reply).toContain("已把 token 刷新挪到拦截器");
  });

  it("reads live history from snapshotEvents (DSH 0.1.5)", async () => {
    // The harness only exposes `snapshotEvents` — no legacy `events` array.
    const bridge = makeBridge(TWO_TURNS);
    await asInbound(bridge).handleMessage(textMessage("/history"));
    expect(lastReply()).toContain("已把 token 刷新挪到拦截器");
  });
});
