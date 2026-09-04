/**
 * Pure helpers for the WeChat surface-prompt runtime context.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SURFACE_PROMPT } from "../src/config.js";
import {
  sanitizeRuntimeContextText,
  sessionIdFromAssembleContext,
  weChatSurfaceText,
} from "../src/surface-prompt.js";

describe("weChatSurfaceText", () => {
  it("returns the prompt only when enabled and the last source is wechat", () => {
    expect(
      weChatSurfaceText({
        enabled: true,
        prompt: DEFAULT_SURFACE_PROMPT,
        source: "wechat",
      }),
    ).toBe(DEFAULT_SURFACE_PROMPT);
  });

  it("hides the prompt for gui / missing source / disabled / blank text", () => {
    expect(
      weChatSurfaceText({ enabled: true, prompt: DEFAULT_SURFACE_PROMPT, source: "gui" }),
    ).toBe("");
    expect(
      weChatSurfaceText({ enabled: true, prompt: DEFAULT_SURFACE_PROMPT, source: undefined }),
    ).toBe("");
    expect(
      weChatSurfaceText({ enabled: false, prompt: DEFAULT_SURFACE_PROMPT, source: "wechat" }),
    ).toBe("");
    expect(weChatSurfaceText({ enabled: true, prompt: "   ", source: "wechat" })).toBe("");
  });

  it("breaks {{variable}} groups so DSH interpolate cannot throw", () => {
    const text = weChatSurfaceText({
      enabled: true,
      prompt: "hello {{model}} world",
      source: "wechat",
    });
    expect(text).toBe("hello { {model}} world");
    expect(text).not.toContain("{{");
  });
});

describe("sanitizeRuntimeContextText", () => {
  it("replaces every {{ pair", () => {
    expect(sanitizeRuntimeContextText("a {{x}} b {{y}}")).toBe("a { {x}} b { {y}}");
  });
});

describe("sessionIdFromAssembleContext", () => {
  it("reads agent.session.header.id first, then agent.id / scope", () => {
    expect(
      sessionIdFromAssembleContext({
        agent: { id: "agent-id", session: { header: { id: "header-id" } } },
      }),
    ).toBe("header-id");
    expect(sessionIdFromAssembleContext({ agent: { id: "agent-id" } })).toBe("agent-id");
    expect(sessionIdFromAssembleContext({ scope: { id: "scope-id" } })).toBe("scope-id");
    expect(sessionIdFromAssembleContext({})).toBeUndefined();
  });
});
