/**
 * Tests for question-format parsing/formatting.
 * Adapted from wechat-opencode (MIT) — test-question-format.mjs.
 */

import { describe, expect, it } from "vitest";
import { formatQuestionForWeChat, parseQuestionReply, buildAnswer } from "../src/adapter/question-format.js";
import type { AskUserQuestionItem } from "../src/dsh/types.js";

const single: AskUserQuestionItem[] = [
  {
    id: "q1",
    question: "Continue with the refactor?",
    header: "Confirm",
    options: [
      { label: "Yes, continue", description: "proceed with the change" },
      { label: "No, stop", description: "abort" },
    ],
  },
];

const multi: AskUserQuestionItem[] = [
  { id: "q1", question: "Pick a framework", options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }] },
  { id: "q2", question: "Why?", options: [{ label: "Performance" }, { label: "Ecosystem" }] },
];

describe("formatQuestionForWeChat", () => {
  it("renders a single question with options and hint", () => {
    const out = formatQuestionForWeChat(single);
    expect(out).toContain("❓ [Confirm]");
    expect(out).toContain("1. Yes, continue — proceed with the change");
    expect(out).toContain("2. No, stop — abort");
    expect(out).toContain("/rq");
    expect(out).toContain("回复选项编号");
    expect(out).toContain("跳过：发送 `/rq`");
  });

  it("renders multi-question with Qn hints", () => {
    const out = formatQuestionForWeChat(multi);
    expect(out).toContain("问题 1/2");
    expect(out).toContain('Q1=1 Q2=2');
  });
});

describe("parseQuestionReply", () => {
  it("single question: bare option number", () => {
    const parsed = parseQuestionReply("2", single);
    expect(parsed.allAnswered).toBe(true);
    expect(parsed.answers[0]).toEqual(["No, stop"]);
  });

  it("single question: custom text", () => {
    const parsed = parseQuestionReply("my own answer", single);
    expect(parsed.answers[0]).toEqual(["my own answer"]);
  });

  it("single question: out-of-range number falls back to custom", () => {
    const parsed = parseQuestionReply("99", single);
    expect(parsed.answers[0]).toEqual(["99"]);
  });

  it("empty input: default answer, not answered", () => {
    const parsed = parseQuestionReply("   ", single);
    expect(parsed.allAnswered).toBe(false);
    expect(parsed.answers[0]).toEqual(["Yes, continue"]);
  });

  it("multi-question Qn format with custom via dash", () => {
    const parsed = parseQuestionReply("Q2-因为快 Q1=2", multi);
    expect(parsed.answers[0]).toEqual(["Vue"]);
    expect(parsed.answers[1]).toEqual(["因为快"]);
  });

  it("multi-question positional dash format", () => {
    const parsed = parseQuestionReply("1 --- 2", multi);
    expect(parsed.answers[0]).toEqual(["React"]);
    expect(parsed.answers[1]).toEqual(["Ecosystem"]);
  });

  it("multi-select: comma-separated numbers", () => {
    const multiSelect: AskUserQuestionItem[] = [
      { id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true },
    ];
    const parsed = parseQuestionReply("1, 3", multiSelect);
    expect(parsed.answers[0]).toEqual(["A", "C"]);
  });

  it("out-of-range Qn emits a warning", () => {
    const parsed = parseQuestionReply("Q5=1", multi);
    expect(parsed.warnings.some((w) => w.includes("超出范围"))).toBe(true);
  });
});

describe("buildAnswer", () => {
  it("maps labels to selected and custom text to custom", () => {
    const parsed = parseQuestionReply("Q1=1 Q2-自定义答案", multi);
    const answer = buildAnswer(parsed, multi);
    expect(answer.answers).toEqual([
      { id: "q1", selected: ["React"] },
      { id: "q2", selected: [], custom: "自定义答案" },
    ]);
  });

  it("echoes question ids", () => {
    const parsed = parseQuestionReply("1", single);
    const answer = buildAnswer(parsed, single);
    expect(answer.answers[0]!.id).toBe("q1");
  });
});
