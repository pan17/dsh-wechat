/**
 * Tests for the WeChat send helpers: splitText.
 * Ported from wechat-opencode (MIT) — test-enqueue-outbound.mjs style cases.
 */

import { describe, expect, it } from "vitest";
import { splitText } from "../src/weixin/send.js";

describe("splitText", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(splitText("hello", 10)).toEqual(["hello"]);
    expect(splitText("", 10)).toEqual([""]);
  });

  it("splits on line breaks when available near the limit", () => {
    const text = "line one\nline two\nline three";
    const segments = splitText(text, 10);
    expect(segments).toEqual(["line one", "line two", "line three"]);
  });

  it("hard-splits long lines without line breaks", () => {
    const text = "a".repeat(25);
    const segments = splitText(text, 10);
    expect(segments).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("strips the leading newline after a line-break split", () => {
    const text = "1234567890\nrest";
    const segments = splitText(text, 10);
    expect(segments).toEqual(["1234567890", "rest"]);
  });

  it("handles exact-boundary content", () => {
    expect(splitText("a".repeat(10), 10)).toEqual(["a".repeat(10)]);
  });
});
