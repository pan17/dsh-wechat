/**
 * `/history [all] [N]` parser: default is human+assistant only;
 * `all` includes synthesized system injections. Token order of `all`
 * and the count does not matter. Invalid tokens still fail closed so
 * the bridge can show usage instead of forwarding.
 */

import { describe, expect, it } from "vitest";
import { parseHistoryCommand } from "../src/bridge/slash.js";

describe("parseHistoryCommand", () => {
  it("defaults to 5 human+assistant turns", () => {
    expect(parseHistoryCommand("/history")).toEqual({
      kind: "history",
      count: 5,
      includeSystem: false,
    });
  });

  it("accepts a count", () => {
    expect(parseHistoryCommand("/history 10")).toEqual({
      kind: "history",
      count: 10,
      includeSystem: false,
    });
  });

  it("clamps oversized counts to HISTORY_MAX", () => {
    expect(parseHistoryCommand("/history 30")?.count).toBe(20);
  });

  it("accepts all with the default count", () => {
    expect(parseHistoryCommand("/history all")).toEqual({
      kind: "history",
      count: 5,
      includeSystem: true,
    });
  });

  it("accepts all before or after the count", () => {
    expect(parseHistoryCommand("/history all 10")).toEqual({
      kind: "history",
      count: 10,
      includeSystem: true,
    });
    expect(parseHistoryCommand("/history 10 all")).toEqual({
      kind: "history",
      count: 10,
      includeSystem: true,
    });
  });

  it("is case-insensitive on the command and all", () => {
    expect(parseHistoryCommand("/HISTORY ALL 3")).toEqual({
      kind: "history",
      count: 3,
      includeSystem: true,
    });
  });

  it("rejects unknown tokens, duplicates, and non-positive counts", () => {
    expect(parseHistoryCommand("/history abc")).toBeNull();
    expect(parseHistoryCommand("/history sys")).toBeNull();
    expect(parseHistoryCommand("/history all all")).toBeNull();
    expect(parseHistoryCommand("/history 10 5")).toBeNull();
    expect(parseHistoryCommand("/history 0")).toBeNull();
    expect(parseHistoryCommand("/history all 0")).toBeNull();
  });
});
