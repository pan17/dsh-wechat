/**
 * Tests for the WeChat send helpers: splitText.
 * Ported from wechat-opencode (MIT) — test-enqueue-outbound.mjs style cases.
 */

import { describe, expect, it } from "vitest";
import { sanitizeWeChatText, splitText } from "../src/weixin/send.js";

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

  it("does not split a surrogate pair on a hard cut", () => {
    const wave = "👋";
    const text = `${"a".repeat(9)}${wave}`;
    const segments = splitText(text, 10);
    expect(segments[0]).toBe("a".repeat(9));
    expect(segments[1]).toBe(wave);
    expect(segments.join("")).toBe(text);
  });
});

describe("sanitizeWeChatText", () => {
  it("replaces a lone high surrogate left by truncation", () => {
    const poisoned = `${"x".repeat(5)}\uD83C…`;
    expect(sanitizeWeChatText(poisoned)).toBe(`${"x".repeat(5)}\uFFFD…`);
  });

  it("keeps a complete emoji pair", () => {
    expect(sanitizeWeChatText("hi 👋")).toBe("hi 👋");
  });
});
