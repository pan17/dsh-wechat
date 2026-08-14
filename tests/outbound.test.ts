/**
 * Tests for formatForWeChat (outbound markdown stripping).
 */

import { describe, expect, it } from "vitest";
import { formatForWeChat } from "../src/adapter/outbound.js";

describe("formatForWeChat", () => {
  it("strips image references to alt text", () => {
    expect(formatForWeChat("![logo](https://x/y.png)")).toBe("[logo]");
  });

  it("converts links to text (url)", () => {
    expect(formatForWeChat("[docs](https://dsh.dev)")).toBe("docs (https://dsh.dev)");
  });

  it("removes bold and italic markers but keeps text", () => {
    expect(formatForWeChat("**bold** and *italic* and `code`")).toBe("bold and italic and `code`");
    expect(formatForWeChat("***both***")).toBe("both");
  });

  it("removes heading markers", () => {
    expect(formatForWeChat("# Title\n## Sub")).toBe("Title\nSub");
  });

  it("collapses excessive blank lines", () => {
    expect(formatForWeChat("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("preserves code blocks", () => {
    const input = "```js\nconst x = 1;\n```";
    expect(formatForWeChat(input)).toBe(input);
  });
});
