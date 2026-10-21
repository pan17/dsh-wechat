/**
 * The command-help catalog — the SINGLE source of every user-facing help
 * string, shared by the DSH WebUI settings panel and WeChat `/help`.
 *
 * Two consumers, one source:
 *
 *   - The settings page (「指令帮助」) reads it as JSON from
 *     `/wechat/api/help` (`catalog`) and renders 6 groups, 21 commands and
 *     every example, with a `?` on each row.
 *   - WeChat's `/help` renders the SAME data as Markdown: a one-line-per-command
 *     listing (`formatHelp()`), plus `/help <命令>` for one command's full
 *     example list (`helpTopicBlock()`), both in `bridge/slash.ts`.
 *
 * So a wording change here lands in both places at once, and neither side can
 * document a command the other has never heard of.
 *
 * Rules for editing (all enforced by `tests/help-catalog.test.ts`):
 *
 *   - Every local command in `formatHelp()` must appear here, and vice versa
 *     (the drift guard).
 *   - Every entry in `subcommands` must have at least one example using it, so
 *     a new subcommand cannot be documented by its absence.
 *   - Every `kind: "command"` example must actually be recognized by the
 *     bridge's slash parsers — the help must never advertise a line that the
 *     bridge would forward to the agent as chat.
 *   - Examples contain no `<placeholder>` angle brackets: a user copies a line
 *     and sends it. Concrete sample values are labelled in `note`.
 *   - `summary` is one sentence, ≤ 40 characters, no implementation jargon.
 *   - `aliases` holds SHORTENINGS only — a second full word is not listed even
 *     though the parser accepts it.
 */

export type HelpGroupId =
  | "basics"
  | "navigate"
  | "model"
  | "pacing"
  | "reference"
  | "card";

export interface HelpGroup {
  id: HelpGroupId;
  title: string;
  blurb: string;
}

/**
 * One example line.
 *
 * `kind` is `"command"` for a real slash command the bridge recognizes, and
 * `"text"` for plain text the user types (the `..` / `!!` merge suffixes are
 * message text, not commands — calling them commands would be a lie the test
 * suite cannot catch any other way).
 */
export interface HelpExample {
  line: string;
  note: string;
  kind?: "command" | "text";
}

export interface HelpCommandEntry {
  id: string;
  /** Leading-slash spelling, e.g. `/session`. */
  command: string;
  /**
   * Alternate spellings the bridge accepts, without the slash.
   *
   * Only SHORTENINGS belong here (`s`, `ws`, `p`, `sl`, `fo`, `f`, `mg`,
   * `md`, `h`, `?`). A second full word (`permission`, `busy`, `watch`,
   * `notice`, `wxprompt`) is deliberately NOT listed: the parser still accepts
   * it, but showing `/notify (watch, notice)` reads as three commands in a row
   * and made the WeChat `/help` listing unreadable.
   */
  aliases: string[];
  /**
   * One short, neutral sentence: what the command does.
   *
   * Written in a technical register, not conversational prose — the SAME
   * string is rendered in the settings panel AND in WeChat's `/help` table, so
   * "别憋了，现在就把暂存的结论发给我" would read as chatty noise in a
   * monospace listing. Aim for "立即发送暂存的结论": short, plain, no slang.
   */
  summary: string;
  /** Grammar string, shown as secondary text once the row is expanded. */
  usage: string;
  /**
   * Canonical subcommand keywords. Every one of them must be exercised by an
   * example (see the coverage test) — this is the field that keeps a
   * multi-subcommand entry from being documented by three of its ten forms.
   */
  subcommands: string[];
  examples: HelpExample[];
  group: HelpGroupId;
}

export interface HelpCatalog {
  intro: string;
  footer: string;
  groups: HelpGroup[];
  commands: HelpCommandEntry[];
}

const GROUPS: HelpGroup[] = [
  {
    id: "basics",
    title: "常用",
    blurb: "查看帮助、查看状态、中断任务。",
  },
  {
    id: "navigate",
    title: "会话与项目",
    blurb: "会话是一段独立的对话；项目是一个工作目录。",
  },
  {
    id: "model",
    title: "模型与权限",
    blurb: "选择模型、设置推理等级、设定可读写的文件范围。",
  },
  {
    id: "pacing",
    title: "输出节奏",
    blurb: "控制推送到微信的内容与时机。",
  },
  {
    id: "reference",
    title: "引用与回看",
    blurb: "引用其它会话或文件，或查看历史记录。",
  },
  {
    id: "card",
    title: "待处理卡片",
    blurb: "关闭等待确认的权限卡与提问卡。",
  },
];

const INTRO =
  "以 / 开头的消息是指令。每条命令都可以展开查看示例，点击示例即可复制发送。";

const FOOTER =
  "DSH 原生命令（如 /plan、/goal、/compact）同样可在微信使用；发送 /help 可查看当前已注册的命令。";

const COMMANDS: HelpCommandEntry[] = [
  // ── 常用 ────────────────────────────────────────────────────────────────
  {
    id: "help",
    command: "/help",
    aliases: ["h", "?"],
    summary: "查看指令清单与示例",
    usage: "/help | /help <命令名或简写>（也可以 /h 或 /?）",
    subcommands: [],
    group: "basics",
    examples: [
      { line: "/help", note: "全部指令一览" },
      { line: "/help s", note: "该命令的全部例子" },
      { line: "/help merge", note: "写全名也一样" },
      { line: "/h", note: "同 /help" },
      { line: "/?", note: "同 /help" },
    ],
  },
  {
    id: "status",
    command: "/status",
    aliases: [],
    summary: "查看当前状态",
    usage: "/status",
    subcommands: [],
    group: "basics",
    examples: [
      { line: "/status", note: "项目、会话、模型、权限、待处理卡片" },
    ],
  },
  {
    id: "stop",
    command: "/stop",
    aliases: [],
    summary: "中断当前任务",
    usage: "/stop",
    subcommands: [],
    group: "basics",
    examples: [{ line: "/stop", note: "已修改的文件不回滚" }],
  },
  {
    id: "next",
    command: "/next",
    aliases: [],
    summary: "继续发送被限流的消息",
    usage: "/next",
    subcommands: [],
    group: "basics",
    examples: [
      { line: "/next", note: "发送被微信挡下的消息" },
    ],
  },

  // ── 换会话 / 换项目 ──────────────────────────────────────────────────────
  {
    id: "session",
    command: "/session",
    aliases: ["s"],
    summary: "会话管理：列出、切换、置顶、新建",
    usage: "/session list [current] [all|数量] | switch [current] <编号> | pin [编号] | unpin [编号] | new | status（裸 /s 看状态）",
    subcommands: ["list", "list current", "switch", "switch current", "pin", "unpin", "new", "status"],
    group: "navigate",
    examples: [
      { line: "/s list", note: "最近 20 个会话（📌 为置顶）" },
      { line: "/s list current", note: "仅当前项目的会话" },
      { line: "/s list all", note: "全部会话" },
      { line: "/s switch 3", note: "切换到第 3 个（编号见 /s list）" },
      { line: "/s switch current 2", note: "当前项目列表第 2 个" },
      { line: "/s pin 3", note: "置顶第 3 个" },
      { line: "/s pin", note: "置顶当前会话" },
      { line: "/s unpin 3", note: "取消第 3 个的置顶" },
      { line: "/s unpin", note: "取消当前会话的置顶" },
      { line: "/s new", note: "新建会话" },
      { line: "/s status", note: "当前会话状态" },
    ],
  },
  {
    id: "workspace",
    command: "/workspace",
    aliases: ["ws"],
    summary: "工作区管理：列出、切换、添加",
    usage: "/workspace list [all|数量] | status | switch <编号|路径> | add <路径>（裸 /ws 看状态）",
    subcommands: ["list", "status", "switch", "add"],
    group: "navigate",
    examples: [
      { line: "/workspace list", note: "最近 20 个工作区" },
      { line: "/workspace list all", note: "全部工作区" },
      { line: "/workspace status", note: "当前工作区目录" },
      { line: "/workspace switch 2", note: "切换到第 2 个" },
      { line: "/workspace switch D:\\projects\\my-app", note: "按路径切换" },
      { line: "/workspace add D:\\projects\\new-app", note: "添加并切换" },
    ],
  },
  {
    id: "preset",
    command: "/preset",
    aliases: ["p"],
    summary: "Agent 预设管理",
    usage: "/preset list | switch <名称|编号> | status（裸 /p 看状态）",
    subcommands: ["list", "switch", "status"],
    group: "navigate",
    examples: [
      { line: "/p list", note: "列出预设" },
      { line: "/p switch 2", note: "切换到第 2 个" },
      { line: "/p switch build", note: "按名称切换" },
      { line: "/p status", note: "默认预设（影响新会话）" },
    ],
  },

  // ── 换模型 / 改权限 ──────────────────────────────────────────────────────
  {
    id: "model",
    command: "/model",
    aliases: [],
    summary: "模型管理：列出、切换",
    usage: "/model list [提供商] | switch <提供商/模型> | status（裸 /model 看状态）",
    subcommands: ["list", "switch", "status"],
    group: "model",
    examples: [
      { line: "/model list", note: "列出提供商" },
      { line: "/model list openrouter", note: "该提供商下的模型" },
      { line: "/model switch deepseek/deepseek-chat", note: "切换模型，立即生效" },
      { line: "/model status", note: "当前模型" },
    ],
  },
  {
    id: "reasoning",
    command: "/reasoning",
    aliases: [],
    summary: "推理等级设置",
    usage: "/reasoning [list | switch <等级> | default]",
    subcommands: ["list", "switch", "default"],
    group: "model",
    examples: [
      { line: "/reasoning", note: "当前档位与可用档位" },
      { line: "/reasoning list", note: "该模型支持的等级" },
      { line: "/reasoning switch high", note: "切换到 high" },
      { line: "/reasoning switch 高", note: "支持中文等级名" },
      { line: "/reasoning default", note: "恢复模型默认" },
    ],
  },
  {
    id: "perm",
    command: "/perm",
    aliases: [],
    summary: "权限管理：查看、切换、默认值",
    usage: "/perm status | list | switch <名称|编号> | default [名称|编号]（裸 /perm 看状态）",
    subcommands: ["list", "status", "switch", "default"],
    group: "model",
    examples: [
      { line: "/perm list", note: "列出权限档" },
      { line: "/perm status", note: "当前会话与新会话默认" },
      { line: "/perm switch 2", note: "当前会话切换，立即生效" },
      { line: "/perm switch workspace-write", note: "按名称切换，仅当前会话" },
      { line: "/perm default 1", note: "新会话默认第 1 档" },
      { line: "/perm default", note: "新会话默认档" },
    ],
  },
  {
    id: "enter",
    command: "/enter",
    aliases: [],
    summary: "繁忙时消息投递方式",
    usage: "/enter [status | queue | steer]",
    subcommands: ["status", "steer", "queue"],
    group: "model",
    examples: [
      { line: "/enter", note: "当前投递方式" },
      { line: "/enter status", note: "同上" },
      { line: "/enter steer", note: "插话：立即插入当前轮" },
      { line: "/enter queue", note: "排队：等待下一轮" },
      { line: "/enter 排队", note: "同 queue" },
    ],
  },

  // ── 回复太多？调节奏 ─────────────────────────────────────────────────────
  {
    id: "silent",
    command: "/silent",
    aliases: ["sl"],
    summary: "仅发送每轮最终回复",
    usage: "/silent on|off|status",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/silent on", note: "开启：仅最终回复" },
      { line: "/silent off", note: "关闭：显示过程" },
      { line: "/silent", note: "开启 / 关闭状态" },
      { line: "/silent status", note: "同上" },
    ],
  },
  {
    id: "final",
    command: "/final",
    aliases: ["fo"],
    summary: "结论模式：只发送最终结论",
    usage: "/final on|off|status（/f 是 /flush，不是这个）",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/final on", note: "开启；卡片与报错仍立即发送" },
      { line: "/final off", note: "关闭并发送暂存结论" },
      { line: "/final", note: "状态与暂存条数" },
      { line: "/final status", note: "同上" },
    ],
  },
  {
    id: "flush",
    command: "/flush",
    aliases: ["f"],
    summary: "立即发送暂存的结论",
    usage: "/flush（也可以 /f）",
    subcommands: [],
    group: "pacing",
    examples: [
      { line: "/flush", note: "取回暂存结论" },
      { line: "/f", note: "同上，非 /final 的缩写" },
    ],
  },
  {
    id: "merge",
    command: "/merge",
    aliases: ["mg"],
    summary: "打字合并：多条消息合成一轮",
    usage: "/merge on|off|status；正文末尾 `..` 继续追加、`!!` 立刻提交",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/merge on", note: "开启：静默窗口后合并" },
      { line: "/merge off", note: "关闭并发送暂存消息" },
      { line: "/merge", note: "窗口、上限、暂存条数" },
      { line: "/merge status", note: "窗口、上限、暂存条数" },
      { line: "帮我改下登录页 ..", note: "追加：先不发送（需先 /merge on）", kind: "text" },
      { line: "跑一下测试 !!", note: "立即提交（需先 /merge on）", kind: "text" },
    ],
  },
  {
    id: "media",
    command: "/media",
    aliases: ["md"],
    summary: "图片/文件与文字合并发送",
    usage: "/media on|off | at|path | status",
    subcommands: ["on", "off", "at", "path", "status"],
    group: "pacing",
    examples: [
      { line: "/media on", note: "开启：附件与下一条文字合并" },
      { line: "/media off", note: "关闭并发送暂存附件" },
      { line: "/media at", note: "附件写成 @引用" },
      { line: "/media path", note: "附件写成「已保存到: 路径」" },
      { line: "/media", note: "两个开关的状态" },
      { line: "/media status", note: "两个开关的状态" },
    ],
  },
  {
    id: "notify",
    command: "/notify",
    aliases: [],
    summary: "跨会话提醒推送",
    usage: "/notify on|off|status；/notify tasks on|off",
    subcommands: ["on", "off", "status", "tasks"],
    group: "pacing",
    examples: [
      { line: "/notify on", note: "开启：跨会话卡片推微信" },
      { line: "/notify off", note: "关闭" },
      { line: "/notify tasks on", note: "任务完成或报错也提醒" },
      { line: "/notify tasks off", note: "仅关任务提醒" },
      { line: "/notify", note: "两个开关的状态" },
      { line: "/notify status", note: "两个开关的状态" },
    ],
  },
  {
    id: "surface",
    command: "/surface",
    aliases: [],
    summary: "微信渠道提示词开关",
    usage: "/surface on|off|status",
    subcommands: ["on", "off", "status"],
    group: "pacing",
    examples: [
      { line: "/surface on", note: "开启：注入提示词" },
      { line: "/surface off", note: "关闭" },
      { line: "/surface", note: "状态；正文在设置页编辑" },
      { line: "/surface status", note: "状态；正文在设置页编辑" },
    ],
  },

  // ── 引用与回看 ───────────────────────────────────────────────────────────
  {
    id: "at",
    command: "/at",
    aliases: [],
    summary: "引用会话或文件",
    usage: "/at [s <编号|关键词> | f <路径> | rm <编号> | clear]",
    subcommands: ["s", "f", "rm", "clear"],
    group: "reference",
    examples: [
      { line: "/at", note: "查看已引用（会话 3、文件 8）" },
      { line: "/at s 2", note: "引用第 2 个会话" },
      { line: "/at s 部署", note: "按关键词查找会话" },
      { line: "/at f D:\\logs\\build.log", note: "引用文件" },
      { line: "/at f \"D:\\my docs\\spec.md\"", note: "含空格的路径加引号" },
      { line: "/at rm 1", note: "移除第 1 个引用" },
      { line: "/at clear", note: "清空全部引用" },
    ],
  },
  {
    id: "history",
    command: "/history",
    aliases: [],
    summary: "查看历史记录",
    usage: "/history [all] [数量]（默认 5，最多 20）",
    subcommands: ["all"],
    group: "reference",
    examples: [
      { line: "/history", note: "最近 5 条" },
      { line: "/history 10", note: "最近 10 条（上限 20）" },
      { line: "/history all", note: "含系统消息" },
      { line: "/history all 10", note: "系统消息 + 10 条" },
    ],
  },

  // ── 卡片 ────────────────────────────────────────────────────────────────
  {
    id: "rq",
    command: "/rq",
    aliases: [],
    summary: "关闭待处理卡片",
    usage: "/rq；其它会话的卡用 P1=/rq；/rp 只拒绝权限卡",
    subcommands: [],
    group: "card",
    examples: [
      { line: "/rq", note: "关闭当前会话全部卡片" },
      { line: "P1=/rq", note: "仅关闭第 1 张卡" },
      { line: "/rp", note: "仅拒绝权限卡" },
    ],
  },
];

/**
 * The catalog, as a JSON-safe snapshot.
 *
 * Returned as fresh objects so a consumer (or a test) mutating its copy can
 * never change what the next request serves — the browser half and the WeChat
 * `/help` text are two views of the same install.
 */
export function helpCatalog(): HelpCatalog {
  return {
    intro: INTRO,
    footer: FOOTER,
    groups: GROUPS.map((group) => ({ ...group })),
    commands: COMMANDS.map((entry) => ({
      ...entry,
      aliases: [...entry.aliases],
      subcommands: [...entry.subcommands],
      examples: entry.examples.map((example) => ({ ...example })),
    })),
  };
}

/**
 * The shortest spelling of a command: the command name itself or its shortest
 * alias, with the leading slash. `/session` → `/s`, `/perm` → `/perm`.
 *
 * WeChat's `/help` uses this for BOTH the command head and every subcommand it
 * lists (`/s list`, `/md at`), so a reader never sees a long spelling where a
 * short one exists.
 */
export function shortestSpelling(entry: HelpCommandEntry): string {
  const names = [entry.command.replace(/^\//, ""), ...entry.aliases];
  const shortest = names.reduce((best, name) => (name.length < best.length ? name : best));
  return `/${shortest}`;
}

/**
 * Find a catalog entry by any spelling it accepts, case-insensitively.
 *
 * Used by WeChat's `/help <topic>`: the user may type `/help session`,
 * `/help s`, or `/help SESSION`. Returns `undefined` for an unknown topic so
 * the caller can fall back to the listing instead of inventing an answer.
 */
export function findHelpEntry(topic: string): HelpCommandEntry | undefined {
  const needle = topic.trim().replace(/^\//, "").toLowerCase();
  if (!needle) return undefined;
  return COMMANDS.find((entry) => {
    if (entry.command.replace(/^\//, "").toLowerCase() === needle) return true;
    return entry.aliases.some((alias) => alias.toLowerCase() === needle);
  });
}

