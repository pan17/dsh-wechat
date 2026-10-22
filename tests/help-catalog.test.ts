/**
 * The settings page's 指令帮助 catalog.
 *
 * The panel used to render `formatHelp()`'s grammar table verbatim — 21 dense
 * lines written for a maintainer. The catalog is the plain-language
 * replacement, and it is only worth anything if it stays TRUE: an entry that
 * documents three of `/session`'s six subcommands, or advertises a line the
 * bridge would forward to the agent as chat, is worse than no help at all
 * because it looks authoritative.
 *
 * These assertions pin the four ways that goes wrong:
 *
 *   1. drift against `/help` (a new command documented in only one place),
 *   2. a subcommand with no example (the "例子不完整" failure),
 *   3. an example the bridge would not recognize,
 *   4. jargon or placeholder text creeping back into the user-facing strings.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  helpCatalog,
  shortestSpelling,
  type HelpCommandEntry,
  type HelpExample,
} from "../src/help-catalog.js";
import {
  LOCAL_COMMAND_NAMES,
  formatHelp,
  helpTopicBlock,
  isBypassSlashCommand,
  parseCommandName,
  parseHelpCommand,
  parseRejectPermissionCommand,
  parseRejectQuestionCommand,
  parsePnCardReply,
} from "../src/bridge/slash.js";
import { formatForWeChat } from "../src/adapter/outbound.js";

const catalog = helpCatalog();
const client = readFileSync(fileURLToPath(new URL("../src/client.js", import.meta.url)), "utf8");

/** Words that mean nothing to the user this panel is written for. */
const JARGON = [
  "waterfall",
  "runtime context",
  "mention",
  "base64",
  "RPC",
  "缓冲区",
  "去重",
  "命令分发",
  "原语",
  "幂等",
  "服务不可用",
];

/** Slash spellings of an entry: the command itself plus every alias. */
function spellings(entry: HelpCommandEntry): string[] {
  return [entry.command.replace(/^\//, ""), ...entry.aliases];
}

/**
 * True when `line` invokes `entry` with `sub` as its first argument.
 *
 * Matching on the first token only would let `/at` claim `/atlas`; requiring
 * a following space or end-of-line keeps `/s list` from matching `/s listall`.
 */
function invokes(line: string, entry: HelpCommandEntry, sub: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return false;
  const head = trimmed.split(/\s+/)[0]!.slice(1).toLowerCase();
  if (!spellings(entry).some((name) => name.toLowerCase() === head)) return false;
  const rest = trimmed.slice(trimmed.split(/\s+/)[0]!.length).trim().toLowerCase();
  return rest === sub.toLowerCase() || rest.startsWith(sub.toLowerCase() + " ");
}

/** True when the bridge would treat `line` as a command rather than chat. */
function bridgeRecognizes(line: string): boolean {
  const trimmed = line.trim();
  if (parseRejectQuestionCommand(trimmed) !== null) return true;
  if (parseRejectPermissionCommand(trimmed) !== null) return true;
  if (parsePnCardReply(trimmed) !== null) return true;
  return isBypassSlashCommand(trimmed);
}

const commandExamples: Array<{ entry: HelpCommandEntry; example: HelpExample }> = catalog.commands.flatMap(
  (entry) => entry.examples.filter((example) => (example.kind ?? "command") === "command").map((example) => ({ entry, example })),
);

describe("help catalog structure", () => {
  it("has groups, commands and an intro/footer", () => {
    expect(catalog.groups.length).toBeGreaterThan(0);
    expect(catalog.commands.length).toBeGreaterThan(0);
    expect(catalog.intro.trim()).not.toBe("");
    expect(catalog.footer.trim()).not.toBe("");
  });

  it("has unique ids and unique command spellings", () => {
    const ids = catalog.commands.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = catalog.commands.map((entry) => entry.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every command belongs to a declared group", () => {
    const groupIds = new Set(catalog.groups.map((group) => group.id));
    for (const entry of catalog.commands) {
      expect(groupIds.has(entry.group), `${entry.command} → ${entry.group}`).toBe(true);
    }
  });

  it("every command has a summary, a usage line and at least one example", () => {
    for (const entry of catalog.commands) {
      expect(entry.summary.trim(), entry.command).not.toBe("");
      expect(entry.usage.trim(), entry.command).not.toBe("");
      expect(entry.examples.length, entry.command).toBeGreaterThan(0);
      for (const example of entry.examples) {
        expect(example.line.trim(), `${entry.command}: ${example.line}`).not.toBe("");
        expect(example.note.trim(), `${entry.command}: ${example.line}`).not.toBe("");
      }
    }
  });

  it("keeps the catalog JSON-safe (it travels over HTTP)", () => {
    // Functions, undefined holes or a Map would survive `sendJson` as `null`
    // and render as blank rows in the panel.
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });

  it("does not carry a quick-start block", () => {
    // The 快捷卡 section was explicitly dropped; a field coming back would
    // resurrect it without anyone editing the panel on purpose.
    expect(catalog).not.toHaveProperty("quickStart");
    expect(client).not.toContain("quickStart");
    expect(client).not.toContain("wx_quick");
  });
});

describe("help catalog ↔ /help drift guard", () => {
  it("documents exactly the commands formatHelp() lists locally", () => {
    // `/help`'s local rows are the authoritative command set (the native
    // section is per-profile and cannot be enumerated here). A command added
    // to one side and not the other fails right here. Rows live inside the
    // fenced table as `/name  note`, so the anchor is line start.
    const help = formatHelp();
    const localSection = help.split("── DSH 原生命令")[0] ?? help;
    const documented = new Set(
      Array.from(localSection.matchAll(/^\/([a-z][a-z0-9-]*)(?:\s|\()/gm), (m) => m[1]!),
    );
    const catalogued = new Set(catalog.commands.map((entry) => entry.command.replace(/^\//, "")));
    expect([...catalogued].sort()).toEqual([...documented].sort());
  });

  it("lists every subcommand the catalog declares", () => {
    // A subcommand that exists in `subcommands` but not in the listing is
    // invisible to a WeChat user: the panel shows it, the chat does not.
    const help = formatHelp();
    for (const entry of catalog.commands) {
      const short = shortestSpelling(entry);
      for (const sub of entry.subcommands) {
        expect(help, `${entry.command} ${sub}`).toContain(`${short} ${sub}`);
      }
    }
  });

  it("declares the scoped /session forms as their own keywords", () => {
    // `list current` and `switch current <n>` are distinct forms — they scope
    // the list to the current working directory. They used to be missing from
    // `subcommands`, so the coverage test above was satisfied by bare `list`
    // and `/help` never showed `/s list current` at all, even though the
    // panel's `usage` advertised `[current]`.
    const session = catalog.commands.find((entry) => entry.id === "session");
    expect(session).toBeDefined();
    expect(session!.subcommands).toContain("list current");
    expect(session!.subcommands).toContain("switch current");
    const help = formatHelp();
    expect(help).toContain("/s list current");
    expect(help).toContain("/s switch current");
  });

  it("keeps every row on one line inside a fenced block", () => {
    // A WeChat bubble does not scroll horizontally, so a row that overflows
    // WRAPS — and the wrap lands inside a backticked command, splitting it in
    // two. The fenced block is the client's scrollable monospace box, and it
    // only works if each row really is a single line.
    for (const text of [formatHelp(), ...catalog.commands.map((e) => helpTopicBlock(e.command)!)]) {
      const fences = text.split("\n").filter((line) => line.trim() === "```").length;
      expect(fences % 2, "unbalanced code fences").toBe(0);
      expect(fences, "no fenced table").toBeGreaterThan(0);
    }
  });

  it("does not inline example notes into the listing", () => {
    // The listing is a map, not a manual. Inlining the examples' explanations
    // is what turned it into a 96-line wall nobody could scan. A bare
    // subcommand spelling (`/s list`) legitimately appears in both, because
    // that line IS the subcommand list — the notes are the real risk.
    //
    // Only notes longer than a terse listing line can prove the point: a
    // two-word note like "关闭" is a legitimate terse description in its own
    // right and cannot be used to detect inlining.
    const help = formatHelp();
    for (const entry of catalog.commands) {
      for (const example of entry.examples) {
        if (Array.from(example.note).length < 12) continue;
        expect(help.includes(example.note), `${entry.command}: ${example.note}`).toBe(false);
      }
    }
  });

  it("keeps the shared wording short and jargon-free", () => {
    // ONE string per command is rendered in BOTH the settings panel and
    // WeChat's `/help` table. That is why it has to be short, neutral and
    // jargon-free: conversational filler ("别憋了，现在就把…") reads as noise
    // in a monospace listing, and a long sentence overflows a phone line.
    for (const entry of catalog.commands) {
      expect(entry.summary.trim(), entry.command).not.toBe("");
      expect(Array.from(entry.summary).length, `${entry.command}: ${entry.summary}`).toBeLessThanOrEqual(40);
    }
    for (const entry of catalog.commands) {
      for (const example of entry.examples) {
        expect(Array.from(example.note).length, `${entry.command}: ${example.note}`).toBeLessThanOrEqual(30);
      }
    }
  });

  it("shows only short aliases, never a second full word", () => {
    // `/notify (watch, notice)` reads as three commands in a row. Aliases are
    // shortenings; a synonym belongs in the parser, not the listing.
    const full = new Set(catalog.commands.map((entry) => entry.command.replace(/^\//, "")));
    for (const entry of catalog.commands) {
      for (const alias of entry.aliases) {
        expect(full.has(alias), `${entry.command} alias ${alias} is another full name`).toBe(false);
        expect(alias.length, `${entry.command} alias ${alias}`).toBeLessThan(
          entry.command.length - 1,
        );
      }
    }
  });

  it("gives every command a topic block with its full example list", () => {
    // `/help <命令>` must show exactly what the settings panel shows — every
    // example, in order, with a description. A block that drops one is the
    // "例子不全" failure the panel was fixed for. The wording is the terse
    // register (`terse`, else `note`), not the panel's prose.
    for (const entry of catalog.commands) {
      for (const name of [entry.command.replace(/^\//, ""), ...entry.aliases]) {
        const block = helpTopicBlock(name);
        expect(block, `${entry.command} via "${name}"`).not.toBeNull();
        expect(block!, `${entry.command} summary`).toContain(entry.summary);
        for (const example of entry.examples) {
          expect(block!, `${entry.command}: ${example.line}`).toContain(example.line);
          expect(block!, `${entry.command}: ${example.line} description`).toContain(example.note);
        }
      }
    }
  });

  it("answers an unknown topic with nothing instead of guessing", () => {
    expect(helpTopicBlock("nope")).toBeNull();
    expect(helpTopicBlock("")).toBeNull();
    expect(helpTopicBlock("/")).toBeNull();
    // A synonym the parser accepts but the help no longer documents is not a
    // topic: `/help watch` must not pretend to know it.
    expect(helpTopicBlock("watch")).toBeNull();
  });

  it("treats everything after /help as a command name", () => {
    expect(parseHelpCommand("/help")).toBe(true);
    expect(parseHelpCommand("/h")).toBe(true);
    expect(parseHelpCommand("/?")).toBe(true);
    expect(parseHelpCommand("/help s")).toEqual({ topic: "s" });
    expect(parseHelpCommand("/help session")).toEqual({ topic: "session" });
    expect(parseHelpCommand("/h merge")).toEqual({ topic: "merge" });
    // An unknown name is STILL a help request: the bridge answers
    // "没有 /nope 这条命令" plus the listing. `/help fuck` answering
    // "未知命令 /help" would deny the one thing the user is asking for.
    expect(parseHelpCommand("/help me")).toEqual({ unknown: "me" });
    expect(parseHelpCommand("/help nope")).toEqual({ unknown: "nope" });
    expect(parseHelpCommand("/help fuck")).toEqual({ unknown: "fuck" });
    // Even a whole sentence: `/help` is a help verb, not a chat prefix.
    expect(parseHelpCommand("/help me write a test")).toEqual({ unknown: "me write a test" });
    expect(parseHelpCommand("help")).toBe(false);
  });

  it("keeps both renderings inside one WeChat message", () => {
    // 4000 chars is the per-message cap; a help reply split across two
    // messages is unreadable. These bounds also stop the listing from
    // creeping back into a manual.
    const help = formatHelp([
      { name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]" } },
      { name: "goal", description: "set or view the goal for a long-running task" },
      { name: "compact", description: "Compact older conversation history" },
    ]);
    expect(Array.from(help).length).toBeLessThanOrEqual(2000);
    expect(help.split("\n").length).toBeLessThanOrEqual(55);
    for (const entry of catalog.commands) {
      const block = helpTopicBlock(entry.command)!;
      expect(Array.from(block).length, `${entry.command} block`).toBeLessThanOrEqual(550);
    }
  });

  it("survives the WeChat markdown filter untouched", () => {
    // `formatForWeChat` strips some markdown constructs. If it rewrote the
    // help text, users would see mangled markup — and the listing's whole
    // point is that it renders.
    const help = formatHelp([
      { name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]" } },
    ]);
    expect(formatForWeChat(help)).toBe(help.trim());
    for (const entry of catalog.commands) {
      const block = helpTopicBlock(entry.command)!;
      expect(formatForWeChat(block), `${entry.command} block`).toBe(block.trim());
    }
  });

  it("every alias the host could shadow is a name the bridge actually owns", () => {
    // `tryNativeCommand` runs before the local `/help` branch, so an alias
    // absent from `LOCAL_COMMAND_NAMES` loses to a host command of the same
    // name. Only aliases that are valid native command names can be shadowed
    // at all — `/?` cannot (`parseCommandName` rejects a non-letter head), so
    // it is exempt rather than needing a whitelist entry it could never use.
    for (const entry of catalog.commands) {
      for (const alias of entry.aliases) {
        if (parseCommandName("/" + alias) === null) continue;
        expect(LOCAL_COMMAND_NAMES.has(alias), `${entry.command} alias ${alias}`).toBe(true);
      }
      expect(LOCAL_COMMAND_NAMES.has(entry.command.replace(/^\//, ""))).toBe(true);
    }
  });
});

describe("help catalog example completeness", () => {
  it("gives every declared subcommand at least one example", () => {
    // This is the assertion that keeps `/session` from shipping with three of
    // its six forms documented. Adding a subcommand without an example fails
    // the build instead of shipping a half-truth.
    for (const entry of catalog.commands) {
      for (const sub of entry.subcommands) {
        const covered = entry.examples.some((example) => invokes(example.line, entry, sub));
        expect(covered, `${entry.command} has no example for "${sub}"`).toBe(true);
      }
    }
  });

  it("every command example is recognized by the bridge", () => {
    // A line the parsers do not know would be forwarded to the agent as chat:
    // the user copies it from the help panel and gets an LLM answer instead of
    // the action the panel just promised.
    for (const { entry, example } of commandExamples) {
      expect(bridgeRecognizes(example.line), `${entry.command}: ${example.line}`).toBe(true);
    }
  });

  it("uses text examples only where a command genuinely cannot express the action", () => {
    // `..` / `!!` are message suffixes, not commands, so they are the only
    // legitimate text examples. Anything else must be a real slash command —
    // a "just type something" row teaches nothing and clutters the list.
    const textLines = catalog.commands.flatMap((entry) =>
      entry.examples.filter((example) => example.kind === "text").map((example) => `${entry.command}: ${example.line}`),
    );
    expect(textLines.length).toBeGreaterThan(0);
    for (const line of textLines) {
      const [command, text] = line.split(": ");
      expect(command).toBe("/merge");
      expect(text!.endsWith(" ..") || text!.endsWith(" !!")).toBe(true);
    }
  });

  it("does not pad /next with a 'just say anything' example", () => {
    // `/next` is one action. The entry used to carry an extra "在吗 — 随便发
    // 一句话也会自动继续" row, which is advice about a different command and
    // made the row look like it had two ways to run it.
    const next = catalog.commands.find((entry) => entry.id === "next");
    expect(next).toBeDefined();
    expect(next!.examples).toHaveLength(1);
    expect(next!.examples[0]!.line).toBe("/next");
  });
});

describe("help catalog wording", () => {
  it("keeps summaries short", () => {
    for (const entry of catalog.commands) {
      expect(Array.from(entry.summary).length, `${entry.command}: ${entry.summary}`).toBeLessThanOrEqual(40);
    }
  });

  it("keeps example notes short", () => {
    for (const entry of catalog.commands) {
      for (const example of entry.examples) {
        expect(Array.from(example.note).length, `${entry.command}: ${example.note}`).toBeLessThanOrEqual(30);
      }
    }
  });

  it("contains no implementation jargon", () => {
    const haystack = [
      catalog.intro,
      catalog.footer,
      ...catalog.groups.map((group) => `${group.title} ${group.blurb}`),
      ...catalog.commands.flatMap((entry) => [
        entry.summary,
        ...entry.examples.map((example) => `${example.line} ${example.note}`),
      ]),
    ].join("\n");
    for (const word of JARGON) {
      expect(haystack.includes(word), `jargon "${word}"`).toBe(false);
    }
  });

  it("uses no angle-bracket placeholders in copyable lines", () => {
    // `<路径>` cannot be sent as-is. Concrete sample values are allowed and
    // are labelled "换成你自己的" in the note.
    for (const entry of catalog.commands) {
      for (const example of entry.examples) {
        expect(example.line.includes("<"), `${entry.command}: ${example.line}`).toBe(false);
        expect(example.line.includes(">"), `${entry.command}: ${example.line}`).toBe(false);
        expect(example.line.includes("…"), `${entry.command}: ${example.line}`).toBe(false);
      }
    }
  });

  it("documents the merge suffix tokens inside /merge", () => {
    // The suffixes are the reason the feature is usable; the panel test for
    // the settings group asserts they exist, and this pins them to the entry
    // a reader would look under.
    const merge = catalog.commands.find((entry) => entry.id === "merge");
    expect(merge).toBeDefined();
    const text = [merge!.usage, ...merge!.examples.map((example) => `${example.line} ${example.note}`)].join(" ");
    expect(text).toContain("..");
    expect(text).toContain("!!");
  });
});

describe("settings panel wiring for the help sheet", () => {
  it("renders the catalog and falls back to the verbatim /help text", () => {
    expect(client).toContain("helpCatalog");
    expect(client).toContain("body.catalog");
    expect(client).toContain("wx_help_panel");
    expect(client).toContain("wx_help_sheet");
    // A host that predates the catalog still gets the text panel, not a blank.
    expect(client).toContain("if (helpCatalog) return createElement(HelpSheet");
  });

  it("offers a retry instead of silently rendering nothing", () => {
    expect(client).toContain("loadHelp");
    expect(client).toContain("wx_help_retry");
  });

  it("remembers the open state across reloads", () => {
    expect(client).toContain('"dsh-wechat/help-open"');
    expect(client).toContain("storeHelpOpen");
  });

  it("shows two examples in the tooltip and points at the full list", () => {
    // The tooltip must stay short; a bubble with eleven lines gets flipped
    // off-screen and is unreadable on a phone.
    expect(client).toContain("entry.examples.slice(0, 2)");
    expect(client).toContain("展开查看全部");
  });

  it("lets a touch screen open the examples by tapping the ?", () => {
    expect(client).toContain("onActivate");
  });

  it("shows the tooltip exactly once, never as a native title bubble too", () => {
    // `title` + the portaled `wx_help_float` put the same sentence on screen
    // twice, overlapping (the native bubble sits right under the cursor).
    // The ? badge must carry its accessible name on `aria-label` only.
    const badge = client.slice(client.indexOf("function HelpTip"));
    const head = badge.slice(0, badge.indexOf('}, "?");'));
    expect(head).toContain('"aria-label": label');
    expect(head).not.toMatch(/^\s*title:/m);
  });

  it("filters by name, alias, summary and example text", () => {
    expect(client).toContain("entry.aliases.join");
    expect(client).toContain("entry.summary");
    expect(client).toContain("wx_help_empty");
  });

  it("offers expand-all and copy-to-clipboard", () => {
    expect(client).toContain("全部展开");
    expect(client).toContain("全部收起");
    expect(client).toContain("navigator.clipboard.writeText");
    expect(client).toContain("wx_cmd_copied");
  });

  it("every class the help sheet renders has a rule in its stylesheet", () => {
    const defined = new Set(
      Array.from(client.matchAll(/\.(wx_[a-z_]+)(?=[\s,{:.])/g), (m) => m[1]!),
    );
    const used = new Set(
      Array.from(client.matchAll(/className: "([^"]+)"/g), (m) => m[1]!.split(/\s+/))
        .flat()
        .filter((name) => name.startsWith("wx_")),
    );
    for (const name of used) expect(defined.has(name), name).toBe(true);
    // The sheet's own classes must actually be exercised by a render path,
    // otherwise the styles above are dead code with no reader.
    for (const name of [
      "wx_help_sheet",
      "wx_help_intro",
      "wx_help_tools",
      "wx_help_search",
      "wx_help_toggle",
      "wx_help_empty",
      "wx_help_retry",
      "wx_help_footer",
      "wx_cmd_group",
      "wx_cmd_group_title",
      "wx_cmd_group_blurb",
      "wx_cmd",
      "wx_cmd_head",
      "wx_cmd_open",
      "wx_cmd_name",
      "wx_cmd_alias",
      "wx_cmd_sum",
      "wx_cmd_body",
      "wx_cmd_usage",
      "wx_cmd_example",
      "wx_cmd_example_line",
      "wx_cmd_example_note",
      "wx_cmd_copied",
    ]) {
      expect(used.has(name), `${name} is styled but never rendered`).toBe(true);
    }
  });
});
