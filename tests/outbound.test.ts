/**
 * Tests for formatForWeChat — the port of the official openclaw-weixin
 * `StreamingMarkdownFilter` applied to one complete message body.
 */

import { describe, expect, it } from "vitest";
import { filterMarkdown, formatForWeChat, StreamingMarkdownFilter } from "../src/adapter/outbound.js";

describe("formatForWeChat", () => {
  it("removes image references entirely, like the official filter", () => {
    expect(formatForWeChat("before ![logo](https://x/y.png) after")).toBe("before  after");
  });

  it("keeps links, which WeChat renders", () => {
    expect(formatForWeChat("[docs](https://dsh.dev)")).toBe("[docs](https://dsh.dev)");
  });

  it("keeps bold wrapped around Latin content", () => {
    expect(formatForWeChat("**bold**")).toBe("**bold**");
    expect(formatForWeChat("***both***")).toBe("***both***");
    expect(formatForWeChat("__under__")).toBe("__under__");
  });

  it("strips emphasis markers around CJK content", () => {
    expect(formatForWeChat("*斜体*")).toBe("斜体");
    expect(formatForWeChat("***加粗斜体***")).toBe("加粗斜体");
    expect(formatForWeChat("___下划线粗斜体___")).toBe("下划线粗斜体");
  });

  it("passes double-marker emphasis through whatever the script", () => {
    expect(formatForWeChat("__下划线__")).toBe("__下划线__");
    expect(formatForWeChat("**中文粗体**")).toBe("**中文粗体**");
  });

  it("keeps H1-H4 headings but strips H5/H6 markers", () => {
    expect(formatForWeChat("# Title\n## Sub\n#### Deep")).toBe("# Title\n## Sub\n#### Deep");
    expect(formatForWeChat("##### Five\n###### Six")).toBe("Five\nSix");
  });

  it("keeps block quotes, horizontal rules and code fences", () => {
    expect(formatForWeChat("> quoted")).toBe("> quoted");
    expect(formatForWeChat("---")).toBe("---");
    const fenced = "```js\nconst x = 1;\n```";
    expect(formatForWeChat(fenced)).toBe(fenced);
  });

  it("keeps markdown inside fenced code blocks verbatim", () => {
    const fenced = "```\n**not bold** *not italic*\n```";
    expect(formatForWeChat(fenced)).toBe(fenced);
  });

  it("keeps inline code and tables", () => {
    expect(formatForWeChat("use `code` here")).toBe("use `code` here");
    expect(formatForWeChat("| a | b |\n| - | - |")).toBe("| a | b |\n| - | - |");
  });

  it("restores an unterminated marker on flush", () => {
    expect(formatForWeChat("incomplete **bold")).toBe("incomplete **bold");
    expect(formatForWeChat("trailing *")).toBe("trailing *");
  });
});

describe("StreamingMarkdownFilter", () => {
  it("holds back a partial marker until it can be disambiguated", () => {
    const filter = new StreamingMarkdownFilter();
    // A trailing `*` may still become `***`, so it is withheld until more arrives.
    expect(filter.feed("text *")).toBe("text ");
    // With the next feed, `**bold**` is recognised and passed through whole.
    expect(filter.feed("*bold** done")).toBe("**bold** done");
  });

  it("produces the same result when fed in chunks as in one piece", () => {
    const source = "段一 *中文斜体* 和 **Latin bold**\n\n```\ncode\n```\n尾";
    const chunked = (() => {
      const filter = new StreamingMarkdownFilter();
      let out = "";
      for (const ch of source) out += filter.feed(ch);
      return out + filter.flush();
    })();
    expect(chunked).toBe(filterMarkdown(source));
  });
});
