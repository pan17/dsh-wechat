/**
 * F1 — inbound merge window (打字合并).
 *
 * The window exists so one thought typed as five WeChat messages costs ONE
 * turn. Every case here drives the real public inbound entry
 * (`handleMessage`) and asserts what actually reached `agent.followup`, in
 * order. The safety rules the feature must satisfy are asserted explicitly:
 *
 *   - an OUT-OF-ORDER older message must not extend the silence timer;
 *   - the buffered count is capped;
 *   - a forced release always delivers, whatever the window/suffix state;
 *   - a message arriving while a batch is in flight is not swallowed;
 *   - non-text items are never merged (the pending text goes first).
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
import { ConfigStore } from "../src/config-store.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import {
  formatHelp,
  helpTopicBlock,
  isBypassSlashCommand,
  LOCAL_COMMAND_NAMES,
  parseCommandName,
  parseEnterCommand,
  parseFinalCommand,
  parseFlushCommand,
  parseHelpCommand,
  parseHistoryCommand,
  parseMergeCommand,
  parseModelCommand,
  parseNextCommand,
  parseNotifyCommand,
  parsePermCommand,
  parsePresetCommand,
  parseReasoningCommand,
  parseSessionCommand,
  parseSilentCommand,
  parseStatusCommand,
  parseStopCommand,
  parseSurfaceCommand,
  parseWorkspaceCommand,
} from "../src/bridge/slash.js";

const live: Array<{ stop(): Promise<void> }> = [];

type Patch = Record<string, unknown>;

function makeBridge(patch: Patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-merge-"));
  const received: Array<{ text: string; at: number }> = [];
  const liveAgents = new Map<string, unknown>();
  const agentsService = {
    create: async (options: { sessionId: string }) => {
      const agent = {
        id: options.sessionId,
        status: "idle",
        options: { provider: "deepseek", model: "deepseek-chat" },
        followup: (m: { content: Array<{ text?: string }> }) => {
          received.push({ text: m.content.map((b) => b.text ?? "").join(""), at: Date.now() });
        },
        steer: () => {},
        cancel: () => {},
        whenIdle: async () => {},
      };
      liveAgents.set(agent.id, agent);
      return { agent };
    },
    resume: async () => undefined,
    get: (id: string) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  };
  // `mergeEnabled` is OFF by default in production; every case in THIS file is
  // about the window's behaviour once it is on, so the harness turns it on
  // unless the case is explicitly about the default or about switching.
  const cfg = { ...defaultConfig(), storageDir: dir, mergeEnabled: true, ...patch };
  const bridge = new WeChatDSHBridge(
    { get: (name: string) => (name === "agents" ? agentsService : undefined), on: () => () => {} },
    cfg,
  );
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "bot",
    savedAt: "",
  };
  live.push(bridge);
  return { bridge, received, dir, cfg };
}

/** One inbound text message; `create_time_ms` drives the out-of-order guard. */
function text(text: string, createTimeMs?: number) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    ...(createTimeMs !== undefined ? { create_time_ms: createTimeMs } : {}),
    item_list: [{ type: 1, text_item: { text } }],
  };
}

/** A text message carrying an image item — never merged. */
function textWithImage(text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [
      { type: 1, text_item: { text } },
      { type: 2, image_item: {} },
    ],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const texts = (received: Array<{ text: string }>) => received.map((r) => r.text);

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const bridge of live.splice(0)) await bridge.stop().catch(() => {});
});

describe("merge window: basic batching", () => {
  it("five messages inside the window become ONE prompt, joined in order", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 25 });
    const inbound = asInbound(bridge);
    for (const part of ["第一句", "第二句", "第三句", "第四句", "第五句"]) {
      await inbound.handleMessage(text(part));
    }
    expect(received).toHaveLength(0);
    // Generous margin over the 25ms window: CI timers can be late, and a slow
    // machine must not turn "batched correctly" into a flake.
    await new Promise((r) => setTimeout(r, 400));
    expect(texts(received)).toEqual(["第一句\n第二句\n第三句\n第四句\n第五句"]);
  });

  it("the message cap flushes immediately, as one prompt", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000, mergeMaxMsgs: 3 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("a"));
    await inbound.handleMessage(text("b"));
    expect(received).toHaveLength(0);
    await inbound.handleMessage(text("c"));
    expect(texts(received)).toEqual(["a\nb\nc"]);
  });

  it("a batch is delivered once and the buffer is drained (no write-only state)", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 20 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("一次"));
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(received)).toEqual(["一次"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
  });

  it("an out-of-order OLDER message does not extend the silence timer", async () => {
    vi.useFakeTimers();
    const { bridge, received } = makeBridge({ mergeSilenceMs: 1000 });
    const inbound = asInbound(bridge);

    await inbound.handleMessage(text("新消息", 5_000));
    await vi.advanceTimersByTimeAsync(600);
    // A late replay of an older message arrives: it is appended, but it must
    // NOT push the deadline out (otherwise a replay could hold the batch open
    // while the user waits for an answer).
    await inbound.handleMessage(text("迟到的旧消息", 4_000));
    await vi.advanceTimersByTimeAsync(500);
    expect(texts(received)).toEqual(["新消息\n迟到的旧消息"]);
  });

  it("a strictly newer message DOES extend the silence timer", async () => {
    vi.useFakeTimers();
    const { bridge, received } = makeBridge({ mergeSilenceMs: 1000 });
    const inbound = asInbound(bridge);

    await inbound.handleMessage(text("first", 1_000));
    await vi.advanceTimersByTimeAsync(600);
    await inbound.handleMessage(text("second", 2_000));
    await vi.advanceTimersByTimeAsync(600);
    // 1200ms after the first message, but only 600ms after the second.
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(texts(received)).toEqual(["first\nsecond"]);
  });
});

describe("merge window: suffix tokens", () => {
  it("`!!` commits immediately and is stripped from the text", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("现在就说 !!"));
    expect(texts(received)).toEqual(["现在就说"]);
  });

  it("`..` keeps the batch open past the silence window and is stripped", async () => {
    vi.useFakeTimers();
    const { bridge, received } = makeBridge({ mergeSilenceMs: 500, mergeForcedReleaseMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("还没说完 .."));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(received).toHaveLength(0);
    await inbound.handleMessage(text("补充一句 !!"));
    expect(texts(received)).toEqual(["还没说完\n补充一句"]);
  });

  it("a message that is ONLY the token keeps its literal text when nothing is buffered", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 25 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("!!"));
    // Nothing to control: the token is ordinary text and is not swallowed.
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(received)).toEqual(["!!"]);
  });

  it("a bare `!!` commits the pending batch without polluting it", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("先说这句"));
    expect(received).toHaveLength(0);
    await inbound.handleMessage(text("!!"));
    expect(texts(received)).toEqual(["先说这句"]);
  });

  it("mergeSuffixTokens=false leaves the tokens in the text", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000, mergeSuffixTokens: false });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("照原样 !!"));
    expect(received).toHaveLength(0);
    await inbound.handleMessage(text("继续"));
    await inbound.handleMessage(text("x".repeat(1)));
    // Cap not reached and no commit: still buffered, tokens intact.
    expect(received).toHaveLength(0);
  });
});

describe("merge window: forced release and in-flight batches", () => {
  it("the forced-release ceiling delivers even while a `..` hold is open", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000, mergeForcedReleaseMs: 40 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("一直没说 .."));
    expect(received).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(texts(received)).toEqual(["一直没说"]);
  });

  it("a message arriving while a batch is in flight is not swallowed", async () => {
    const { bridge } = makeBridge({ mergeSilenceMs: 20, mergeForcedReleaseMs: 60_000 });
    const dispatched: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    // The sink is stubbed so "in flight" is controllable; the buffering and
    // flushing under test are the real ones (driven through handleMessage).
    // The sink is `forwardBlocksToAgent` — the merge dispatcher assembles
    // blocks and hands them over there (it no longer builds a synthetic
    // WeixinMessage), so the first block is the joined batch text.
    vi.spyOn(bridge as never, "forwardBlocksToAgent" as never).mockImplementation((async (
      _user: unknown,
      blocks: Array<{ text?: string }>,
    ) => {
      if (first) {
        first = false;
        await gate;
      }
      dispatched.push(blocks[0]?.text ?? "");
    }) as never);

    void asInbound(bridge).handleMessage(text("第一批 !!"));
    await new Promise((r) => setTimeout(r, 30));
    expect(dispatched).toEqual([]);

    // Arrives while the first dispatch is still in flight: it must be queued
    // as a NEW batch, never merged into the delivered one and never dropped.
    void asInbound(bridge).handleMessage(text("第二批 !!"));
    await new Promise((r) => setTimeout(r, 30));
    releaseFirst();
    await new Promise((r) => setTimeout(r, 200));
    expect(dispatched).toEqual(["第一批", "第二批"]);
  });

  it("a batch blocked behind a wedged dispatch goes out after the bounded wait", async () => {
    const { bridge } = makeBridge({ mergeSilenceMs: 20, mergeForcedReleaseMs: 60 });
    const dispatched: string[] = [];
    // The first dispatch NEVER settles: exactly the "one hung operation must
    // not block the channel" case the forced release exists for.
    let first = true;
    vi.spyOn(bridge as never, "forwardBlocksToAgent" as never).mockImplementation((async (
      _user: unknown,
      blocks: Array<{ text?: string }>,
    ) => {
      if (first) {
        first = false;
        await new Promise(() => {});
      }
      dispatched.push(blocks[0]?.text ?? "");
    }) as never);

    void asInbound(bridge).handleMessage(text("卡住的一批 !!"));
    await new Promise((r) => setTimeout(r, 30));
    void asInbound(bridge).handleMessage(text("后面的一批 !!"));

    const deadline = Date.now() + 2000;
    while (dispatched.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(dispatched).toEqual(["后面的一批"]);
  });
});

describe("merge window: non-text items are never merged", () => {
  it("an image mid-window flushes the pending text first, then goes as its own turn", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("先说的话"));
    expect(received).toHaveLength(0);
    await inbound.handleMessage(textWithImage("看这张图"));
    expect(texts(received)).toEqual(["先说的话", "看这张图"]);
  });

  it("a media item with nothing buffered goes straight through", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(textWithImage("只有图"));
    expect(texts(received)).toEqual(["只有图"]);
  });
});

describe("merge window: switch and persistence", () => {
  it("is OFF by default, so an untouched install keeps one turn per message", async () => {
    // The harness enables merging for every other case; this one asks the real
    // question — what does a fresh `defaultConfig()` do? Batching changes what
    // "one turn" means and adds latency per message, so it must be opt-in.
    expect(defaultConfig().mergeEnabled).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-merge-"));
    const received: string[] = [];
    const agentsService = {
      create: async (options: { sessionId: string }) => {
        const agent = {
          id: options.sessionId,
          status: "idle",
          options: { provider: "deepseek", model: "deepseek-chat" },
          followup: (m: { content: Array<{ text?: string }> }) => {
            received.push(m.content.map((b) => b.text ?? "").join(""));
          },
          steer: () => {},
          cancel: () => {},
          whenIdle: async () => {},
        };
        return { agent };
      },
      resume: async () => undefined,
      get: () => undefined,
      list: () => [],
    };
    const bridge = new WeChatDSHBridge(
      { get: (name: string) => (name === "agents" ? agentsService : undefined), on: () => () => {} },
      { ...defaultConfig(), storageDir: dir, mergeSilenceMs: 60_000 },
    );
    (bridge as unknown as { token: unknown }).token = {
      baseUrl: "https://gw", token: "t", accountId: "b1", userId: "bot", savedAt: "",
    };
    live.push(bridge);
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("一"));
    await inbound.handleMessage(text("二"));
    // No window is armed at all: both messages became their own turn at once.
    expect(received).toEqual(["一", "二"]);
  });

  it("mergeSilenceMs=0 disables the window (one turn per message)", async () => {
    const { bridge, received } = makeBridge({ mergeSilenceMs: 0 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("一"));
    await inbound.handleMessage(text("二"));
    expect(texts(received)).toEqual(["一", "二"]);
  });

  it("/merge status reports the live parameters and the buffered count", async () => {
    const { bridge } = makeBridge({ mergeSilenceMs: 60_000, mergeMaxMsgs: 4 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("待合并"));
    await inbound.handleMessage(text("/merge"));
    const status = sendTextMessage.mock.calls.map((c) => String(c[1])).find((t) => t.includes("打字合并"));
    expect(status).toBeTruthy();
    expect(status).toContain("上限 4 条");
    expect(status).toContain("暂存 1 条");
  });

  it("/merge off flushes what it was holding and persists the switch", async () => {
    const { bridge, received, cfg } = makeBridge({ mergeSilenceMs: 60_000 });
    const store = new ConfigStore(cfg.storageDir);
    (bridge as unknown as { configStore?: unknown }).configStore = store;
    const inbound = asInbound(bridge);

    await inbound.handleMessage(text("别丢掉我"));
    expect(received).toHaveLength(0);
    await inbound.handleMessage(text("/merge off"));

    // The held message was delivered as one turn BEFORE the confirmation.
    expect(texts(received)).toEqual(["别丢掉我"]);
    const replies = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(replies.some((r) => r.includes("打字合并已关闭"))).toBe(true);
    expect(store.stored().mergeEnabled).toBe(false);
    expect((bridge as unknown as { config: { mergeEnabled: boolean } }).config.mergeEnabled).toBe(false);
  });

  it("/merge on persists the switch", async () => {
    const { bridge, cfg } = makeBridge({ mergeEnabled: false });
    const store = new ConfigStore(cfg.storageDir);
    (bridge as unknown as { configStore?: unknown }).configStore = store;
    await asInbound(bridge).handleMessage(text("/merge on"));
    expect(store.stored().mergeEnabled).toBe(true);
    expect((bridge as unknown as { config: { mergeEnabled: boolean } }).config.mergeEnabled).toBe(true);
    const replies = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(replies.join("\n")).toContain("打字合并已开启");
  });
});

describe("/merge is wired exactly like /silent (and collides with nothing)", () => {
  it("parses bare / on / off / status and the /mg alias", () => {
    expect(parseMergeCommand("/merge")).toEqual({ kind: "merge", mode: "status" });
    expect(parseMergeCommand("/mg")).toEqual({ kind: "merge", mode: "status" });
    expect(parseMergeCommand("/merge on")).toEqual({ kind: "merge", mode: "on" });
    expect(parseMergeCommand("/mg off")).toEqual({ kind: "merge", mode: "off" });
    expect(parseMergeCommand("/MERGE STATUS")).toEqual({ kind: "merge", mode: "status" });
    expect(parseMergeCommand("/merge maybe")).toBeNull();
    expect(parseMergeCommand("/mergeant")).toBeNull();
  });

  it("no OTHER parser claims /merge or /mg (alias-collision guard)", () => {
    const others: Array<[string, (text: string) => unknown]> = [
      ["help", parseHelpCommand],
      ["status", parseStatusCommand],
      ["silent", parseSilentCommand],
      ["final", parseFinalCommand],
      ["surface", parseSurfaceCommand],
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
    ];
    for (const input of ["/merge", "/merge on", "/merge off", "/mg", "/mg status"]) {
      for (const [name, parser] of others) {
        const result = parser(input);
        const claimed = result !== null && result !== false && result !== undefined;
        expect(claimed, `${name} must not claim ${input}`).toBe(false);
      }
      expect(parseMergeCommand(input)).not.toBeNull();
      expect(parseCommandName(input)).toBe(input.trim().split(" ")[0]!.slice(1));
    }
  });

  it("bypasses a pending card", () => {
    expect(isBypassSlashCommand("/merge")).toBe(true);
    expect(isBypassSlashCommand("/merge on")).toBe(true);
    expect(isBypassSlashCommand("/mg off")).toBe(true);
  });

  it("is de-duplicated against native commands and documented in /help", () => {
    expect(LOCAL_COMMAND_NAMES.has("merge")).toBe(true);
    expect(LOCAL_COMMAND_NAMES.has("mg")).toBe(true);
    const help = formatHelp();
    expect(help).toContain("/merge (mg)");
    // The `..` / `!!` suffixes live in /merge's example block, which is where
    // a reader looking up the command will actually land.
    const block = helpTopicBlock("merge") ?? "";
    expect(block).toContain("..");
    expect(block).toContain("!!");
  });
});
