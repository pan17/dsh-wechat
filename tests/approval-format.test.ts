/**
 * Tests for approval-format (WeChat mirror card rendering + reply parsing).
 */

import { describe, expect, it } from "vitest";
import { formatApprovalCard, parseApprovalReply, type PendingApprovalCard } from "../src/adapter/approval-format.js";

function card(rpcId: string, toolName = "pwsh"): PendingApprovalCard {
  return { rpcId, sessionId: "s1", approvalId: `a-${rpcId}`, toolName, askedAt: Date.now() };
}

describe("formatApprovalCard", () => {
  it("renders tool name, reason and the two GUI-equivalent choices", () => {
    const text = formatApprovalCard(card("r1", "bash"));
    expect(text).toContain("🔒 Permission requested");
    expect(text).toContain("Tool: bash");
    expect(text).toContain("1. once   — allow this call only");
    expect(text).toContain("2. reject — deny this call");
    // No third "always" option — the GUI card has exactly two choices.
    expect(text).not.toContain("always");
  });

  it("renders the reason in Details", () => {
    const text = formatApprovalCard({ ...card("r1"), reason: "escalate sandbox" });
    expect(text).toContain("Details:");
    expect(text).toContain("escalate sandbox");
  });

  it("renders index/total for multiple pending cards", () => {
    const text = formatApprovalCard(card("r1"), 1, 2);
    expect(text).toContain("🔒 Permission 1/2");
    expect(text).toContain("P1=1 P2=2");
  });
});

describe("parseApprovalReply", () => {
  it("positional 1/2", () => {
    expect(parseApprovalReply("1", [card("r1")]).decisions).toEqual([{ rpcId: "r1", reply: "once" }]);
    expect(parseApprovalReply("2", [card("r1")]).decisions).toEqual([{ rpcId: "r1", reply: "reject" }]);
  });

  it("keyword forms, case-insensitive", () => {
    expect(parseApprovalReply("once", [card("r1")]).decisions[0]!.reply).toBe("once");
    expect(parseApprovalReply("REJECT", [card("r1")]).decisions[0]!.reply).toBe("reject");
  });

  it("per-card Pn= grammar for multiple cards", () => {
    const { decisions } = parseApprovalReply("P1=1 P2=2", [card("r1"), card("r2")]);
    expect(decisions).toEqual([
      { rpcId: "r1", reply: "once" },
      { rpcId: "r2", reply: "reject" },
    ]);
  });

  it("dash forces reject", () => {
    const { decisions } = parseApprovalReply("P1-理由", [card("r1")]);
    expect(decisions).toEqual([{ rpcId: "r1", reply: "reject" }]);
  });

  it("out-of-range Pn warns", () => {
    const { decisions, warnings } = parseApprovalReply("P9=1", [card("r1")]);
    expect(decisions).toEqual([]);
    expect(warnings.some((w) => w.includes("out of range"))).toBe(true);
  });

  it("single decision applies to all when multiple pending", () => {
    const { decisions, warnings } = parseApprovalReply("2", [card("r1"), card("r2")]);
    expect(decisions).toEqual([
      { rpcId: "r1", reply: "reject" },
      { rpcId: "r2", reply: "reject" },
    ]);
    expect(warnings.some((w) => w.includes("all 2"))).toBe(true);
  });

  it("unrecognized input warns", () => {
    const { decisions, warnings } = parseApprovalReply("maybe", [card("r1")]);
    expect(decisions).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("empty input warns", () => {
    const { decisions, warnings } = parseApprovalReply("  ", [card("r1")]);
    expect(decisions).toEqual([]);
    expect(warnings).toContain("empty input");
  });
});
