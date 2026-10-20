/**
 * 图片/文件与文字合并发送 (`mediaMergeEnabled` / `mediaHoldMs`) and how a saved
 * attachment is spelled for the model — `@文件` reference or plain path, always
 * a pointer and never its bytes.
 *
 * The feature exists because a screenshot and the question about it used to
 * cost TWO turns: the image was never merged (it flushed the pending text and
 * then went in as its own turn), so the agent answered the picture before it
 * ever read the question. The properties asserted here are the ones that make
 * the merged turn correct rather than merely fewer:
 *
 *   1. TEXT FIRST — the user's sentence is the leading block, because
 *      `dsh-session-title` titles a session from the leading text of the first
 *      message, and `[收到图片] @C:/…` is not a title;
 *   2. NOTHING IS DOWNLOADED BEFORE THE FLUSH — a held attachment that is
 *      dropped (identity change) must not leave a file or spend a request;
 *   3. THE CHANNEL NEVER HANGS — the wait always ends on the sentence, the cap,
 *      the attachment window, or the forced release, whichever comes first;
 *   4. OFF = THE OLD BEHAVIOUR, byte for byte — including the delivery wording:
 *      a file is a pointer in BOTH wordings, and no switch can turn its content
 *      back on (0.12's inlining is gone, not gated).
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

// The CDN is the one thing a unit test must not touch: both helpers are
// replaced with a fixed PNG-shaped payload and a pass-through "decrypt".
const downloadAndDecrypt = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
vi.mock("../src/weixin/media.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/weixin/media.js")>();
  return {
    ...original,
    parseAesKey: () => Buffer.alloc(16),
    downloadAndDecrypt: (...args: unknown[]) => downloadAndDecrypt(...args as []),
  };
});

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { ConfigStore } from "../src/config-store.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import { isHoldableMediaItem } from "../src/adapter/inbound.js";
import {
  formatHelp,
  isBypassSlashCommand,
  LOCAL_COMMAND_NAMES,
  parseAtCommand,
  parseCommandName,
  parseEnterCommand,
  parseFinalCommand,
  parseFlushCommand,
  parseHelpCommand,
  parseHistoryCommand,
  parseMediaCommand,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-media-"));
  const received: Array<{ blocks: Array<{ type: string; text?: string }>; at: number }> = [];
  const liveAgents = new Map<string, unknown>();
  const agentsService = {
    create: async (options: { sessionId: string }) => {
      const agent = {
        id: options.sessionId,
        status: "idle",
        options: { provider: "deepseek", model: "deepseek-chat" },
        followup: (m: { content: Array<{ type: string; text?: string }> }) => {
          received.push({ blocks: m.content, at: Date.now() });
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
  const cfg = {
    ...defaultConfig(),
    storageDir: dir,
    // Typing merge stays OFF unless a case asks for it: these cases are about
    // the attachment hold, and an armed silence window would only add noise.
    mergeEnabled: false,
    ...patch,
  };
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

function text(text: string, createTimeMs?: number) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    ...(createTimeMs !== undefined ? { create_time_ms: createTimeMs } : {}),
    item_list: [{ type: 1, text_item: { text } }],
  };
}

/** An image with no caption — the exact shape the hold exists for. */
function image(extra: Record<string, unknown> = {}) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "q", aes_key: "k" } } }],
    ...extra,
  };
}

/** An image that carries its own caption, as one WeChat message. */
function imageWithCaption(caption: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [
      { type: 1, text_item: { text: caption } },
      { type: 2, image_item: { media: { encrypt_query_param: "q", aes_key: "k" } } },
    ],
  };
}

function fileMsg(fileName = "report.csv") {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [
      { type: 4, file_item: { file_name: fileName, media: { encrypt_query_param: "q", aes_key: "k" } } },
    ],
  };
}

function voiceMsg() {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: "q", aes_key: "k" } } }],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const blockTexts = (m: { blocks: Array<{ text?: string }> }) => m.blocks.map((b) => b.text ?? "");

/** Wait until `count` dispatches happened (or the deadline passes). */
async function waitForDispatches(received: Array<unknown>, count: number, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (received.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  downloadAndDecrypt.mockClear();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const bridge of live.splice(0)) await bridge.stop().catch(() => {});
});

describe("media merge: the core path (image, then the sentence)", () => {
  it("image + following text produce ONE turn, with the text first", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);

    await inbound.handleMessage(image());
    // Nothing is delivered yet: the attachment is waiting for its sentence.
    expect(received).toHaveLength(0);
    await inbound.handleMessage(text("这张图里是什么？"));

    expect(received).toHaveLength(1);
    const texts = blockTexts(received[0]!);
    expect(texts[0]).toBe("这张图里是什么？");
    // TEXT FIRST is load-bearing: the host titles a session from the leading
    // text block, so the media notice must never be first.
    expect(texts[0]).not.toContain("[收到图片]");
    expect(texts[1]).toContain("[收到图片]");
  });

  it("the attachment is downloaded only at flush time", async () => {
    const { bridge } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(image());
    expect(downloadAndDecrypt).not.toHaveBeenCalled();
    await inbound.handleMessage(text("看看"));
    expect(downloadAndDecrypt).toHaveBeenCalledTimes(1);
  });

  it("two images then the sentence become ONE turn with both attachments", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(image());
    await inbound.handleMessage(image());
    await inbound.handleMessage(text("对比一下"));

    expect(received).toHaveLength(1);
    const texts = blockTexts(received[0]!);
    expect(texts[0]).toBe("对比一下");
    expect(texts.filter((t) => t.includes("[收到图片]"))).toHaveLength(2);
  });

  it("a file + the sentence also merge (not only images)", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(fileMsg("data.csv"));
    await inbound.handleMessage(text("统计行数"));

    expect(received).toHaveLength(1);
    expect(blockTexts(received[0]!)[0]).toBe("统计行数");
    expect(blockTexts(received[0]!).join("\n")).toContain("data.csv");
  });
});

describe("media merge: what is NOT held", () => {
  it("a media message that carries its own caption goes straight through", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(imageWithCaption("这张图有问题"));

    // It already says what it wants — waiting for another sentence would only
    // add latency, so the merged path must not swallow it.
    await waitForDispatches(received as unknown[], 1, 500);
    expect(received).toHaveLength(1);
    expect(blockTexts(received[0]!).join("\n")).toContain("这张图有问题");
  });

  it("voice is never held (it has no usable payload to merge)", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(voiceMsg());
    await waitForDispatches(received as unknown[], 1, 500);
    expect(received).toHaveLength(1);
  });

  it("with the switch OFF an image keeps the historical two-turn behaviour", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: false });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(image());
    await inbound.handleMessage(text("这张图里是什么？"));

    // Two turns, in the original order — byte for byte the 0.12 behaviour.
    expect(received).toHaveLength(2);
    expect(blockTexts(received[0]!)[0]).toContain("[收到图片]");
    expect(blockTexts(received[1]!)[0]).toBe("这张图里是什么？");
  });

  it("isHoldableMediaItem accepts image/file/video but not voice or a bare item", () => {
    expect(isHoldableMediaItem({ type: 2, image_item: { media: { encrypt_query_param: "q" } } })).toBe(true);
    expect(isHoldableMediaItem({ type: 4, file_item: { media: { encrypt_query_param: "q" } } })).toBe(true);
    expect(isHoldableMediaItem({ type: 5, video_item: { media: { encrypt_query_param: "q" } } })).toBe(true);
    expect(isHoldableMediaItem({ type: 3, voice_item: { media: { encrypt_query_param: "q" } } })).toBe(false);
    // No downloadable reference: holding it could only produce "下载失败".
    expect(isHoldableMediaItem({ type: 2, image_item: {} })).toBe(false);
    expect(isHoldableMediaItem(undefined)).toBe(false);
  });
});

describe("media merge: the wait always ends", () => {
  it("the attachment window delivers a lone image on its own", async () => {
    vi.useFakeTimers();
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 30_000 });
    await asInbound(bridge).handleMessage(image());
    expect(received).toHaveLength(0);

    // Halfway: still waiting for the sentence.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(received).toHaveLength(0);

    // Past the window: the picture goes out alone — an unanswered picture is
    // better than a channel that never answers.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(50);
    expect(received).toHaveLength(1);
  });

  it("the merged count cap forces a flush", async () => {
    const { bridge, received } = makeBridge({
      mediaMergeEnabled: true,
      mediaHoldMs: 60_000,
      mergeMaxMsgs: 2,
    });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(image());
    expect(received).toHaveLength(0);
    await inbound.handleMessage(image());
    await waitForDispatches(received as unknown[], 1, 500);
    expect(received).toHaveLength(1);
  });

  it("mediaHoldMs is bounded by mergeForcedReleaseMs", () => {
    const { bridge } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 600_000, mergeForcedReleaseMs: 5_000 });
    const value = (bridge as unknown as { mediaHoldMs(): number }).mediaHoldMs();
    expect(value).toBe(5_000);
  });
});

describe("media merge: delivery failures and lifecycle", () => {
  it("a failed download degrades to a text notice instead of losing the batch", async () => {
    downloadAndDecrypt.mockRejectedValueOnce(new Error("CDN down"));
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(image());
    await inbound.handleMessage(text("这是什么"));

    expect(received).toHaveLength(1);
    const joined = blockTexts(received[0]!).join("\n");
    expect(joined).toContain("这是什么");
    expect(joined).toContain("下载失败");
  });

  it("plugin dispose delivers a held attachment rather than destroying it", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    await asInbound(bridge).handleMessage(image());
    expect(received).toHaveLength(0);
    await bridge.stop();
    expect(received).toHaveLength(1);
  });

  it("logout drops the held attachment WITHOUT downloading anything", async () => {
    const { bridge, received, dir } = makeBridge({ mergeEnabled: true, mediaMergeEnabled: true });
    await asInbound(bridge).handleMessage(text("先说一句"));
    await asInbound(bridge).handleMessage(image());
    expect(received).toHaveLength(0);

    await bridge.logout();
    // Identity changed: the attachment belongs to a peer we no longer serve.
    expect(received).toHaveLength(0);
    expect(downloadAndDecrypt).not.toHaveBeenCalled();
    // The temp dir the download would have used is untouched (or absent).
    const tempDir = path.join(dir, "tempfile");
    const leftovers = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
    expect(leftovers).toEqual([]);
  });
});

describe("attachment delivery: a file is a pointer, never its bytes", () => {
  it("path mode is the default and announces an image as a plain path", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    await asInbound(bridge).handleMessage(image());
    await asInbound(bridge).handleMessage(text("看"));

    const mediaBlock = blockTexts(received[0]!)[1]!;
    expect(mediaBlock).toContain("[收到图片] 文件已保存到:");
    // The mention is opt-in: it only renders as a chip when the host has
    // `dsh-file-reference` mounted, so it is not the default spelling.
    expect(mediaBlock).not.toContain("@");
  });

  it("@ mode announces an image as a host @path reference", async () => {
    const { bridge, received } = makeBridge({
      mediaMergeEnabled: true,
      mediaHoldMs: 60_000,
      mediaAtRefEnabled: true,
    });
    await asInbound(bridge).handleMessage(image());
    await asInbound(bridge).handleMessage(text("看"));

    const mediaBlock = blockTexts(received[0]!)[1]!;
    expect(mediaBlock).toContain("[收到图片] @");
    // Prose wording belongs to `path` mode only.
    expect(mediaBlock).not.toContain("文件已保存到:");
    // Forward slashes only: a mention must not depend on the host OS.
    expect(mediaBlock).not.toContain("\\");
  });

  it("path mode is one line — no「你可以使用这个路径…」tail", async () => {
    downloadAndDecrypt.mockResolvedValueOnce(Buffer.from("hello", "utf-8"));
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    await asInbound(bridge).handleMessage(fileMsg("note.txt"));
    await asInbound(bridge).handleMessage(text("总结"));

    const mediaBlock = blockTexts(received[0]!).find((t) => t.includes("[收到文件:"))!;
    // A file notice is exactly one line: `FILE_REFERENCE_PROMPT` already tells
    // the model what a path is for, so a trailing instruction here would only
    // add noise to the bubble.
    expect(mediaBlock.split("\n")).toHaveLength(1);
    expect(mediaBlock).toContain("[收到文件: note.txt] 文件已保存到:");
    expect(mediaBlock).not.toContain("你可以使用这个路径");
    expect(mediaBlock).not.toContain("hello");
  });

  it("a text file's content is never inlined — in either wording", async () => {
    for (const style of [true, false] as const) {
      downloadAndDecrypt.mockResolvedValueOnce(Buffer.from("a,b\n1,2\n", "utf-8"));
      const { bridge, received } = makeBridge({
        mediaMergeEnabled: true,
        mediaHoldMs: 60_000,
        mediaAtRefEnabled: style,
      });
      await asInbound(bridge).handleMessage(fileMsg("data.csv"));
      await asInbound(bridge).handleMessage(text("统计"));

      const joined = blockTexts(received[0]!).join("\n");
      // A POINTER in both modes: the model reads the path when it needs the
      // bytes, so shipping them too would duplicate the file and (for a big
      // attachment) blow the context window. The wording is the only difference.
      expect(joined, `mediaAtRefEnabled=${style}`).toContain("[收到文件: data.csv]");
      expect(joined, `mediaAtRefEnabled=${style}`).toContain(
        style ? "@" : "文件已保存到:",
      );
      expect(joined).not.toContain("a,b\n1,2");
      expect(joined).not.toContain("文件内容");
    }
  });

  it("a large text file is not inlined either — size never enters the decision", async () => {
    // 1 MiB of "a": a `.log` that 0.12 would have pasted into the prompt whole.
    for (const style of [true, false] as const) {
      downloadAndDecrypt.mockResolvedValueOnce(Buffer.alloc(1024 * 1024, 0x61));
      const { bridge, received } = makeBridge({
        mediaMergeEnabled: true,
        mediaHoldMs: 60_000,
        mediaAtRefEnabled: style,
      });
      await asInbound(bridge).handleMessage(fileMsg("big.log"));
      await asInbound(bridge).handleMessage(text("看看"));

      const joined = blockTexts(received[0]!).join("\n");
      expect(joined, `mediaAtRefEnabled=${style}`).not.toContain("aaaaaaaa");
      expect(joined).toContain("[收到文件: big.log]");
      // The prompt stays one or two short lines, whatever the file size.
      expect(joined.length).toBeLessThan(400);
    }
  });

  it("a binary file gets the same pointer treatment", async () => {
    downloadAndDecrypt.mockResolvedValueOnce(Buffer.alloc(64 * 1024, 0x89));
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    await asInbound(bridge).handleMessage(fileMsg("photo.png"));
    await asInbound(bridge).handleMessage(text("看看"));

    const joined = blockTexts(received[0]!).join("\n");
    expect(joined).toContain("[收到文件: photo.png] 文件已保存到:");
    expect(joined).not.toContain("文件内容");
  });
});

describe("/media is wired exactly like /merge", () => {
  it("parses bare / on / off / at / path / status and the /md alias", () => {
    expect(parseMediaCommand("/media")).toEqual({ kind: "media", target: "status" });
    expect(parseMediaCommand("/md")).toEqual({ kind: "media", target: "status" });
    expect(parseMediaCommand("/MEDIA STATUS")).toEqual({ kind: "media", target: "status" });
    expect(parseMediaCommand("/media on")).toEqual({ kind: "media", target: "merge", mode: "on" });
    expect(parseMediaCommand("/md off")).toEqual({ kind: "media", target: "merge", mode: "off" });
    // `at|path` only picks the WORDING; it does not change what the prompt
    // carries (a pointer either way), so it stays a plain sub-command.
    expect(parseMediaCommand("/media at")).toEqual({ kind: "media", target: "ref", style: "at" });
    expect(parseMediaCommand("/media path")).toEqual({ kind: "media", target: "ref", style: "path" });
    expect(parseMediaCommand("/md AT")).toEqual({ kind: "media", target: "ref", style: "at" });
    expect(parseMediaCommand("/media maybe")).toBeNull();
    expect(parseMediaCommand("/medial")).toBeNull();
  });

  it("no OTHER parser claims /media or /md (alias-collision guard)", () => {
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
      ["merge", parseMergeCommand],
      ["at", parseAtCommand],
    ];
    for (const input of ["/media", "/media on", "/media off", "/media at", "/media path", "/md"]) {
      for (const [name, parser] of others) {
        const result = parser(input);
        const claimed = result !== null && result !== false && result !== undefined;
        expect(claimed, `${name} must not claim ${input}`).toBe(false);
      }
      expect(parseMediaCommand(input)).not.toBeNull();
      expect(parseCommandName(input)).toBe(input.trim().split(" ")[0]!.slice(1));
    }
  });

  it("bypasses a pending card, is de-duplicated against native commands, and is in /help", () => {
    expect(isBypassSlashCommand("/media")).toBe(true);
    expect(isBypassSlashCommand("/media on")).toBe(true);
    expect(isBypassSlashCommand("/md at")).toBe(true);
    expect(LOCAL_COMMAND_NAMES.has("media")).toBe(true);
    expect(LOCAL_COMMAND_NAMES.has("md")).toBe(true);
    expect(formatHelp()).toContain("/media on|off|at|path (md)");
  });

  it("/media on/off/at/path persist to config.json and switch the live config", async () => {
    const { bridge, cfg } = makeBridge();
    const store = new ConfigStore(cfg.storageDir);
    (bridge as unknown as { configStore?: unknown }).configStore = store;
    const inbound = asInbound(bridge);

    await inbound.handleMessage(text("/media on"));
    expect(store.stored().mediaMergeEnabled).toBe(true);
    expect((bridge as unknown as { config: { mediaMergeEnabled: boolean } }).config.mediaMergeEnabled).toBe(true);

    await inbound.handleMessage(text("/media path"));
    expect(store.stored().mediaAtRefEnabled).toBe(false);
    expect((bridge as unknown as { config: { mediaAtRefEnabled: boolean } }).config.mediaAtRefEnabled).toBe(false);

    await inbound.handleMessage(text("/media at"));
    expect(store.stored().mediaAtRefEnabled).toBe(true);

    await inbound.handleMessage(text("/media off"));
    expect(store.stored().mediaMergeEnabled).toBe(false);

    const replies = sendTextMessage.mock.calls.map((c) => String(c[1])).join("\n");
    expect(replies).toContain("图片/文件合并已开启");
    expect(replies).toContain("@引用");
    expect(replies).toContain("图片/文件合并已关闭");
  });

  it("/media off flushes what it was holding before switching off", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(image());
    expect(received).toHaveLength(0);

    await inbound.handleMessage(text("/media off"));
    // "Stop waiting for me" is not "throw the picture away".
    expect(received).toHaveLength(1);
    expect(blockTexts(received[0]!).join("\n")).toContain("[收到图片]");
  });

  it("turning the switch off from the settings page also flushes the hold", async () => {
    const { bridge, received } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    await asInbound(bridge).handleMessage(image());
    expect(received).toHaveLength(0);

    await bridge.updateConfig({ mediaMergeEnabled: false });
    expect(received).toHaveLength(1);
    expect((bridge as unknown as { config: { mediaMergeEnabled: boolean } }).config.mediaMergeEnabled).toBe(false);
  });
});

describe("/status reports the media switches", () => {
  it("shows the off state and the delivery wording by default", async () => {
    const { bridge } = makeBridge();
    await asInbound(bridge).handleMessage(text("/status"));
    const status = sendTextMessage.mock.calls.map((c) => String(c[1])).find((t) => t.includes("图片/文件合并"));
    expect(status).toBeTruthy();
    expect(status).toContain("图片/文件合并");
    expect(status).toContain("off");
    // Plain path is the default spelling; `@引用` is opt-in via `/media at`.
    expect(status).toContain("交付: 路径");
  });

  it("reports @引用 once /media at switches it", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/media at"));
    await inbound.handleMessage(text("/status"));
    const status = sendTextMessage.mock.calls.map((c) => String(c[1])).find((t) => t.includes("交付: @引用"));
    expect(status).toBeTruthy();
  });

  it("shows the held count while an attachment waits", async () => {
    const { bridge } = makeBridge({ mediaMergeEnabled: true, mediaHoldMs: 60_000 });
    await asInbound(bridge).handleMessage(image());
    await asInbound(bridge).handleMessage(text("/status"));
    const status = sendTextMessage.mock.calls.map((c) => String(c[1])).find((t) => t.includes("图片/文件合并"));
    expect(status).toContain("暂存 1 个附件");
    expect(status).toContain("等待 60s");
  });
});

describe("interaction with 打字合并", () => {
  it("text → image → text becomes ONE turn when both features are on", async () => {
    const { bridge, received } = makeBridge({
      mergeEnabled: true,
      mergeSilenceMs: 60_000,
      mediaMergeEnabled: true,
      mediaHoldMs: 60_000,
    });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("帮我看看"));
    // The image JOINS the open text batch instead of flushing it.
    await inbound.handleMessage(image());
    await inbound.handleMessage(text("这张图有问题吗"));
    await waitForDispatches(received as unknown[], 1, 1500);

    expect(received).toHaveLength(1);
    const texts = blockTexts(received[0]!);
    expect(texts[0]).toContain("帮我看看");
    expect(texts[0]).toContain("这张图有问题吗");
    expect(texts[1]).toContain("[收到图片]");
  });

  it("with media merge off, an image still flushes the open text batch first", async () => {
    const { bridge, received } = makeBridge({ mergeEnabled: true, mergeSilenceMs: 60_000 });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("先说的话"));
    await inbound.handleMessage(image());
    await waitForDispatches(received as unknown[], 2, 1500);

    // Order preserved: words first, then the picture, as two turns.
    expect(received.map((m) => blockTexts(m).join(" | "))).toEqual([
      "先说的话",
      expect.stringContaining("[收到图片]"),
    ]);
  });

  it("an image joined to a buffered sentence cancels that sentence's silence timer", async () => {
    // The picture makes the batch wait for a caption, so the per-message
    // silence window no longer decides anything — only the attachment window
    // (and the forced release) may deliver now. Without this, a 3 s silence
    // would fire mid-wait and ship "帮我看看" without the picture it belongs to.
    vi.useFakeTimers();
    const { bridge, received } = makeBridge({
      mergeEnabled: true,
      mergeSilenceMs: 3_000,
      mediaMergeEnabled: true,
      mediaHoldMs: 30_000,
      mergeForcedReleaseMs: 120_000,
    });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("帮我看看"));
    await inbound.handleMessage(image());
    expect(received).toHaveLength(0);

    // Past the silence window, still inside the attachment window: nothing yet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(received).toHaveLength(0);

    // The caption dispatches the whole batch.
    await inbound.handleMessage(text("这张图里的报错是什么"));
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toHaveLength(1);
    expect(blockTexts(received[0]!)[0]).toContain("这张图里的报错是什么");
  });
});
