import { describe, expect, it } from "vitest";
import { ExecutionProcess, desktopToolSummary, toolResultSummary } from "../src/adapter/process-format.js";

describe("desktop collapsed process content", () => {
  it("matches the screenshot rows, hiding reasoning body and successful output", () => {
    const process = new ExecutionProcess("C:\\work");
    process.addReasoning({ type: "reasoning", text: "**Investigating output issues**\nVery long private detail" });
    process.addCall("c1", "read", '{"file_path":"C:\\\\work\\\\src\\\\foo_bar.ts"}');
    process.addResult({ message: { toolCallId: "c1", content: [{ type: "text", text: "a_b * c_d" }] } });
    process.addCall("c2", "pwsh", '{"description":"Check workspace location","command":"pwd"}');
    expect(process.take(4000)).toBe("⚙️ 已读取文件并执行了命令\n🧠 思考 · Investigating output issues\n📄 读取 · src\\foo_bar.ts\n💻 运行命令 · Check workspace location");
    expect(process.take(4000)).toBeUndefined();
  });
  it("uses desktop variant keys and only first lines", () => {
    expect(desktopToolSummary("read", '{"description":"wrong","file_path":"src/a.ts"}')).toBe("src/a.ts");
    expect(desktopToolSummary("pwsh", '{"description":"Run checks\\nmore","command":"npm test"}')).toBe("Run checks");
    expect(desktopToolSummary("web_search", '{"queries":["one\\nmore","two"]}')).toBe("one, two");
    expect(desktopToolSummary("glob", '{"pattern":"**/AGENTS.md"}')).toBe("**/AGENTS.md");
  });
  it("shows only the failed tool first line and does not repeat successful completions", () => {
    const process = new ExecutionProcess();
    process.addCall("c1", "pwsh", '{"description":"Run checks"}');
    process.take(4000);
    process.addResult({ message: { toolCallId: "c1", content: [{ type: "text", text: "success detail" }] } });
    expect(process.take(4000)).toBeUndefined();
    process.addResult({ message: { toolCallId: "c1", isError: true, content: [{ type: "text", text: "Error: failed\nstack trace" }] } });
    expect(process.take(4000)).toBe("⚙️ 执行了命令\n❌ 运行命令 · Error: failed");
    expect(toolResultSummary({ message: { content: [{ type: "image" }] } })).toBe("");
  });
  it("renders task progress and changes rather than raw JSON", () => {
    const process = new ExecutionProcess();
    process.addCall("t1", "todo_write", JSON.stringify({ todos: [{ content: "检查代码", status: "in_progress" }, { content: "测试", status: "pending" }] }));
    expect(process.take(4000)).toContain("更新任务清单 · 0/2 已完成 · 检查代码 · 新增 2");
    process.addCall("t2", "todo_write", JSON.stringify({ todos: [{ content: "检查代码", status: "completed" }, { content: "测试", status: "in_progress" }] }));
    expect(process.take(4000)).toContain("更新任务清单 · 1/2 已完成 · 测试 · 更新 2");
  });
  it("handles unknown calls and bounds the group", () => {
    const process = new ExecutionProcess();
    process.addCall("c1", "unknown", "broken_json *\nmore");
    expect(process.take(4000)).toContain("工具调用 · unknown · broken_json *");
    for (let i = 0; i < 100; i++) process.addReasoning({ type: "reasoning", text: `第 ${i} 项 ` + "内容".repeat(600) });
    const text = process.take(1000)!;
    expect(text.length).toBeLessThanOrEqual(1000); expect(text).toContain("已省略");
    expect(text).not.toContain("\n\n");
  });
});
