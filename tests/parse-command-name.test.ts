/**
 * Tests for parseCommandName — the minimal wire parser mirroring
 * `@deepseek-ai/dsh-commands.parseCommand`. The bridge uses this to
 * decide whether a leading-slash line is a candidate for native
 * dispatch through `ctx.commands.find(agent, name)`, before falling
 * back to the local whitelist / forwarding.
 */

import { describe, expect, it } from "vitest";
import { parseCommandName } from "../src/bridge/slash.js";

describe("parseCommandName", () => {
  it("extracts a bare slash command", () => {
    expect(parseCommandName("/plan")).toBe("plan");
    expect(parseCommandName("/goal")).toBe("goal");
    expect(parseCommandName("/compact")).toBe("compact");
  });

  it("extracts the name and stops at the first whitespace", () => {
    expect(parseCommandName("/plan off")).toBe("plan");
    expect(parseCommandName("/goal 写一个 demo")).toBe("goal");
    expect(parseCommandName("/plan\tmessage")).toBe("plan");
    expect(parseCommandName("/compact\n")).toBe("compact");
  });

  it("accepts names containing digits, underscore, and hyphen", () => {
    expect(parseCommandName("/plan2")).toBe("plan2");
    expect(parseCommandName("/my_tool")).toBe("my_tool");
    expect(parseCommandName("/a-b-c")).toBe("a-b-c");
  });

  it("rejects names starting with a digit or hyphen", () => {
    expect(parseCommandName("/1plan")).toBeNull();
    expect(parseCommandName("/-plan")).toBeNull();
  });

  it("rejects names containing uppercase letters", () => {
    expect(parseCommandName("/Plan")).toBeNull();
    expect(parseCommandName("/PLAN")).toBeNull();
    expect(parseCommandName("/planMode")).toBeNull();
  });

  it("rejects names containing punctuation or non-ASCII", () => {
    expect(parseCommandName("/plan.")).toBeNull();
    expect(parseCommandName("/plan/off")).toBeNull();
    expect(parseCommandName("/plan?")).toBeNull();
    // zh-CN is not in the registry's allowed name set; reject even
    // though it sits right after the slash.
    expect(parseCommandName("/计划")).toBeNull();
  });

  it("rejects lines without a leading slash", () => {
    expect(parseCommandName("plan off")).toBeNull();
    expect(parseCommandName("")).toBeNull();
    expect(parseCommandName("/")).toBeNull();
    expect(parseCommandName(" /plan")).toBeNull(); // leading whitespace not allowed
  });

  it("rejects lines where the name is followed by another identifier char", () => {
    // The byte after the name must be EOL or whitespace; "/planA" looks
    // like a single identifier to the registry's name grammar.
    expect(parseCommandName("/planA")).toBeNull();
  });

  it("preserves case sensitivity (lowercase-only wire contract)", () => {
    // A bare `/plan` after surrounding whitespace must still be rejected
    // — only the byte-zero position counts.
    expect(parseCommandName("  /plan")).toBeNull();
  });
});