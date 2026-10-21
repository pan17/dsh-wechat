/**
 * `/help <命令>` — one command's full example list, on demand.
 *
 * The WeChat `/help` reply used to be a single wall of every command AND every
 * example (96 lines). It is now two levels:
 *
 *   `/help`        → a 44-line listing: one row per command, plus its
 *                    subcommands. Scannable on a phone.
 *   `/help s`      → only `/session`'s 11 examples, each with its own note.
 *   `/help fuck`   → "没有 /fuck 这条命令" + the listing.
 *
 * The interesting failures are at the seams, and these cases pin them:
 *
 *   - a bare command must keep its OWN meaning (`/s list` is still a list, not
 *     a help lookup) — the whole feature is additive;
 *   - a help request is never answered with "未知命令 /help", whatever follows
 *     it (the user is asking for help — denying that is the worst reply);
 *   - only a SENTENCE (`/help me write a test`) goes to the agent;
 *   - the topic may be the command name or any documented alias, and both must
 *     produce byte-identical output.
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
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import { helpCatalog } from "../src/help-catalog.js";
import { formatHelp, helpTopicBlock } from "../src/bridge/slash.js";

const catalog = helpCatalog();

function makeMockAgent(id: string) {
  const received: Array<{ content: unknown; source: unknown }> = [];
  return {
    agent: {
      id,
      status: "idle",
      options: { provider: "deepseek", model: "deepseek-chat" },
      followup: (m: { content: unknown; source: unknown }) => received.push(m),
      steer: () => {},
      cancel: () => {},
      whenIdle: async () => {},
    },
    received,
  };
}

function makeBridge(opts: { agent: { agent: unknown; received: unknown[] }; commands?: unknown }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-helptopic-"));
  const agentsService = {
    create: async () => opts.agent,
    resume: async () => opts.agent,
    get: (id: string) => (id === (opts.agent.agent as { id: string }).id ? opts.agent.agent : undefined),
    list: () => [opts.agent.agent],
  };
  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "commands" && opts.commands) return opts.commands;
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
  if (opts.commands) bridge.attachCommands(opts.commands as never);
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

async function send(bridge: WeChatDSHBridge, text: string) {
  await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
    wechatTextMessage(text),
  );
}

/** The last text reply the bridge sent, or "" when it sent none. */
function lastReply(): string {
  const calls = sendTextMessage.mock.calls;
  if (calls.length === 0) return "";
  return (calls[calls.length - 1]! as [string, string])[1];
}

describe("/help <命令>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the listing for a bare /help", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/help");
    expect(lastReply()).toBe(formatHelp([]));
  });

  it("sends one command's examples for /help <name>", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/help session");
    expect(lastReply()).toBe(helpTopicBlock("session"));
    // Not the listing: no other command appears.
    expect(lastReply()).not.toContain("**/workspace**");
  });

  it("accepts any documented alias and produces identical output", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/help session");
    const viaName = lastReply();
    vi.clearAllMocks();
    await send(bridge, "/help s");
    expect(lastReply()).toBe(viaName);
    vi.clearAllMocks();
    await send(bridge, "/help S");
    expect(lastReply()).toBe(viaName);
  });

  it("lists every command of the catalog through its own topic", async () => {
    // One round-trip per command: a topic that resolves in the pure renderer
    // but not through the bridge would be a wiring bug the unit test cannot
    // see.
    for (const entry of catalog.commands) {
      const mock = makeMockAgent("wx-s1");
      const bridge = makeBridge({ agent: mock });
      vi.clearAllMocks();
      await send(bridge, `/help ${entry.command.slice(1)}`);
      const reply = lastReply();
      expect(reply, entry.command).toBe(helpTopicBlock(entry.command));
      expect(reply, entry.command).toContain(entry.summary);
    }
  });

  it("answers an unknown topic with the listing, not 未知命令", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/help nope");
    const reply = lastReply();
    // `/help nope` is a help request with a bad name. Answering "未知命令
    // /help" denies the one thing the user asked for; the reply has to name
    // the bad topic AND still show what is available.
    expect(reply).toContain("没有 /nope 这条命令");
    expect(reply).toContain("DSH 微信助手 · 指令帮助");
    expect(reply).not.toContain("未知命令");
    // Never forwarded to the agent: the user wanted help, not an answer.
    expect(mock.received).toHaveLength(0);
  });

  it("does not treat /help fuck as chat", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/help fuck");
    expect(lastReply()).toContain("没有 /fuck 这条命令");
    expect(mock.received).toHaveLength(0);
  });

  it("answers a /help sentence the same way, without forwarding it", async () => {
    // "/help me write a test" is a sentence, but it starts with `/help` — the
    // help verb. Answering it with "未知命令 /help" or forwarding it to the
    // model both mean the user asked for help and got something else.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/help me write a test");
    const reply = lastReply();
    expect(reply).toContain("没有 /me write a test 这条命令");
    expect(reply).toContain("DSH 微信助手 · 指令帮助");
    expect(reply).not.toContain("未知命令");
    expect(mock.received).toHaveLength(0);
  });

  it("does not hijack a real subcommand", async () => {
    // `/s list` must still list sessions. A help layer that matched the
    // leading name alone would swallow it.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/s list");
    const reply = lastReply();
    expect(reply).not.toBe(helpTopicBlock("s"));
    expect(reply).not.toContain("发 `/help` 看其它命令。");
  });

  it("does not hijack a bare command that already had a meaning", async () => {
    // `/silent` reports status today; only `/help silent` is a lookup.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/silent");
    const reply = lastReply();
    expect(reply).not.toBe(helpTopicBlock("silent"));
  });

  it("bypasses a pending card, like every other local command", async () => {
    // A `/help s` typed while an approval card is waiting is never the card's
    // answer — it must reach the help handler.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    const pending = bridge as unknown as {
      pendingApprovals: Map<string, unknown>;
      answerableApprovals: (userId: string) => unknown[];
    };
    expect(typeof pending.answerableApprovals).toBe("function");
    await send(bridge, "/help s");
    expect(lastReply()).toBe(helpTopicBlock("s"));
  });
});

describe("a documented command never answers 未知命令", () => {
  // The listing prints `/model`; answering "未知命令 /model" to `/model` tells
  // the user the opposite of what the help just said. Bare forms report
  // status, and a bad ARGUMENT reports the usage line.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const command of ["/model", "/s", "/ws", "/p", "/perm", "/reasoning", "/enter", "/notify", "/surface", "/at", "/history", "/silent", "/merge", "/media", "/final"]) {
    it(`answers bare ${command} without the unknown-command hint`, async () => {
      const mock = makeMockAgent("wx-s1");
      const bridge = makeBridge({ agent: mock });
      await send(bridge, command);
      expect(lastReply(), command).not.toContain("未知命令");
      // A bare documented command must never reach the agent as chat.
      expect(mock.received, command).toHaveLength(0);
    });
  }

  it("answers /model foo with the usage line, not 未知命令", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/model foo");
    const reply = lastReply();
    expect(reply).toContain("用法");
    expect(reply).not.toContain("未知命令");
  });

  it("still flags a genuinely unknown command", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge({ agent: mock });
    await send(bridge, "/nope");
    expect(lastReply()).toContain("未知命令");
    expect(mock.received).toHaveLength(1);
  });
});
