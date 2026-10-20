/**
 * `/at` — stage a session or file reference for the next WeChat message.
 *
 * The feature is the WeChat stand-in for the GUI composer's `@` completion:
 * `/at` stages, the NEXT delivered message carries the mention, and the host
 * (`dsh-session-reference` / `dsh-file-reference-local`) turns it into model
 * context. Three properties matter and are asserted directly:
 *
 *   1. the staged mention is byte-compatible with the host grammar, because a
 *      malformed mention is FATAL for the turn at `agent/pre-step`;
 *   2. the reference is consumed exactly once, by the next message only;
 *   3. every rejection (self-reference, fourth session, out-of-workspace
 *      path, unknown service) happens at `/at` time — before anything is sent.
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
import { MessageType } from "../src/weixin/types.js";
import {
  buildMentionBlock,
  encodeSessionReferenceUri,
  escapeMentionLabel,
  formatFileMention,
  formatSessionMention,
  hasInvisibleMarks,
  normalizeAtTarget,
} from "../src/bridge/at-refs.js";
import {
  formatHelp,
  isAtCommandAttempt,
  isBypassSlashCommand,
  LOCAL_COMMAND_NAMES,
  parseAtCommand,
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

interface HarnessOptions {
  /** Sessions `sessionQuery.listSessions()` reports. */
  sessions?: Array<{ id: string; cwd?: string; createdAt?: number; title?: string }>;
  /** Omit to simulate a host without `dsh-session-reference`. */
  withSessionReference?: boolean;
  /** Omit to simulate a host without `dsh-file-reference`. */
  fileCandidates?: Array<{ path: string; kind: "file" | "directory" }>;
  /** Working directory of the bound session. */
  cwd?: string;
  /** `agents.create/resume` rejects (session cannot be ensured). */
  agentFails?: boolean;
  patch?: Record<string, unknown>;
}

type Patch = Record<string, unknown>;

/**
 * Build a bridge whose `sessionQuery` reports `sessions` and whose agents
 * service records every delivered message.
 */
function makeBridge(options: HarnessOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-at-"));
  const cwd = options.cwd ?? dir;
  const received: Array<{ content: Array<{ type: string; text?: string }>; source: unknown }> = [];
  const liveAgents = new Map<string, unknown>();

  const agent = {
    id: "session-current",
    status: "idle",
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { id: "session-current", cwd }, snapshotEvents: () => [] },
    followup: (m: { content: Array<{ type: string; text?: string }>; source: unknown }) => {
      received.push(m);
    },
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: async (task: () => Promise<unknown>) => task(),
  };
  liveAgents.set(agent.id, agent);

  const agentsService = {
    create: async (opts: { sessionId: string }) => {
      if (options.agentFails) throw new Error("create failed");
      const created = { ...agent, id: opts.sessionId };
      liveAgents.set(opts.sessionId, created);
      return { agent: created };
    },
    resume: async (opts: { resumeSessionId: string }) => {
      if (options.agentFails) throw new Error("resume failed");
      const resumed = { ...agent, id: opts.resumeSessionId };
      liveAgents.set(opts.resumeSessionId, resumed);
      return { agent: resumed };
    },
    get: (id: string) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  };

  const declared = options.sessions ?? [
    { id: "session-current", cwd, createdAt: 3 },
    { id: "session-alpha", cwd, createdAt: 2, title: "Alpha 重构" },
    { id: "session-beta", cwd: "C:\\other", createdAt: 1, title: "Beta 修复" },
  ];
  const sessions = declared.map((s) => ({
    header: {
      id: s.id,
      createdAt: s.createdAt ?? 1,
      version: 1,
      ...(s.cwd ? { cwd: s.cwd } : {}),
    },
    live: false,
    persisted: true,
  }));
  const titles = new Map<string, string>();
  for (const s of declared) {
    if (s.title) titles.set(s.id, s.title);
  }

  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "sessionQuery") {
        return {
          listSessions: async () => sessions,
          readTitle: async (id: string) => ({ title: titles.get(id) }),
          listEvents: async () => [],
          readSession: async () => ({ events: [] }),
        };
      }
      if (name === "sessionReferenceResolver") {
        return options.withSessionReference === false
          ? undefined
          : {
              // Faithful to the host: self is excluded, and the query filters
              // case-insensitively over id / cwd / label / displayTitle.
              listCandidates: async (_agent: unknown, query = "") => {
                const needle = query.toLocaleLowerCase();
                return sessions
                  .filter((s) => s.header.id !== "session-current")
                  .filter((s) => {
                    if (!needle) return true;
                    const label = (titles.get(s.header.id) ?? s.header.id).toLocaleLowerCase();
                    return s.header.id.toLocaleLowerCase().includes(needle)
                      || (s.header.cwd ?? "").toLocaleLowerCase().includes(needle)
                      || label.includes(needle);
                  })
                  .map((s) => ({
                    sessionId: s.header.id,
                    label: titles.get(s.header.id) ?? s.header.id,
                    ...(s.header.cwd ? { cwd: s.header.cwd } : {}),
                  }));
              },
            };
      }
      // Title source: the host's durable projection cache is what
      // `readSessionListFacts` consults before touching a log, and it is the
      // only title source available for a cold session in this harness (there
      // is no real session directory on disk to fold).
      if (name === "sessionProjectionCache") {
        return {
          cachedSnapshot: (header: { id: string }) => {
            const title = titles.get(header.id);
            return title === undefined ? undefined : { values: { title } };
          },
        };
      }
      if (name === "fileReferences") {
        return options.fileCandidates === undefined
          ? undefined
          : {
              list: async (_agent: unknown, query: string) =>
                options.fileCandidates!.filter((c) => c.path.includes(query)),
            };
      }
      return undefined;
    },
    on: () => () => {},
  };

  const cfg = {
    ...defaultConfig(),
    storageDir: dir,
    cwd,
    mergeSilenceMs: 0,
    ...(options.patch ?? {}),
  } as typeof defaultConfig extends never ? never : ReturnType<typeof defaultConfig>;
  const bridge = new WeChatDSHBridge(ctx as never, { ...cfg, ...(options.patch ?? {}) } as never);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  live.push(bridge);
  return { bridge, received, dir, cwd };
}

function text(body: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text: body } }],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const replies = () => sendTextMessage.mock.calls.map((call) => call[1] as string);
const lastReply = () => replies().at(-1) ?? "";
const deliveredText = (received: Array<{ content: Array<{ text?: string }> }>) =>
  received.map((m) => m.content.map((b) => b.text ?? "").join(""));

/**
 * Bind the peer to a session id the harness knows, so `agents.get()` finds the
 * live agent (a reference hint that needs a live agent only exists once the
 * session is actually bound — which is the normal state after one message).
 */
function bindSession(bridge: unknown, sessionId = "session-current") {
  const anyBridge = bridge as unknown as {
    state: {
      ensureUser(u: string, c: string): { userId: string };
      update(u: string, p: unknown): void;
    };
  };
  anyBridge.state.ensureUser("u1", "C:\\work");
  anyBridge.state.update("u1", { sessionId });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue(undefined);
  sendMediaMessage.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const bridge of live.splice(0)) await bridge.stop().catch(() => {});
});

// ─── Parsing ────────────────────────────────────────────────────────────────

describe("/at parsing", () => {
  it("bare /at and /at list open the staging table", () => {
    expect(parseAtCommand("/at")).toEqual({ kind: "list" });
    expect(parseAtCommand("  /at  ")).toEqual({ kind: "list" });
    expect(parseAtCommand("/at list")).toEqual({ kind: "list" });
    expect(parseAtCommand("/at ls")).toEqual({ kind: "list" });
    expect(parseAtCommand("/AT LIST")).toEqual({ kind: "list" });
  });

  it("parses clear / rm", () => {
    expect(parseAtCommand("/at clear")).toEqual({ kind: "clear" });
    expect(parseAtCommand("/at reset")).toEqual({ kind: "clear" });
    expect(parseAtCommand("/at rm 2")).toEqual({ kind: "remove", index: 2 });
    expect(parseAtCommand("/at remove 12")).toEqual({ kind: "remove", index: 12 });
    // A non-numeric or zero index is not a command: the caller shows usage.
    expect(parseAtCommand("/at rm x")).toBeNull();
    expect(parseAtCommand("/at rm 0")).toBeNull();
    expect(parseAtCommand("/at rm")).toBeNull();
  });

  it("keeps the raw rest-of-line as the session target", () => {
    expect(parseAtCommand("/at s 2")).toEqual({ kind: "session", target: "2" });
    expect(parseAtCommand("/at session Alpha 重构")).toEqual({
      kind: "session",
      target: "Alpha 重构",
    });
    // A missing target still parses so the handler can print usage.
    expect(parseAtCommand("/at s")).toEqual({ kind: "session", target: "" });
  });

  it("keeps the raw rest-of-line as the file target (spaces included)", () => {
    expect(parseAtCommand("/at f src/index.ts")).toEqual({ kind: "file", target: "src/index.ts" });
    expect(parseAtCommand("/at file a b.txt")).toEqual({ kind: "file", target: "a b.txt" });
    expect(parseAtCommand('/at f "a b.txt"')).toEqual({ kind: "file", target: '"a b.txt"' });
    expect(parseAtCommand("/at f")).toEqual({ kind: "file", target: "" });
  });

  it("rejects unknown subcommands", () => {
    expect(parseAtCommand("/at nope")).toBeNull();
    expect(parseAtCommand("/at s 1 extra?")).toEqual({ kind: "session", target: "1 extra?" });
    expect(parseAtCommand("/atx")).toBeNull();
    expect(parseAtCommand("/attach")).toBeNull();
  });

  it("isAtCommandAttempt flags every /at line, valid or not", () => {
    expect(isAtCommandAttempt("/at")).toBe(true);
    expect(isAtCommandAttempt("/at s")).toBe(true);
    expect(isAtCommandAttempt("/at nope")).toBe(true);
    expect(isAtCommandAttempt("  /at f x")).toBe(true);
    expect(isAtCommandAttempt("/atx")).toBe(false);
    expect(isAtCommandAttempt("/attach")).toBe(false);
    expect(isAtCommandAttempt("at")).toBe(false);
  });

  it("no OTHER parser claims /at (alias-collision guard)", () => {
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
    ];
    for (const input of ["/at", "/at s 1", "/at f a.txt", "/at clear"]) {
      for (const [name, parser] of others) {
        const result = parser(input);
        const claimed = result !== null && result !== false && result !== undefined;
        expect(claimed, `${name} must not claim ${input}`).toBe(false);
      }
      expect(parseAtCommand(input)).not.toBeNull();
      expect(parseCommandName(input)).toBe("at");
    }
  });

  it("is wired like every other local command", () => {
    expect(isBypassSlashCommand("/at")).toBe(true);
    expect(isBypassSlashCommand("/at s 1")).toBe(true);
    // An invalid argument bypasses too: it is never a plausible card answer.
    expect(isBypassSlashCommand("/at nope")).toBe(true);
    expect(LOCAL_COMMAND_NAMES.has("at")).toBe(true);
    expect(formatHelp()).toContain("/at");
  });
});

// ─── Mention rendering ──────────────────────────────────────────────────────

describe("/at mention rendering", () => {
  it("encodes a session id the way the host decoder expects", () => {
    const id = "session-0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";
    const uri = encodeSessionReferenceUri(id);
    expect(uri.startsWith("dsh-session:")).toBe(true);
    expect(uri.slice("dsh-session:".length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(uri.slice("dsh-session:".length), "base64url").toString("utf8")))
      .toBe(id);
  });

  it("escapes the two characters a mention label cannot hold", () => {
    expect(escapeMentionLabel("a\\b")).toBe("a\\\\b");
    expect(escapeMentionLabel("a]b")).toBe("a\\]b");
    expect(escapeMentionLabel("普通标题")).toBe("普通标题");
  });

  it("renders a session mention the host regex round-trips", () => {
    const id = "session-alpha";
    const mention = formatSessionMention("Alpha [重构] a\\b", id);
    expect(mention.startsWith("@[")).toBe(true);
    expect(mention.endsWith(`](${encodeSessionReferenceUri(id)})`)).toBe(true);
    // The host's own mention pattern, applied to the rendered text.
    const re = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu;
    const matches = [...mention.matchAll(re)];
    expect(matches).toHaveLength(1);
    expect(matches[0]![2]).toBe(encodeSessionReferenceUri(id));
  });

  it("folds whitespace in a label so the mention stays on one line", () => {
    expect(formatSessionMention("  a\n\nb\tc  ", "s-1")).toBe(
      `@[a b c](${encodeSessionReferenceUri("s-1")})`,
    );
  });

  it("renders file mentions: plain, quoted, directory", () => {
    expect(formatFileMention({ path: "src/index.ts", kind: "file" })).toBe("@src/index.ts");
    expect(formatFileMention({ path: "a b.txt", kind: "file" })).toBe('@"a b.txt"');
    expect(formatFileMention({ path: "src", kind: "directory" })).toBe("@src/");
    expect(formatFileMention({ path: "my dir", kind: "directory" })).toBe('@"my dir/"');
  });

  it("refuses paths the quoted grammar cannot represent", () => {
    expect(formatFileMention({ path: 'a"b.txt', kind: "file" })).toBeUndefined();
    expect(formatFileMention({ path: "a\u0007b", kind: "file" })).toBeUndefined();
    expect(formatFileMention({ path: "", kind: "file" })).toBeUndefined();
  });

  it("builds one block with sessions first, then files", () => {
    const block = buildMentionBlock([
      { kind: "file", mention: "@a.ts" },
      { kind: "session", mention: "@[A](dsh-session:eA)" },
      { kind: "file", mention: "@b.ts" },
    ]);
    // The leading break is load-bearing, not cosmetic: see
    // "keeps a file token at a whitespace boundary" below.
    expect(block).toBe("\n@[A](dsh-session:eA) @a.ts @b.ts");
    expect(buildMentionBlock([])).toBeUndefined();
  });

  // The GUI hands one message's text to the mention grammar as
  // `blocks.map(b => b.text).join("")` (`contentParts` in
  // `dsh-client-ui-chat`), and that grammar only fires on a whitespace
  // boundary (`(?<!\S)` in `dsh-client-ui-reference`). A block that STARTED
  // with the token therefore depended on the user's own words happening to
  // end in whitespace: `/at f` after 「没事，我测试@功能而已」 reached the
  // renderer as `…而已@"C:/…"`, whose `@` is preceded by 「已」 — plain text,
  // no chip, no click-through.
  it("keeps a file token at a whitespace boundary once the blocks are joined", () => {
    const guiMention = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu;
    const userText = "没事，我测试@功能而已";
    const quoted = formatFileMention({ path: "C:/Users/me/test - 副本.txt", kind: "file" })!;
    const plain = formatFileMention({ path: "C:/Users/me/a.txt", kind: "file" })!;

    const mention = buildMentionBlock([
      { kind: "file", mention: plain },
      { kind: "file", mention: quoted },
    ])!;
    const joined = [userText, mention].join("");
    const chips = [...joined.matchAll(guiMention)].map((match) => match[0]);
    expect(chips).toEqual([plain, quoted]);

    // The same token without the break — the reported bug — matches nothing:
    // its `@` sits behind 「已」.
    const broken = userText + quoted;
    expect(broken).toBe('没事，我测试@功能而已@"C:/Users/me/test - 副本.txt"');
    expect([...broken.matchAll(guiMention)]).toHaveLength(0);
  });

  it("normalizeAtTarget strips exactly one surrounding quote pair", () => {
    expect(normalizeAtTarget('"a b.txt"')).toBe("a b.txt");
    expect(normalizeAtTarget("  a b.txt  ")).toBe("a b.txt");
    expect(normalizeAtTarget('"a b.txt')).toBe('"a b.txt');
    expect(normalizeAtTarget('"')).toBe('"');
    expect(normalizeAtTarget("")).toBe("");
  });

  // A path copied out of Explorer or a browser can carry a bidi control at one
  // end. `trim()` does not remove U+202A, and ONE leading mark makes
  // `path.isAbsolute()` false — so without this the pasted `C:\…` resolves
  // relative to the working directory and `/at f` answers 找不到 for a file the
  // user is looking at.
  it("strips invisible formatting marks that break absolute-path detection", () => {
    // The reported shape: a `C:\…` path copied out of Explorer. The mark is
    // what makes it look relative — but only on Windows, where that string IS
    // an absolute path; on POSIX it is a legal relative filename either way, so
    // the absolute-ness assertion below is platform-gated rather than dropped.
    const winPath = "C:\\Users\\me\\a.txt";
    expect(normalizeAtTarget(`\u202a${winPath}`)).toBe(winPath);
    if (process.platform === "win32") {
      expect(path.isAbsolute(`\u202a${winPath}`)).toBe(false);
      expect(path.isAbsolute(normalizeAtTarget(`\u202a${winPath}`))).toBe(true);
    }
    // Same property on a path that is absolute on THIS platform, so the rule is
    // covered by CI (Linux) too and not only on a Windows dev box.
    const native = process.platform === "win32" ? winPath : "/tmp/a.txt";
    expect(path.isAbsolute(`\u202a${native}`)).toBe(false);
    expect(path.isAbsolute(normalizeAtTarget(`\u202a${native}`))).toBe(true);
    // Marks inside a path are part of a real filename and are preserved.
    expect(normalizeAtTarget("a\u202ab.txt")).toBe("a\u202ab.txt");
    // A trailing zero-width space is dropped too.
    expect(normalizeAtTarget("src/\u200b")).toBe("src/");
    // A mark around a quoted target does not stop the quote pair matching.
    expect(normalizeAtTarget('\u202a"a b.txt"\u202a')).toBe("a b.txt");
  });

  it("accepts curly quotes from a Chinese IME around a target", () => {
    expect(normalizeAtTarget("\u201ca b.txt\u201d")).toBe("a b.txt");
    // A mismatched pair is still refused rather than half-stripped.
    expect(normalizeAtTarget('\u201ca b.txt"')).toBe('\u201ca b.txt"');
  });

  it("reports whether a target carried invisible marks", () => {
    expect(hasInvisibleMarks("\u202aC:\\a.txt")).toBe(true);
    expect(hasInvisibleMarks("C:\\a.txt")).toBe(false);
    expect(hasInvisibleMarks("a\u202ab.txt")).toBe(true);
  });
});

// ─── Staging and delivery ───────────────────────────────────────────────────

describe("/at staging", () => {
  it("/at s 2 stages the second /s list row and replies with the count", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    // `/s list` fixes the numbering snapshot (rows: current, alpha, beta).
    await inbound.handleMessage(text("/s list"));
    sendTextMessage.mockClear();

    await inbound.handleMessage(text("/at s 2"));
    expect(lastReply()).toContain("已引用会话");
    expect(lastReply()).toContain("Alpha 重构");
    expect(lastReply()).toContain("1/3");
  });

  it("the next message carries the mention, and only that one", async () => {
    const { bridge, received } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    await inbound.handleMessage(text("总结一下这个会话"));

    expect(received).toHaveLength(1);
    const blocks = received[0]!.content;
    // The user's own words stay FIRST: the host derives the session title
    // from this message's leading text, and a leading base64 mention would
    // become the title.
    expect(blocks[0]!.text).toBe("总结一下这个会话");
    // `\n`-led on purpose: the GUI joins the blocks with "" and the mention
    // grammar needs whitespace before the `@`.
    expect(blocks[1]!.text).toBe(
      `\n@[Alpha 重构](${encodeSessionReferenceUri("session-alpha")})`,
    );

    // Consumed: the next message is clean.
    await inbound.handleMessage(text("第二条"));
    expect(received).toHaveLength(2);
    expect(deliveredText(received)[1]).toBe("第二条");
  });

  it("stages several references, sessions first in the delivered block", async () => {
    const { bridge, received, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    const file = path.join(cwd, "notes.md");
    fs.writeFileSync(file, "x");
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at f notes.md"));
    await inbound.handleMessage(text("/at s 2"));
    await inbound.handleMessage(text("看看这两样"));

    const last = received[0]!.content.at(-1)!.text!;
    expect(last).toBe(
      `\n@[Alpha 重构](${encodeSessionReferenceUri("session-alpha")}) @notes.md`,
    );
  });

  it("does not duplicate a reference already staged", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at s 2"));
    expect(lastReply()).toContain("已暂存该会话引用");
  });

  it("resolves a keyword target case-insensitively", async () => {
    const { bridge } = makeBridge();
    // The host candidate path needs a live agent; bind first, as after any
    // ordinary message.
    bindSession(bridge);
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at s alpha"));
    expect(lastReply()).toContain("Alpha 重构");
  });

  it("falls back to the /s list rows when no live agent exists", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    // No binding: `agents.get` yields nothing, so the host candidate call is
    // skipped and the local row scan answers.
    await inbound.handleMessage(text("/at s alpha"));
    expect(lastReply()).toContain("Alpha 重构");
  });

  it("reports ambiguity instead of guessing", async () => {
    const { bridge } = makeBridge({
      sessions: [
        { id: "session-current", cwd: "C:\\w", createdAt: 1 },
        { id: "s-a1", cwd: "C:\\w", createdAt: 2, title: "报告 A" },
        { id: "s-a2", cwd: "C:\\w", createdAt: 3, title: "报告 B" },
      ],
    });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at s 报告"));
    expect(lastReply()).toContain("匹配到多个会话");
    expect(lastReply()).toContain("报告 A");
    expect(lastReply()).toContain("报告 B");
  });

  it("a session mention survives the merge window as one batch mention", async () => {
    const { bridge, received } = makeBridge({ patch: { mergeEnabled: true, mergeSilenceMs: 20 } });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    await inbound.handleMessage(text("第一句"));
    await inbound.handleMessage(text("第二句"));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received).toHaveLength(1);
    const body = received[0]!.content.map((b) => b.text ?? "").join("\n");
    expect(body).toContain("dsh-session:");
    expect(body).toContain("第一句");
    expect(body).toContain("第二句");
    // Exactly one mention: the batch must not repeat the token per message.
    expect(body.match(/dsh-session:/g)).toHaveLength(1);
  });

  it("keeps staged references when the agent cannot be ensured", async () => {
    const { bridge } = makeBridge({ agentFails: true, sessions: [
      { id: "session-current", cwd: "C:\\w", createdAt: 3 },
      { id: "session-alpha", cwd: "C:\\w", createdAt: 2, title: "Alpha 重构" },
    ] });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    await inbound.handleMessage(text("这条会失败"));
    sendTextMessage.mockClear();
    // The staging table still lists the reference: the user can just resend.
    await inbound.handleMessage(text("/at"));
    expect(lastReply()).toContain("Alpha 重构");
  });
});

// ─── File references ────────────────────────────────────────────────────────

describe("/at file references", () => {
  it("stages a relative path and quotes it when it contains spaces", async () => {
    const { bridge, received, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.mkdirSync(path.join(cwd, "my dir"));
    fs.writeFileSync(path.join(cwd, "my dir", "a.txt"), "x");

    await inbound.handleMessage(text('/at f "my dir/a.txt"'));
    expect(lastReply()).toContain('@"my dir/a.txt"');

    await inbound.handleMessage(text("读一下"));
    expect(received[0]!.content.at(-1)!.text).toBe('\n@"my dir/a.txt"');
  });

  // End-to-end version of the boundary test above: what the bridge actually
  // delivers, flattened the way the GUI flattens it before the mention
  // grammar runs.
  it("a staged file still chips when the user's words end flush against it", async () => {
    const { bridge, received, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.mkdirSync(path.join(cwd, "my dir"));
    fs.writeFileSync(path.join(cwd, "my dir", "a.txt"), "x");

    await inbound.handleMessage(text('/at f "my dir/a.txt"'));
    await inbound.handleMessage(text("没事，我测试@功能而已"));

    // `contentParts`: every text block, concatenated with no separator.
    const bubble = received[0]!.content.map((block) => block.text ?? "").join("");
    expect(bubble).toBe('没事，我测试@功能而已\n@"my dir/a.txt"');
    const guiMention = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu;
    expect([...bubble.matchAll(guiMention)].map((match) => match[0])).toEqual([
      '@"my dir/a.txt"',
    ]);
  });

  it("marks a directory with a trailing slash", async () => {
    const { bridge, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.mkdirSync(path.join(cwd, "src"));
    await inbound.handleMessage(text("/at f src"));
    expect(lastReply()).toContain("@src/");
  });

  it("accepts an absolute path inside the working directory as a relative mention", async () => {
    const { bridge, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    const file = path.join(cwd, "abs.txt");
    fs.writeFileSync(file, "x");
    await inbound.handleMessage(text(`/at f ${file}`));
    // Inside the working directory it is still sent relative (portable).
    expect(lastReply()).toContain("@abs.txt");
  });

  // `@file` is a POINTER, not a read: the host's own FILE_REFERENCE_PROMPT says
  // "absolute paths identify files or directories on the host", and the agent's
  // sandbox decides access. Refusing an outside path would reject the most
  // common use — "read this file I just saved on my Desktop".
  it("accepts an absolute path outside the working directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-at-outside-"));
    const { bridge, received } = makeBridge();
    const inbound = asInbound(bridge);
    const file = path.join(outside, "note.txt");
    fs.writeFileSync(file, "x");
    await inbound.handleMessage(text(`/at f ${file}`));
    expect(lastReply()).toContain("✅ 已引用");
    expect(lastReply()).toContain("@");
    expect(lastReply()).toContain("note.txt");
    // Sent as an absolute, `/`-separated mention so the model gets one token.
    await inbound.handleMessage(text("读一下"));
    // `canonicalPath` runs realpath, so compare against the resolved spelling.
    const resolved = fs.realpathSync(file).split(path.sep).join("/");
    expect(deliveredText(received).join("\n")).toContain(resolved);
  });

  // The exact failure that prompted this: a path copied out of Explorer arrives
  // with a leading U+202A, which makes `path.isAbsolute()` false and would
  // silently resolve the target relative to the working directory.
  it("resolves a pasted absolute path that carries a bidi control", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-at-bidi-"));
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    const file = path.join(outside, "test.txt");
    fs.writeFileSync(file, "x");
    await inbound.handleMessage(text(`/at f \u202a${file}`));
    expect(lastReply()).toContain("✅ 已引用");
    expect(lastReply()).toContain("test.txt");
  });

  it("refuses a traversal target that does not exist", async () => {
    // `/at f` deliberately ALLOWS paths outside the workspace (a reference is a
    // pointer, not a read), so climbing out is not itself an error — a target
    // that resolves to nothing is. `../../etc/passwd` cannot test that: on
    // POSIX it EXISTS, so the command correctly stages it, while on Windows the
    // same string is a legal relative path that resolves nowhere. Name a target
    // that exists on neither platform.
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at f ../../../../../../../../nonexistent-escape-probe.txt"));
    expect(lastReply()).toContain("找不到");
  });

  it("suggests candidates from fileReferences when the path is missing", async () => {
    const { bridge } = makeBridge({
      fileCandidates: [
        { path: "src/bridge/slash.ts", kind: "file" },
        { path: "src/bridge/at-refs.ts", kind: "file" },
      ],
    });
    // A live agent is what the provider is scoped to; the harness only has
    // one once the peer is bound to it.
    bindSession(bridge);
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at f bridge/slash"));
    expect(lastReply()).toContain("找不到");
    expect(lastReply()).toContain("@src/bridge/slash.ts");
  });

  it("falls back to a directory listing when no provider/agent exists", async () => {
    const { bridge, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.writeFileSync(path.join(cwd, "notes.md"), "x");
    fs.writeFileSync(path.join(cwd, "other.txt"), "x");
    await inbound.handleMessage(text("/at f notes"));
    expect(lastReply()).toContain("找不到");
    expect(lastReply()).toContain("@notes.md");
    // The unrelated entry is filtered out by the fragment.
    expect(lastReply()).not.toContain("@other.txt");
  });

  it("suggests near matches from a listing outside the workspace too", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-at-outside2-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text(`/at f ${path.join(outside, "secret")}`));
    expect(lastReply()).toContain("找不到");
    expect(lastReply()).toContain("secret.txt");
  });

  it("says so plainly when no provider can suggest", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at f nope.ts"));
    expect(lastReply()).toContain("找不到");
    expect(lastReply()).toContain("相对路径从当前工作区解析");
  });

  it("quotes a file whose name merely contains spaces after /at f", async () => {
    const { bridge, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.writeFileSync(path.join(cwd, "two words.md"), "x");
    // Unquoted spelling works too: the whole rest-of-line is the target.
    await inbound.handleMessage(text("/at f two words.md"));
    expect(lastReply()).toContain('@"two words.md"');
  });
});

// ─── Rejections ─────────────────────────────────────────────────────────────

describe("/at rejections", () => {
  it("refuses to reference the bound session itself", async () => {
    const { bridge } = makeBridge();
    // The self-check compares against the BOUND session, so bind first — the
    // state after any ordinary message.
    bindSession(bridge);
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 1"));
    expect(lastReply()).toContain("不能引用当前会话自己");
  });

  it("refuses a fourth session (the host aborts the turn at 4)", async () => {
    const { bridge } = makeBridge({
      sessions: [
        { id: "session-current", cwd: "C:\\w", createdAt: 1 },
        { id: "s-1", cwd: "C:\\w", createdAt: 2, title: "一" },
        { id: "s-2", cwd: "C:\\w", createdAt: 3, title: "二" },
        { id: "s-3", cwd: "C:\\w", createdAt: 4, title: "三" },
        { id: "s-4", cwd: "C:\\w", createdAt: 5, title: "四" },
      ],
    });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    for (const row of ["2", "3", "4"]) await inbound.handleMessage(text(`/at s ${row}`));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at s 5"));
    expect(lastReply()).toContain("最多 3 个");
  });

  it("refuses the ninth file", async () => {
    const { bridge, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    for (let i = 0; i < 9; i++) {
      fs.writeFileSync(path.join(cwd, `f${i}.txt`), "x");
    }
    for (let i = 0; i < 8; i++) await inbound.handleMessage(text(`/at f f${i}.txt`));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at f f8.txt"));
    expect(lastReply()).toContain("已暂存 8 个文件引用");
  });

  it("refuses when the host has no session-reference service", async () => {
    const { bridge } = makeBridge({ withSessionReference: false });
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at s 2"));
    expect(lastReply()).toContain("未挂载会话引用服务");
  });

  it("prints usage for a missing target", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at s"));
    expect(lastReply()).toContain("用法: /at s");
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at f"));
    expect(lastReply()).toContain("用法: /at f");
  });

  it("prints usage for an invalid subcommand instead of forwarding it", async () => {
    const { bridge, received } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at nope"));
    expect(lastReply()).toContain("用法: /at");
    expect(received).toHaveLength(0);
  });

  it("rejects an out-of-range row number", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 99"));
    expect(lastReply()).toContain("编号超出范围");
  });
});

// ─── Management ─────────────────────────────────────────────────────────────

describe("/at management", () => {
  it("lists staged references with stable numbering", async () => {
    const { bridge, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.writeFileSync(path.join(cwd, "a.txt"), "x");
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    await inbound.handleMessage(text("/at f a.txt"));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at"));

    const body = lastReply();
    expect(body).toContain("1. 会话: Alpha 重构");
    expect(body).toContain("2. 文件: @a.txt");
    expect(body).toContain("会话 1/3 · 文件 1/8");
  });

  it("/at rm removes by printed position", async () => {
    const { bridge, received, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.writeFileSync(path.join(cwd, "a.txt"), "x");
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    await inbound.handleMessage(text("/at f a.txt"));
    await inbound.handleMessage(text("/at rm 1"));
    expect(lastReply()).toContain("已移除引用 1");
    await inbound.handleMessage(text("只剩文件"));
    expect(received[0]!.content.at(-1)!.text).toBe("\n@a.txt");
  });

  it("/at rm out of range reports the range", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/at rm 3"));
    expect(lastReply()).toContain("没有暂存的引用");
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at rm 3"));
    expect(lastReply()).toContain("编号超出范围（1-1）");
  });

  it("/at clear drops everything", async () => {
    const { bridge, received, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.writeFileSync(path.join(cwd, "a.txt"), "x");
    await inbound.handleMessage(text("/at f a.txt"));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at clear"));
    expect(lastReply()).toContain("已清空 1 条引用暂存");
    await inbound.handleMessage(text("干净的消息"));
    expect(deliveredText(received)[0]).toBe("干净的消息");
  });

  it("expired staging is not injected", async () => {
    const { bridge, received } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    // Age the staging entry past the 10-minute TTL.
    const table = (bridge as unknown as {
      pendingRefs: Map<string, { at: number }>;
    }).pendingRefs;
    for (const state of table.values()) state.at = Date.now() - 11 * 60_000;

    await inbound.handleMessage(text("太晚了"));
    expect(deliveredText(received)[0]).toBe("太晚了");
  });

  it("a new reference after the TTL starts a fresh set, not a revival", async () => {
    const { bridge, received, cwd } = makeBridge();
    const inbound = asInbound(bridge);
    fs.writeFileSync(path.join(cwd, "stale.txt"), "x");
    await inbound.handleMessage(text("/at f stale.txt"));
    const table = (bridge as unknown as {
      pendingRefs: Map<string, { at: number }>;
    }).pendingRefs;
    for (const state of table.values()) state.at = Date.now() - 11 * 60_000;

    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/at f stale.txt"));
    // The expired entry was dropped, so this counts as the FIRST reference.
    expect(lastReply()).toContain("1/8");
    await inbound.handleMessage(text("只带一个"));
    expect(received[0]!.content.at(-1)!.text).toBe("\n@stale.txt");
  });

  it("logout clears the staging table", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    await (bridge as unknown as { resetPeerBinding(r: string): void }).resetPeerBinding("test");
    await inbound.handleMessage(text("/at"));
    expect(lastReply()).toContain("当前没有暂存的引用");
  });

  it("/status shows the staging row only while something is staged", async () => {
    const { bridge } = makeBridge();
    bindSession(bridge);
    const inbound = asInbound(bridge);
    await inbound.handleMessage(text("/status"));
    expect(lastReply()).not.toContain("引用暂存");

    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    sendTextMessage.mockClear();
    await inbound.handleMessage(text("/status"));
    expect(lastReply()).toContain("引用暂存: 🟢 会话 1");
  });

  it("a pending approval card does not swallow /at", async () => {
    const { bridge } = makeBridge();
    const inbound = asInbound(bridge);
    const anyBridge = bridge as unknown as {
      state: { ensureUser(u: string, c: string): unknown; update(u: string, p: unknown): void };
      pendingApprovals: Map<string, Array<{ rpcId: string; sessionId: string; timer: NodeJS.Timeout }>>;
    };
    anyBridge.state.ensureUser("u1", "C:\\work");
    anyBridge.state.update("u1", { sessionId: "session-current" });
    anyBridge.pendingApprovals.set("u1", [
      { rpcId: "rpc-1", sessionId: "session-current", timer: setTimeout(() => {}, 60_000) },
    ]);

    await inbound.handleMessage(text("/s list"));
    await inbound.handleMessage(text("/at s 2"));
    expect(lastReply()).toContain("已引用会话");
    // The card is still answerable.
    expect(anyBridge.pendingApprovals.get("u1")).toHaveLength(1);
  });
});
