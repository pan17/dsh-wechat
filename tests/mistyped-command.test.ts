/**
 * A mistyped subcommand of a command the bridge OWNS never reaches the agent.
 *
 * The motivating report: `/s lsit`, `/workspace swich`, `/model foo` were all
 * answered with the usage line AND forwarded to the model anyway, because the
 * hint branch fell through to `enqueueInbound`. The agent then answered a
 * sentence the user never meant to say, the typo landed in the transcript, and
 * every later turn had to work around it — the polluted context this suite
 * exists to prevent.
 *
 * The line drawn here:
 *
 *   - the PARENT matched (`/s`, `/workspace`, …) → answer the command, never
 *     forward. A wrong subcommand, a wrong argument, a missing space and a
 *     long spelling `/help` does not print (`/permission`, `/busy`) are all
 *     still the parent command;
 *   - the NAME matched nothing (`/nope`) or belongs to the host (`/plan`,
 *     `/goal`, `/compact`) → unchanged: hint + forward, because an
 *     unregistered native name may be a real prompt.
 *
 * Two seams are pinned as well:
 *
 *   1. a mistyped line must BYPASS a pending question/approval card — it is a
 *      command attempt, never the card's free-text answer;
 *   2. a real line must never be caught by the heuristic: `/s list`,
 *      `/histories`-looking prose and every documented example still execute
 *      normally (the catalog test asserts the examples, this one the parsers).
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
import {
  commandUsageHint,
  isBypassSlashCommand,
  isMistypedLocalCommand,
} from "../src/bridge/slash.js";

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

function makeBridge(agent: ReturnType<typeof makeMockAgent>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-mistyped-"));
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
  // One message = one turn: the merge window has its own suite and would only
  // add a timer to wait on here.
  cfg.mergeSilenceMs = 0;
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

async function send(bridge: WeChatDSHBridge, text: string) {
  await (bridge as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage(
    wechatTextMessage(text),
  );
}

/** Every text reply the bridge sent in this case, in order. */
function replies(): string[] {
  return sendTextMessage.mock.calls.map((call) => (call as [string, string])[1]);
}

function lastReply(): string {
  const all = replies();
  return all.length === 0 ? "" : all[all.length - 1]!;
}

// ─── Pure resolver ─────────────────────────────────────────────────────────

describe("isMistypedLocalCommand / commandUsageHint", () => {
  it("flags a wrong subcommand under a name the bridge owns", () => {
    for (const line of [
      "/s lsit",
      "/session lsit",
      "/workspace swich 2",
      "/ws swtich",
      "/p swich",
      "/model foo",
      "/perm swtich",
      "/reasoning hihg",
      "/enter quueue",
      "/notify tasks bogus",
      "/status briefx",
      "/steps onn",
      "/merge onn",
      "/media onn",
      "/surface onn",
      "/history abc",
      // The old `/history` grammar (bare count / `all` = system messages) is
      // gone; both must reach the usage reply rather than be reinterpreted.
      "/history 10",
      "/history all 10",
      "/history switch 2",
      "/stop now",
    ]) {
      expect(isMistypedLocalCommand(line), line).toBe(true);
    }
  });

  it("flags long spellings /help never prints but the parsers accept", () => {
    // `/permission` and `/busy` are synonyms, so they have no catalog row and
    // used to fall through to the agent on any typo in their argument.
    expect(isMistypedLocalCommand("/permission bogus")).toBe(true);
    expect(isMistypedLocalCommand("/busy bogus")).toBe(true);
    expect(isMistypedLocalCommand("/watch bogus")).toBe(true);
    expect(isMistypedLocalCommand("/wxprompt bogus")).toBe(true);
    expect(isMistypedLocalCommand("/rp extra words")).toBe(true);
  });

  it("flags a missing space between the command and its subcommand", () => {
    // `/workspacelist` is `list` glued to its parent: the reply names the
    // command it probably meant instead of forwarding a mystery token.
    expect(isMistypedLocalCommand("/workspacelist")).toBe(true);
    expect(isMistypedLocalCommand("/sessionlist")).toBe(true);
    expect(isMistypedLocalCommand("/wslist")).toBe(true);
    // A short parent only counts in front of a REAL subcommand, so prose is
    // not claimed by accident.
    expect(isMistypedLocalCommand("/mdx")).toBe(false);
    expect(isMistypedLocalCommand("/sandbox")).toBe(false);
    // `/stats` is a one-edit typo of `/status`, so it IS claimed — by the
    // name-correction rule rather than the glue rule, and the reply asks
    // instead of asserting.
    expect(commandUsageHint("/stats")).toContain("你是想发 /status 吗");
  });

  it("treats a plural of a real command as that command", () => {
    // `/models` is not a new command, and guessing what a plural should do is
    // worse than showing the singular's usage.
    expect(isMistypedLocalCommand("/models")).toBe(true);
    expect(isMistypedLocalCommand("/sessions")).toBe(true);
    expect(isMistypedLocalCommand("/workspaces")).toBe(true);
    expect(commandUsageHint("/models")).toContain("用法: /model");
    // A plural of a name NOBODY here owns stays with the agent: `/plans` may
    // be a question, and `/plan` is a native command this profile may lack.
    expect(isMistypedLocalCommand("/plans")).toBe(false);
    expect(isMistypedLocalCommand("/notes")).toBe(false);
  });

  it("corrects a misspelled NAME only when the guess is unambiguous", () => {
    // Long names are corrected: the typo is the overwhelmingly likely
    // explanation, and the reply ASKS rather than asserts.
    expect(isMistypedLocalCommand("/stauts")).toBe(true);
    expect(commandUsageHint("/stauts")).toContain("你是想发 /status 吗");
    expect(commandUsageHint("/sessoin list")).toContain("你是想发 /session 吗");
    expect(commandUsageHint("/wrokspace list")).toContain("你是想发 /workspace 吗");
    expect(commandUsageHint("/modle foo")).toContain("你是想发 /model 吗");
    // A four-letter target is reachable only from a LONGER input, which is the
    // shape of a typo rather than a different word.
    expect(commandUsageHint("/stopp")).toContain("你是想发 /stop 吗");
    // Short names are never corrected: `/plan`, `/foo` and `/etc` sit one or
    // two edits from real commands, and claiming them would break the promise
    // that an unregistered `/xxx` may be prose for the model.
    for (const line of ["/plan", "/goal", "/foo", "/etc", "/nope", "/nex", "/flus"]) {
      expect(isMistypedLocalCommand(line), line).toBe(false);
    }
  });

  it("never flags a line a parser accepts", () => {
    // The guard runs BEFORE the dispatch chain, so a false positive here would
    // hijack a working command.
    for (const line of [
      // Every parser's own accepted shapes, one per entry.
      "/help", "/help s", "/?", "/status", "/status brief",
      "/steps", "/steps 极简", "/steps 简洁", "/steps 标准", "/steps status",
      "/merge status", "/media at", "/surface on", "/stop", "/next",
      "/flush", "/f", "/notify on", "/notify tasks off", "/rq", "/rp",
      "/workspace", "/workspace list", "/ws switch 2", "/workspace add C:\\repo",
      "/session", "/s list", "/s list current 50", "/s switch 3", "/s pin", "/s new",
      "/preset switch build", "/p list", "/model", "/model switch deepseek/deepseek-chat",
      "/perm default read-only", "/reasoning switch high", "/enter queue",
      "/history", "/history list all", "/history list 10", "/history show 2",
      "/at", "/at s 2", "/at f src/index.ts",
    ]) {
      expect(isMistypedLocalCommand(line), line).toBe(false);
      expect(commandUsageHint(line), line).toBeNull();
    }
  });

  it("leaves a name nobody owns alone (it still goes to the agent)", () => {
    for (const line of [
      "/nope",
      // Removed commands are no longer local: they now look like any other
      // unregistered `/xxx` and go to the agent.
      "/silent on",
      "/final on",
      "/plan off",
      "/goal 写一个 demo",
      "/compact extra",
      "/frobnicate 1",
      // A chat line that merely starts with a slash, like a path or a date.
      "/etc/hosts",
      "/2024-01-01",
    ]) {
      expect(isMistypedLocalCommand(line), line).toBe(false);
      expect(commandUsageHint(line), line).toBeNull();
    }
  });

  it("answers a mistyped line with the parent's grammar and examples", () => {
    const session = commandUsageHint("/s lsit")!;
    expect(session).toContain("没有转发给 agent");
    expect(session).toContain("用法: /session list");
    expect(session).toContain("/s list");
    expect(session).toContain("/help s 看全部例子");

    // A long spelling is answered under its shortest documented one.
    const perm = commandUsageHint("/permission bogus")!;
    expect(perm).toContain("用法: /perm status");
    expect(perm).toContain("/help perm");

    // `/rp` has no catalog row — its clause lives in `/rq`'s usage.
    expect(commandUsageHint("/rp extra words")).toContain("/rp");
  });

  it("names the glued spelling as a missing space", () => {
    const hint = commandUsageHint("/workspacelist")!;
    expect(hint).toContain("少了空格");
    expect(hint).toContain("/workspace list");
    expect(hint).toContain("没有转发给 agent");
    expect(commandUsageHint("/wslist")).toContain("少了空格");
  });

  it("keeps a very long line readable instead of echoing it whole", () => {
    const hint = commandUsageHint(`/s ${"x".repeat(400)}`)!;
    expect(Array.from(hint).length).toBeLessThan(400);
    expect(hint).toContain("…");
  });

  it("bypasses a pending card, like every other command line", () => {
    // `/rq` and `/rp` keep their card semantics: the bypass check belongs to
    // commands whose only effect is "answer with usage".
    expect(isBypassSlashCommand("/s lsit")).toBe(true);
    expect(isBypassSlashCommand("/workspacelist")).toBe(true);
    expect(isBypassSlashCommand("/model foo")).toBe(true);
    expect(isBypassSlashCommand("/rp")).toBe(false);
    expect(isBypassSlashCommand("/rq")).toBe(false);
    // A name nobody owns stays a card answer: the card handler may legitimately
    // want the text.
    expect(isBypassSlashCommand("/nope")).toBe(false);
  });
});

// ─── Through the bridge ────────────────────────────────────────────────────

describe("a mistyped command is answered, never forwarded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases = [
    "/s lsit",
    "/workspace swich 2",
    "/model foo",
    "/perm swtich 2",
    "/p swich build",
    "/reasoning hihg",
    "/enter quueue",
    "/notify tasks bogus",
    "/steps onn",
    "/status briefx",
    "/history abc",
    "/workspacelist",
    "/permission bogus",
    "/stauts",
    "/models",
  ];

  for (const line of cases) {
    it(`answers ${line} with usage and does not reach the agent`, async () => {
      const mock = makeMockAgent("wx-s1");
      const bridge = makeBridge(mock);
      await send(bridge, line);
      // The whole point: ZERO turns spent on the typo.
      expect(mock.received, line).toHaveLength(0);
      const reply = lastReply();
      expect(reply, line).toContain("用法");
      expect(reply, line).toContain("没有转发给 agent");
      expect(reply, line).not.toContain("未知命令");
    });
  }

  it("still forwards a name nobody owns", async () => {
    // The old contract survives for real chat and for native commands that
    // are not registered in this profile.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    await send(bridge, "/foo bar");
    expect(mock.received).toHaveLength(1);
    expect(lastReply()).toContain("未知命令 /foo");
  });

  it("never routes a working command through the hint", async () => {
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    await send(bridge, "/s list");
    expect(lastReply()).not.toContain("没有转发给 agent");
    // `/s list` needs the workspace/session services; this harness has only
    // `agents`, so the assertion is that the COMMAND handled it (the hint
    // never fired), not what it rendered.
    expect(lastReply()).not.toContain("用法:");
  });

  it("bypasses a pending approval card", async () => {
    // A typo typed while a card waits used to be submitted as the card's
    // free-text answer — one mistake, two losses.
    const mock = makeMockAgent("wx-s1");
    const bridge = makeBridge(mock);
    const pending = bridge as unknown as {
      pendingApprovals: Map<string, Array<{ rpcId: string; sessionId: string; timer: NodeJS.Timeout }>>;
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
    };
    pending.state.ensureUser("u1", "C:\\work");
    pending.state.update("u1", { sessionId: "wx-s1" });
    pending.pendingApprovals.set("u1", [
      { rpcId: "rpc-1", sessionId: "wx-s1", timer: setTimeout(() => {}, 30_000) },
    ]);
    try {
      await send(bridge, "/s lsit");
      const reply = lastReply();
      expect(reply).toContain("用法");
      expect(reply).not.toContain("权限卡");
      // The card is untouched: no decision was applied to it.
      expect(pending.pendingApprovals.get("u1") ?? []).toHaveLength(1);
      expect(mock.received).toHaveLength(0);
    } finally {
      for (const card of pending.pendingApprovals.get("u1") ?? []) clearTimeout(card.timer);
    }
  });
});
