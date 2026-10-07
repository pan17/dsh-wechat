import type { OutputContentBlock, ToolResultData } from "../dsh/types.js";

const MAX_ENTRIES = 40;
const MAX_CALLS = 100;
const firstLine = (text: string) => text.split("\n", 1)[0]!.trim();
function excerpt(text: string, limit = 160): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : clean.slice(0, Math.max(0, limit - 1)) + "…";
}

// Mirror the desktop Tool row's Chinese titles and variant-specific summary keys.
const TITLES: Record<string, string> = {
  read: "读取", read_image: "读取图片", write: "写入", edit: "编辑", apply_patch: "编辑",
  bash: "运行命令", pwsh: "运行命令", exec_command: "运行命令", write_stdin: "运行命令",
  grep: "搜索文件内容", glob: "查找文件", web_search: "网页搜索", web_fetch: "网页获取", run_code: "代码",
  todo_write: "更新任务清单", ask_user_question: "提问", request_user_input: "提问",
  create_goal: "创建目标", get_goal: "查看目标", update_goal: "更新目标",
  schedule_create: "创建定时任务", schedule_list: "查看定时任务", schedule_delete: "删除定时任务", schedule_update: "修改定时任务",
  cordis_inspect_list: "检查提供方", cordis_inspect_query: "查询运行时", cordis_inspect_self: "检查动态插件",
  cordis_package_inspect: "查询 Cordis 环境", cordis_runtime_inspect: "查询 Cordis 环境",
  cordis_run: "运行 Cordis 插件", cordis_stop: "停止 Cordis 插件", cordis_undefine: "移除 Cordis 插件",
  workflow: "运行工作流", ralph: "运行循环工作流", session_event_read: "读取事件", session_event_search: "搜索事件",
  session_event_trace: "追踪事件", session_search: "搜索会话", session_trace: "追踪会话",
  list_subagent_models: "查看可用模型", subagent: "创建子智能体", list_agents: "查看子智能体", send_message: "发送消息",
  interrupt_agent: "中断智能体", job_list: "查看后台任务", job_output: "读取任务输出", job_kill: "取消后台任务",
  terminal_open: "创建终端", terminal_read: "读取终端", terminal_list: "查看终端", terminal_signal: "发送终端信号", terminal_close: "关闭终端",
  lsp: "查询代码符号", spawn_teammate: "创建队友", team_task_create: "创建团队任务", team_task_get: "读取团队任务",
  team_task_update: "更新团队任务", team_task_list: "查看团队任务", wait_agent: "等待子智能体",
};

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

export function desktopToolSummary(name: string, raw: string, cwd?: string): string {
  const args = parseArgs(raw);
  let summary = firstLine(raw);
  if (args) {
    const keys = ["bash", "pwsh", "exec_command", "write_stdin"].includes(name) ? ["description", "command", "cmd"]
      : ["read", "read_image", "web_fetch", "write", "edit"].includes(name) ? ["path", "file_path", "url"]
      : ["grep", "glob", "web_search"].includes(name) ? ["query", "pattern", "url"]
      : name === "run_code" ? ["description"] : [];
    const queries = ["grep", "glob", "web_search"].includes(name) && Array.isArray(args.queries)
      ? args.queries.filter((q): q is string => typeof q === "string" && !!q).map(firstLine).join(", ") : "";
    const picked = keys.map((key) => args[key]).find((v) => typeof v === "string" && v !== "");
    const fallback = Object.values(args).find((v) => typeof v === "string" && v !== "");
    summary = queries || firstLine(typeof picked === "string" ? picked : typeof fallback === "string" ? fallback : raw);
  }
  const root = cwd?.replace(/[/\\]+$/, "");
  if (root && (summary.startsWith(root + "/") || summary.startsWith(root + "\\"))) summary = summary.slice(root.length + 1);
  return excerpt(summary);
}

export function reasoningSummary(text: string): string {
  return excerpt(firstLine(text).replaceAll("**", ""));
}

/** The collapsed desktop row shows only the first error line; success output is hidden. */
export function toolResultSummary(data: ToolResultData): string {
  if (!data.message?.isError && !data.error) return "";
  const text = (data.message?.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("\n");
  return excerpt(firstLine(text || (data.error ? `${data.error.name ?? "Error"}: ${data.error.code ?? data.error.reason ?? "工具执行失败"}` : "工具执行失败")));
}

function category(name: string): string {
  if (name === "read") return "已读取文件";
  if (name === "read_image") return "已读取图片";
  if (name === "glob" || name === "grep" || name.endsWith("_inspect")) return "已搜索代码";
  if (["bash", "pwsh", "exec_command", "write_stdin"].includes(name) || name.startsWith("terminal_")) return "执行了命令";
  if (name === "web_search") return "已搜索网页";
  if (name === "web_fetch") return "已访问网页";
  if (name === "write") return "已写入文件";
  if (name === "edit" || name === "apply_patch") return "修改了文件";
  if (name === "run_code") return "运行了代码";
  if (["todo_write", "create_goal", "get_goal", "update_goal"].includes(name)) return "更新了计划";
  if (name === "ask_user_question" || name === "request_user_input") return "向用户提出了问题";
  if (name === "subagent" || name.startsWith("subagent_")) return "已协调子智能体";
  return "已调用工具";
}

const CATEGORY_EMOJI: Record<string, string> = {
  "已读取文件": "📄", "已读取图片": "🖼️", "已搜索代码": "🔍", "执行了命令": "💻",
  "已搜索网页": "🌐", "已访问网页": "🌐", "已写入文件": "📝", "修改了文件": "✏️",
  "运行了代码": "💻", "更新了计划": "📋", "向用户提出了问题": "❓", "已协调子智能体": "🤝",
};

function toolEmoji(name: string): string {
  if (name.startsWith("schedule_")) return "⏰";
  return CATEGORY_EMOJI[category(name)] ?? "🔧";
}

type Todo = { content?: string; status?: string };
type Entry = { kind: "reasoning"; text: string } | { kind: "tool"; name: string; summary: string; error?: string };

/** One compact group between assistant prose, with desktop collapsed-row content. */
export class ExecutionProcess {
  private entries: Entry[] = [];
  private omitted = 0;
  private calls = new Map<string, { name: string; summary: string; entry?: Extract<Entry, { kind: "tool" }> }>();
  private previousTodos?: Todo[];
  constructor(private cwd?: string) {}

  private append(entry: Entry): boolean {
    if (this.entries.length >= MAX_ENTRIES) { this.omitted++; return false; }
    this.entries.push(entry);
    return true;
  }

  addReasoning(block: OutputContentBlock): void {
    if (typeof block.text !== "string") return;
    const text = reasoningSummary(block.text);
    if (text) this.append({ kind: "reasoning", text });
  }

  private todoSummary(raw: string): string | undefined {
    const todos = parseArgs(raw)?.todos;
    if (!Array.isArray(todos) || !todos.every((t) => t && typeof t === "object")) return undefined;
    const current = todos as Todo[];
    const active = current.filter((t) => t.status === "in_progress");
    const done = current.filter((t) => t.status === "completed").length;
    const head = `${done}/${current.length} 已完成`;
    const activeText = active[0]?.content?.trim();
    const old = new Map(this.previousTodos?.map((t) => [t.content, t.status]));
    let added = 0, updated = 0;
    for (const t of current) {
      if (!old.has(t.content)) added++;
      else if (old.get(t.content) !== t.status) updated++;
      old.delete(t.content);
    }
    const diff = [added ? `新增 ${added}` : "", updated ? `更新 ${updated}` : "", old.size ? `移除 ${old.size}` : ""].filter(Boolean);
    this.previousTodos = current.map((t) => ({ ...t }));
    return excerpt([head, activeText ? firstLine(activeText) : "", ...diff, activeText && active.length > 1 ? `+${active.length - 1}` : ""].filter(Boolean).join(" · "));
  }

  addCall(callId: string, name: string, args: string): void {
    if (this.calls.has(callId)) return;
    const summary = (name === "todo_write" ? this.todoSummary(args) : undefined) ?? desktopToolSummary(name, args, this.cwd);
    const entry: Extract<Entry, { kind: "tool" }> = { kind: "tool", name, summary };
    const retained = this.append(entry);
    this.calls.set(callId, { name, summary, entry: retained ? entry : undefined });
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!);
  }

  addResult(data: ToolResultData): void {
    const id = data.message?.toolCallId;
    const call = id ? this.calls.get(id) : undefined;
    const error = toolResultSummary(data);
    if (!error) return;
    if (call?.entry) call.entry.error = error;
    else this.append({ kind: "tool", name: call?.name ?? id ?? "未知工具", summary: "", error });
  }

  take(limit: number): string | undefined {
    if (!this.entries.length && !this.omitted) return undefined;
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4000;
    const counts = new Map<string, number>();
    for (const entry of this.entries) if (entry.kind === "tool") {
      const key = category(entry.name); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const categories = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const title = categories.length === 0 ? "已完成分析" : categories.length === 1 ? categories[0]!
      : categories.length === 2 ? categories[0] + "并" + (categories[0]!.startsWith("已") && categories[1]!.startsWith("已") ? categories[1]!.slice(1) : categories[1])
      : categories.slice(0, 3).join("，") + (categories.length > 3 ? "等" : "");
    const lines = [`${categories.length ? "⚙️" : "🧠"} ${title}`];
    let omitted = this.omitted;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const row = entry.kind === "reasoning" ? `🧠 思考 · ${entry.text}`
        : `${entry.error ? "❌" : toolEmoji(entry.name)} ${TITLES[entry.name] ?? "工具调用"}${!TITLES[entry.name] ? " · " + entry.name : ""}${entry.error || entry.summary ? " · " + (entry.error || entry.summary) : ""}`;
      if ((lines.join("\n") + "\n" + row).length > max - 60) { omitted += this.entries.length - i; break; }
      lines.push(row);
    }
    if (omitted) lines.push(`… 另有 ${omitted} 项过程已省略，可在 DSH 查看完整记录。`);
    this.entries = []; this.omitted = 0;
    for (const call of this.calls.values()) call.entry = undefined;
    return excerpt(lines.join("\n"), max);
  }
}
