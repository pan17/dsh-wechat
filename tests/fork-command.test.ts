/**
 * `/fork` — 按轮次分叉当前会话.
 *
 * Three things are pinned here, because all three are what "和 GUI 保持一致"
 * actually means:
 *
 *   1. the parser's grammar (`list [all|数量]` / `show <编号>` / `switch <编号>`),
 *   2. the turn fold — copied from the host's `turnOutline` projection, with
 *      full text and the closing seq the GUI forks at,
 *   3. the bridge: `switch` must hand the host EXACTLY that turn's `turn/end`
 *      seq, and every refusal must leave the session binding untouched.
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

import {
  LOCAL_COMMAND_NAMES,
  formatHelp,
  isBypassSlashCommand,
  isForkCommandAttempt,
  parseAtCommand,
  parseCommandName,
  parseEnterCommand,
  parseFinalCommand,
  parseFlushCommand,
  parseForkCommand,
  parseHelpCommand,
  parseHistoryCommand,
  parseMediaCommand,
  parseMergeCommand,
  parseModelCommand,
  parseNextCommand,
  parseNotifyCommand,
  parsePermCommand,
  parsePresetCommand,
  parseRawCommand,
  parseReasoningCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseSkillCommand,
  parseStatusCommand,
  parseStopCommand,
  parseSurfaceCommand,
  parseWorkspaceCommand,
  renderForkDetail,
  renderForkList,
  type TurnView,
} from "../src/bridge/slash.js";
import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { DshOps } from "../src/dsh/ops.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

type Ev = { type: string; time?: number; data?: unknown; seq?: number };

const turnStart = (seq: number, turn: number): Ev => ({
  type: "turn/start",
  seq,
  time: seq * 1000,
  data: { turn },
});

const turnEnd = (seq: number, turn: number, reason = "completed"): Ev => ({
  type: "turn/end",
  seq,
  time: seq * 1000,
  data: { turn, reason: { kind: reason } },
});

const userMessage = (seq: number, text: string, kind = "user"): Ev => ({
  type: "user/message",
  seq,
  time: seq * 1000,
  data: { id: `m-${seq}`, role: "user", content: [{ type: "text", text }], source: { kind } },
});

const imageMessage = (seq: number): Ev => ({
  type: "user/message",
  seq,
  time: seq * 1000,
  data: {
    id: `m-${seq}`,
    role: "user",
    content: [{ type: "image", attachment: { id: "a1" } }],
    source: { kind: "user" },
  },
});

const assistantMessage = (seq: number, text: string): Ev => ({
  type: "assistant/message",
  seq,
  time: seq * 1000,
  data: { message: { role: "assistant", content: [{ type: "text", text }] } },
});

const toolCall = (seq: number): Ev => ({ type: "tool/call", seq, time: seq * 1000, data: { name: "read" } });

/**
 * A three-turn log: two completed turns and one still running.
 *
 *   turn 1: prompt → two assistant messages (the LAST one is the reply)
 *   turn 2: prompt → one assistant message
 *   turn 3: prompt → assistant message, NO turn/end (still running)
 */
const THREE_TURNS: Ev[] = [
  turnStart(0, 1),
  userMessage(1, "帮我看看登录逻辑"),
  assistantMessage(2, "先读一下代码"),
  toolCall(3),
  assistantMessage(4, "已把 token 刷新挪到拦截器"),
  turnEnd(5, 1),
  turnStart(6, 2),
  userMessage(7, "再跑一遍测试"),
  assistantMessage(8, "全部通过"),
  turnEnd(9, 2),
  turnStart(10, 3),
  userMessage(11, "继续优化"),
  assistantMessage(12, "正在处理"),
];

function makeOps(events: readonly Ev[], sessionId = "session-src"): DshOps {
  const ctx = {
    get: (name: string) => {
      if (name === "agents") {
        return {
          get: (id: string) =>
            id === sessionId
              ? { session: { header: { id, cwd: "C:\\work" }, snapshotEvents: () => events } }
              : undefined,
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  return new DshOps(ctx as never);
}

// ─── Parser ─────────────────────────────────────────────────────────────────

describe("parseForkCommand", () => {
  it("treats a bare /fork as the list", () => {
    expect(parseForkCommand("/fork")).toEqual({ kind: "list" });
    expect(parseForkCommand("/FORK")).toEqual({ kind: "list" });
    expect(parseForkCommand("/fork list")).toEqual({ kind: "list" });
  });

  it("reuses the shared list window grammar (all / count / all+count)", () => {
    expect(parseForkCommand("/fork list 50")).toEqual({ kind: "list", limit: 50 });
    expect(parseForkCommand("/fork list all")).toEqual({ kind: "list", all: true });
    // `all` wins over an explicit count at render time, exactly like `/s list
    // all 5`: the shared parser keeps both fields and the renderer prefers
    // `all`. Either order parses to the same command.
    expect(parseForkCommand("/fork list all 5")).toEqual({ kind: "list", limit: 5, all: true });
    expect(parseForkCommand("/fork list 5 all")).toEqual({ kind: "list", limit: 5, all: true });
  });

  it("parses show / switch with exactly one positive index", () => {
    expect(parseForkCommand("/fork show 3")).toEqual({ kind: "show", index: 3 });
    expect(parseForkCommand("/fork switch 3")).toEqual({ kind: "switch", index: 3 });
    expect(parseForkCommand("  /fork   SWITCH   12  ")).toEqual({ kind: "switch", index: 12 });
  });

  it("refuses everything else so the caller can answer with usage", () => {
    for (const line of [
      "/fork list 0",
      "/fork list abc",
      "/fork list 3 4",
      "/fork show",
      "/fork show abc",
      "/fork show 0",
      "/fork show 1 2",
      "/fork switch",
      "/fork switch -1",
      "/fork swtich 2",
      "/fork 3",
    ]) {
      expect(parseForkCommand(line), line).toBeNull();
    }
  });

  it("does not claim other commands", () => {
    expect(parseForkCommand("/forked")).toBeNull();
    expect(parseForkCommand("/forky list")).toBeNull();
    expect(parseForkCommand("fork list")).toBeNull();
  });

  it("is matched on the attempt (a typo still bypasses a pending card)", () => {
    expect(isForkCommandAttempt("/fork")).toBe(true);
    expect(isForkCommandAttempt("/fork swtich 2")).toBe(true);
    expect(isForkCommandAttempt("  /fork list")).toBe(true);
    expect(isForkCommandAttempt("/forked")).toBe(false);
    expect(isForkCommandAttempt("fork")).toBe(false);
  });
});

describe("/fork is wired like every other local command", () => {
  it("bypasses pending cards for every shape, valid or not", () => {
    expect(isBypassSlashCommand("/fork")).toBe(true);
    expect(isBypassSlashCommand("/fork list all")).toBe(true);
    expect(isBypassSlashCommand("/fork show 2")).toBe(true);
    expect(isBypassSlashCommand("/fork switch 2")).toBe(true);
    // A mistyped subcommand is a command attempt, never a card answer.
    expect(isBypassSlashCommand("/fork swtich 2")).toBe(true);
  });

  it("owns the name, so no native command can shadow it", () => {
    expect(LOCAL_COMMAND_NAMES.has("fork")).toBe(true);
    expect(parseCommandName("/fork switch 2")).toBe("fork");
  });

  it("no OTHER parser claims /fork (alias-collision guard)", () => {
    const others: Array<[string, (text: string) => unknown]> = [
      ["help", parseHelpCommand],
      ["status", parseStatusCommand],
      ["silent", parseSilentCommand],
      ["final", parseFinalCommand],
      ["surface", parseSurfaceCommand],
      ["raw", parseRawCommand],
      ["stop", parseStopCommand],
      ["notify", parseNotifyCommand],
      ["next", parseNextCommand],
      ["flush", parseFlushCommand],
      ["workspace", parseWorkspaceCommand],
      ["session", parseSessionCommand],
      ["preset", parsePresetCommand],
      ["model", parseModelCommand],
      ["perm", parsePermCommand],
      ["reasoning", parseReasoningCommand],
      ["enter", parseEnterCommand],
      ["history", parseHistoryCommand],
      ["at", parseAtCommand],
      ["skill", parseSkillCommand],
      ["merge", parseMergeCommand],
      ["media", parseMediaCommand],
    ];
    for (const input of ["/fork", "/fork list all", "/fork show 2", "/fork switch 2"]) {
      for (const [name, parser] of others) {
        const result = parser(input);
        const claimed = result !== null && result !== false && result !== undefined;
        expect(claimed, `${name} must not claim ${input}`).toBe(false);
      }
      expect(parseForkCommand(input)).not.toBeNull();
    }
  });

  it("appears in the /help listing", () => {
    expect(formatHelp()).toContain("/fork");
  });
});

// ─── Turn fold ──────────────────────────────────────────────────────────────

describe("readSessionTurns folds turns like the GUI rail", () => {
  it("anchors on turn/start and commits the reply at turn/end", async () => {
    const turns = await makeOps(THREE_TURNS).readSessionTurns("session-src");
    expect(turns.map((t) => t.turn)).toEqual([1, 2, 3]);
    // The LAST text-bearing assistant message wins — the earlier one is a draft.
    expect(turns[0]).toMatchObject({
      turn: 1,
      prompt: "帮我看看登录逻辑",
      reply: "已把 token 刷新挪到拦截器",
      endSeq: 5,
    });
    expect(turns[1]).toMatchObject({ turn: 2, prompt: "再跑一遍测试", reply: "全部通过", endSeq: 9 });
  });

  it("keeps the prompt's clock and the reply's clock apart", async () => {
    const turns = await makeOps(THREE_TURNS).readSessionTurns("session-src");
    // Turn 1: the human spoke at seq 1, the turn closed at seq 5.
    expect(turns[0]!.promptTime).toBe(1000);
    expect(turns[0]!.replyTime).toBe(5000);
    // A running turn has a prompt clock but no reply clock.
    expect(turns[2]!.promptTime).toBe(11000);
    expect(turns[2]!.replyTime).toBeUndefined();
  });

  it("leaves a running turn without an endSeq (and without a reply)", async () => {
    const turns = await makeOps(THREE_TURNS).readSessionTurns("session-src");
    const running = turns[2]!;
    expect(running.turn).toBe(3);
    expect(running.prompt).toBe("继续优化");
    // The draft is only committed by turn/end; a running turn shows no reply.
    expect(running.reply).toBe("");
    expect(running.endSeq).toBeUndefined();
  });

  it("keeps the FIRST human prompt of a turn (steering never overwrites)", async () => {
    const turns = await makeOps([
      turnStart(0, 1),
      userMessage(1, "第一句"),
      userMessage(2, "补充一句"),
      assistantMessage(3, "好"),
      turnEnd(4, 1),
    ]).readSessionTurns("session-src");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toBe("第一句");
  });

  it("ignores synthesized user-role messages", async () => {
    const turns = await makeOps([
      turnStart(0, 1),
      userMessage(1, "<compaction checkpoint>", "plugin"),
      userMessage(2, "真正的问题"),
      assistantMessage(3, "答"),
      turnEnd(4, 1),
    ]).readSessionTurns("session-src");
    expect(turns[0]!.prompt).toBe("真正的问题");
  });

  it("leaves an image-only prompt empty", async () => {
    const turns = await makeOps([
      turnStart(0, 1),
      imageMessage(1),
      assistantMessage(2, "这是截图里的报错"),
      turnEnd(3, 1),
    ]).readSessionTurns("session-src");
    expect(turns[0]!.prompt).toBe("");
    expect(turns[0]!.reply).toBe("这是截图里的报错");
  });

  it("skips a turn/start that does not advance the turn number", async () => {
    const turns = await makeOps([
      turnStart(0, 1),
      userMessage(1, "一"),
      turnStart(2, 1),
      assistantMessage(3, "答"),
      turnEnd(4, 1),
    ]).readSessionTurns("session-src");
    expect(turns).toHaveLength(1);
  });

  it("skips turn/start events that carry no seq (they cannot be forked at)", async () => {
    const turns = await makeOps([
      { type: "turn/start", data: { turn: 1 } },
      userMessage(1, "无锚点"),
      turnEnd(2, 1),
    ]).readSessionTurns("session-src");
    expect(turns).toEqual([]);
  });

  it("records an empty reply for a turn that ended without prose", async () => {
    const turns = await makeOps([
      turnStart(0, 1),
      userMessage(1, "只调工具"),
      toolCall(2),
      turnEnd(3, 1, "aborted"),
    ]).readSessionTurns("session-src");
    expect(turns[0]).toMatchObject({ prompt: "只调工具", reply: "", endSeq: 3 });
  });

  it("falls back to the persisted read when the session is cold", async () => {
    const ctx = {
      get: (name: string) => {
        if (name === "agents") return { get: () => undefined };
        if (name === "sessionQuery") {
          return { readSession: async () => ({ events: THREE_TURNS }) };
        }
        return undefined;
      },
      on: () => () => {},
    };
    const turns = await new DshOps(ctx as never).readSessionTurns("session-cold");
    expect(turns).toHaveLength(3);
    expect(turns[0]!.endSeq).toBe(5);
  });

  it("returns [] instead of throwing when nothing can be read", async () => {
    const ctx = { get: () => undefined, on: () => () => {} };
    await expect(new DshOps(ctx as never).readSessionTurns("session-x")).resolves.toEqual([]);
    await expect(new DshOps(ctx as never).readSessionTurns("")).resolves.toEqual([]);
  });
});

// ─── Rendering ──────────────────────────────────────────────────────────────

function view(turn: number, prompt: string, reply: string, endSeq?: number): TurnView & { turn: number } {
  // No timestamps by default: the layout tests below assert the row text, and
  // the stamp gets its own dedicated cases.
  return { turn, prompt, reply, ...(endSeq === undefined ? {} : { endSeq }) };
}

describe("renderForkList", () => {
  it("numbers every turn and shows the total", () => {
    const text = renderForkList([
      view(1, "帮我看看登录", "已修复 token 刷新", 5),
      view(2, "再跑测试", "全部通过", 9),
      view(3, "继续优化", "", undefined),
    ]);
    expect(text).toContain("共 3 轮");
    expect(text).toContain("1. 👤 帮我看看登录 → 🤖 已修复 token 刷新");
    expect(text).toContain("2. 👤 再跑测试 → 🤖 全部通过");
    // A running turn says so; it is a different fact from "no prose".
    expect(text).toContain("3. 👤 继续优化 → 🤖 （进行中）");
    expect(text).toContain("看全文: /fork show 3");
    // The fork example points at the newest COMPLETED turn, never the running one.
    expect(text).toContain("从那轮分叉: /fork switch 2");
  });

  it("windows to the newest 20 rows while keeping absolute numbers", () => {
    const turns = Array.from({ length: 37 }, (_, i) => view(i + 1, `问题${i + 1}`, `回答${i + 1}`, i * 2 + 1));
    const text = renderForkList(turns);
    const rows = text.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(rows).toHaveLength(20);
    // Tail window: the first printed row is #18, not #1.
    expect(rows[0]!.startsWith("18. ")).toBe(true);
    expect(rows.at(-1)!.startsWith("37. ")).toBe(true);
    expect(text).toContain("显示 20/37");
    expect(text).toContain("/fork list all");
  });

  it("shows everything for all / an explicit larger count", () => {
    const turns = Array.from({ length: 25 }, (_, i) => view(i + 1, `问${i + 1}`, `答${i + 1}`, i * 2 + 1));
    const all = renderForkList(turns, { all: true });
    expect(all.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(25);
    expect(all).not.toContain("显示 20/25");
    const fifty = renderForkList(turns, { limit: 50 });
    expect(fifty.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(25);
  });

  it("collapses whitespace and clips long previews", () => {
    const text = renderForkList([
      view(1, "第一行\n\n第二行   带空格", "很长的回答".repeat(30), 5),
    ]);
    expect(text).toContain("1. 👤 第一行 第二行 带空格 →");
    expect(text).toContain("…");
    // One row per turn: a multi-line prompt must not break the list.
    expect(text.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(1);
  });

  it("marks a turn with no text and no prose explicitly", () => {
    const text = renderForkList([view(1, "", "", 5)]);
    expect(text).toContain("（无文字）");
    expect(text).toContain("（无回复）");
  });

  it("never prints an unusable hint for an empty list", () => {
    const text = renderForkList([]);
    expect(text).toContain("还没有已记录的轮次");
    expect(text).not.toContain("/fork show 0");
  });
});

describe("renderForkDetail", () => {
  it("prints the full prompt and reply verbatim", () => {
    const longPrompt = "把这段很长的需求完整显示出来\n第二行";
    const longReply = "完整回复".repeat(400);
    const text = renderForkDetail(
      {
        prompt: longPrompt,
        reply: longReply,
        endSeq: 9,
        promptTime: Date.now() - 600_000,
        replyTime: Date.now() - 1000,
      },
      3,
    );
    expect(text).toContain("🔀 第 3 轮");
    expect(text).toContain(longPrompt);
    // No truncation: naming a turn means reading it.
    expect(text).toContain(longReply);
    expect(text).not.toContain("…");
    expect(text).toContain("从那轮分叉: /fork switch 3");
  });

  it("stamps the prompt and the reply with their OWN time", () => {
    // The two sides answer different questions ("when did I say it", "when did
    // it answer"), so they must not share one stamp — and the reply's stamp
    // must not be printed on the user's line.
    const text = renderForkDetail(
      { prompt: "问", reply: "答", endSeq: 9, promptTime: Date.now() - 3_600_000, replyTime: Date.now() - 1000 },
      2,
    );
    expect(text).toContain("👤 你 · 1 小时前");
    expect(text).toContain("🤖 助手 · 刚刚");
    // A running turn has no reply time to print.
    const running = renderForkDetail({ prompt: "问", reply: "" }, 3);
    expect(running).toContain("🤖 助手\n\n（这一轮还在进行中）");
  });

  it("refuses to suggest a fork for a running turn", () => {
    const text = renderForkDetail({ prompt: "在做", reply: "" }, 4);
    expect(text).toContain("这一轮还在进行中");
    expect(text).toContain("这一轮结束后才能分叉");
    expect(text).not.toContain("/fork switch");
  });

  it("distinguishes an empty prompt from an empty reply", () => {
    const text = renderForkDetail({ prompt: "", reply: "", endSeq: 3 }, 1);
    expect(text).toContain("（这一轮没有文字提示词）");
    expect(text).toContain("（这一轮没有文字回复）");
  });
});

// ─── Bridge integration ─────────────────────────────────────────────────────

const SRC_ID = "session-11111111-0000-4000-8000-000000000000";
const CHILD_ID = "session-22222222-0000-4000-8000-000000000000";

function textMessage(text: string, from = "u1") {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text } }],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const lastReply = () => String(sendTextMessage.mock.calls.at(-1)?.[1] ?? "");
const replies = () => sendTextMessage.mock.calls.map((c) => String(c[1]));

function makeAgent(id: string, events: readonly Ev[], title?: string) {
  const log: Ev[] = title === undefined
    ? [...events]
    : [...events, { type: "session/title", seq: events.length, time: 1, data: { title } }];
  return {
    id,
    status: "idle",
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: {
      header: { id, cwd: "C:\\work", agentPreset: "default" },
      snapshotEvents: () => log,
    },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
  };
}

function makeBridge(opts: {
  events?: readonly Ev[];
  title?: string;
  fork?: (request: { sessionId: string; atSeq?: number }) => Promise<{ sessionId: string }>;
  rename?: (request: { sessionId: string; title: string }) => Promise<{ title: string }>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-fork-"));
  const source = makeAgent(SRC_ID, opts.events ?? THREE_TURNS, opts.title ?? "部署脚本");
  const child = makeAgent(CHILD_ID, [], "部署脚本 (1)");
  const fork = vi.fn(opts.fork ?? (async () => ({ sessionId: CHILD_ID })));
  const rename = vi.fn(opts.rename ?? (async (req: { title: string }) => ({ title: req.title })));
  const agentsService = {
    create: async () => ({ agent: child }),
    resume: async () => ({ agent: child }),
    get: (id: string) => (id === SRC_ID ? source : id === CHILD_ID ? child : undefined),
    list: () => [source, child],
  };
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "sessionController") return { fork, rename };
      return undefined;
    },
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
    state: {
      ensureUser(u: string, cwd: string, o?: { silent?: boolean }): unknown;
      update(u: string, p: unknown): void;
      getUser(u: string): { sessionId: string; cwd: string } | undefined;
    };
  }).state;
  state.ensureUser("u1", "C:\\work", { silent: false });
  state.update("u1", { sessionId: SRC_ID, cwd: "C:\\work" });
  return { bridge, fork, rename, state };
}

describe("/fork in the bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTextMessage.mockResolvedValue(undefined);
  });

  it("lists the turns of the bound session and forwards nothing", async () => {
    const { bridge, fork } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork"));
    const reply = lastReply();
    expect(reply).toContain("共 3 轮");
    // Both sides carry a stamp; the fixture log uses `seq * 1000` timestamps,
    // so only the shape is pinned here (the wording is unit-tested above).
    expect(reply).toMatch(/1\. 👤 .+ · 帮我看看登录逻辑 → 🤖 .+ · 已把 token 刷新挪到拦截器/);
    // A running turn has no reply clock, so that side has no stamp.
    expect(reply).toMatch(/3\. 👤 .+ · 继续优化 → 🤖 （进行中）/);
    expect(fork).not.toHaveBeenCalled();
  });

  it("shows one turn's full text and never forks", async () => {
    const { bridge, fork } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork show 2"));
    const reply = lastReply();
    expect(reply).toContain("🔀 第 2 轮");
    expect(reply).toContain("再跑一遍测试");
    expect(reply).toContain("全部通过");
    expect(reply).toContain("/fork switch 2");
    expect(fork).not.toHaveBeenCalled();
  });

  it("reports the range instead of guessing an out-of-range number", async () => {
    const { bridge, fork } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork show 9"));
    expect(lastReply()).toContain("没有第 9 轮（共 3 轮）");
    await asInbound(bridge).handleMessage(textMessage("/fork switch 9"));
    expect(lastReply()).toContain("没有第 9 轮（共 3 轮）");
    expect(fork).not.toHaveBeenCalled();
  });

  it("forks at EXACTLY that turn's turn/end seq and rebinds the session", async () => {
    const { bridge, fork, state } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork switch 2"));
    expect(fork).toHaveBeenCalledTimes(1);
    // Turn 2 closes at seq 9 — the same boundary the GUI's fork button passes.
    expect(fork.mock.calls[0]![0]).toEqual({ sessionId: SRC_ID, atSeq: 9 });
    expect(state.getUser("u1")?.sessionId).toBe(CHILD_ID);
    const reply = lastReply();
    expect(reply).toContain("✅ 已从第 2 轮分叉");
    expect(reply).toContain(CHILD_ID);
    expect(reply).toContain("/s list");
  });

  it("increments the inherited title like the GUI does", async () => {
    const { bridge, rename } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork switch 1"));
    expect(rename).toHaveBeenCalledWith({ sessionId: CHILD_ID, title: "部署脚本 (1)" });
  });

  it("refuses to fork a running turn", async () => {
    const { bridge, fork, state } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork switch 3"));
    expect(lastReply()).toContain("第 3 轮还在进行中");
    expect(fork).not.toHaveBeenCalled();
    expect(state.getUser("u1")?.sessionId).toBe(SRC_ID);
  });

  it("leaves the binding untouched when the host refuses", async () => {
    const cases: Array<[string, Error, string]> = [
      ["not-found", Object.assign(new Error("gone"), { code: "session/not-found" }), "源会话已不存在"],
      ["unavailable", Object.assign(new Error("event 9 does not exist"), { code: "session/fork-unavailable" }), "已不在会话日志里"],
      ["migration", Object.assign(new Error("migrate first"), { code: "session/migration-required" }), "先在 DSH 桌面端打开一次"],
      ["error", new Error("boom"), "分叉失败：boom"],
    ];
    for (const [label, error, expected] of cases) {
      vi.clearAllMocks();
      const { bridge, state } = makeBridge({
        fork: async () => {
          throw error;
        },
      });
      await asInbound(bridge).handleMessage(textMessage("/fork switch 2"));
      expect(lastReply(), label).toContain(expected);
      expect(state.getUser("u1")?.sessionId, label).toBe(SRC_ID);
    }
  });

  it("says so when the deployment has no fork service", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-fork-"));
    const source = makeAgent(SRC_ID, THREE_TURNS, "部署脚本");
    const ctx = {
      get: (name: string) =>
        name === "agents"
          ? { get: (id: string) => (id === SRC_ID ? source : undefined), list: () => [source] }
          : undefined,
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
      state: { ensureUser(u: string, cwd: string): unknown; update(u: string, p: unknown): void; getUser(u: string): { sessionId: string } | undefined };
    }).state;
    state.ensureUser("u1", "C:\\work");
    state.update("u1", { sessionId: SRC_ID, cwd: "C:\\work" });

    await asInbound(bridge).handleMessage(textMessage("/fork switch 2"));
    expect(lastReply()).toContain("不支持分叉");
    expect(state.getUser("u1")?.sessionId).toBe(SRC_ID);
  });

  it("answers a mistyped subcommand with usage, not with a forwarded turn", async () => {
    const { bridge } = makeBridge({});
    await asInbound(bridge).handleMessage(textMessage("/fork swtich 2"));
    const reply = lastReply();
    expect(reply).toContain("没看懂");
    expect(reply).toContain("用法");
    // Exactly one reply: the line was answered, never forwarded to the agent.
    expect(replies()).toHaveLength(1);
  });

  it("explains the empty state when nothing is bound", async () => {
    const { bridge, state } = makeBridge({});
    state.update("u1", { sessionId: "" });
    await asInbound(bridge).handleMessage(textMessage("/fork list"));
    expect(lastReply()).toContain("暂无会话");
  });
});
