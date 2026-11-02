/**
 * `/history` 解析：`/fork` 的同一套语法，减去 `switch`。
 *
 *   /history                  → list（默认窗口，5 轮）
 *   /history list [all|数量]  → 与 `/s list`、`/fork list` 逐字相同的窗口语法
 *   /history show <编号>      → 恰好一个正整数
 *
 * 两个旧写法现在是**用法错误**，不是「换个意思继续执行」：裸数量
 * `/history 10`（旧版是「10 条消息」）和 `/history all`（旧版是「含系统消息」）。
 * 静默保留一个与 `/fork` 不一致的语法，比回一句提示糟得多。
 */

import { describe, expect, it } from "vitest";
import { parseHistoryCommand } from "../src/bridge/slash.js";

describe("parseHistoryCommand", () => {
  it("treats the bare form as list", () => {
    expect(parseHistoryCommand("/history")).toEqual({ kind: "list" });
    expect(parseHistoryCommand("/history list")).toEqual({ kind: "list" });
    expect(parseHistoryCommand("  /HISTORY  ")).toEqual({ kind: "list" });
  });

  it("accepts the shared window grammar", () => {
    expect(parseHistoryCommand("/history list 10")).toEqual({ kind: "list", limit: 10 });
    expect(parseHistoryCommand("/history list all")).toEqual({ kind: "list", all: true });
    // `all` wins over a count, exactly like `/s list all 5`.
    expect(parseHistoryCommand("/history list all 5")).toEqual({
      kind: "list",
      all: true,
      limit: 5,
    });
  });

  it("parses show with exactly one positive integer", () => {
    expect(parseHistoryCommand("/history show 3")).toEqual({ kind: "show", index: 3 });
    expect(parseHistoryCommand("/HISTORY SHOW 3")).toEqual({ kind: "show", index: 3 });
  });

  it("rejects the old spellings instead of reinterpreting them", () => {
    expect(parseHistoryCommand("/history 10")).toBeNull();
    expect(parseHistoryCommand("/history all")).toBeNull();
    expect(parseHistoryCommand("/history all 10")).toBeNull();
    expect(parseHistoryCommand("/history 10 all")).toBeNull();
  });

  it("rejects malformed subcommands, numbers and glued names", () => {
    expect(parseHistoryCommand("/history abc")).toBeNull();
    expect(parseHistoryCommand("/history lsit 2")).toBeNull();
    expect(parseHistoryCommand("/history show")).toBeNull();
    expect(parseHistoryCommand("/history show 0")).toBeNull();
    expect(parseHistoryCommand("/history show -1")).toBeNull();
    expect(parseHistoryCommand("/history show 1 2")).toBeNull();
    expect(parseHistoryCommand("/history show abc")).toBeNull();
    // `/fork switch` has no `/history` counterpart: forking is not reading.
    expect(parseHistoryCommand("/history switch 2")).toBeNull();
    expect(parseHistoryCommand("/history list 0")).toBeNull();
    expect(parseHistoryCommand("/history list all all")).toBeNull();
    expect(parseHistoryCommand("/history list 1 2")).toBeNull();
    expect(parseHistoryCommand("/historylist")).toBeNull();
  });
});
