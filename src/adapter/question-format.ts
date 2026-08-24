/**
 * Question formatting and parsing, adapted to DSH's user-questions types.
 *
 * Ported from wechat-opencode (MIT) —
 * https://github.com/pan17/wechat-opencode (src/adapter/question-format.ts)
 *
 * Public functions:
 *   - formatQuestionForWeChat(items) — render prompts for WeChat display
 *   - parseQuestionReply(text, items) — parse user reply into answers
 *
 * Parsing strategy (from the reference):
 *   Step 0 (format detection, priority order):
 *     1. Qn-format    — input contains "Q\d+\s*[=\-]"; each Qn routed to a question
 *     2. dash-format  — questions.length > 1 AND input contains "---"; positional
 *     3. single       — questions.length === 1; whole input = that question's answer
 *     4. fallback     — multi-question, no Qn/---: first segment = Q1, rest = defaults
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from "../dsh/types.js";

/** Maximum length (chars) of a single Answer element. Excess is truncated. */
const MAX_ANSWER_ELEMENT_LEN = 500;

export interface ParseResult {
  /**
   * Per-question answers. `answers.length === items.length`. Each inner
   * array contains the selected option labels (or a single custom string).
   */
  answers: string[][];
  /**
   * True if every question got a non-empty answer (either explicit or
   * via default). False if any question is empty.
   */
  allAnswered: boolean;
  /** Non-fatal diagnostics. Logged for the operator; never throw. */
  warnings: string[];
}

// ─── Public: format ───

/**
 * Render a question (or set of questions) as a WeChat-friendly plain-text
 * message. The output stays within the 4000-char WeChat chunk limit and
 * uses emoji + indentation for visual structure.
 */
export function formatQuestionForWeChat(
  items: ReadonlyArray<AskUserQuestionItem>,
): string {
  if (items.length === 0) return "";
  if (items.length === 1) return formatSingle(items[0]!);
  return formatMulti(items);
}

// ─── Public: parse ───

/**
 * Parse a WeChat user reply into per-question answers. See file-header
 * JSDoc for the 4-strategy detection logic.
 */
export function parseQuestionReply(
  input: string,
  items: ReadonlyArray<AskUserQuestionItem>,
): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      answers: items.map((q) => defaultAnswerFor(q)),
      allAnswered: false,
      warnings: ["回复为空"],
    };
  }

  // Step 0: format detection
  if (QN_PATTERN.test(trimmed)) {
    return parseQnFormat(trimmed, items);
  }
  if (items.length > 1 && /---/.test(trimmed)) {
    return parseDashFormat(trimmed, items);
  }
  if (items.length === 1) {
    return {
      answers: [parseSegment(trimmed, items[0]!)],
      allAnswered: true,
      warnings: [],
    };
  }
  // Fallback: multi-question, no Qn- or ---. Use first segment as Q1, rest default.
  return {
    answers: [
      parseSegment(trimmed, items[0]!),
      ...items.slice(1).map((q) => defaultAnswerFor(q)),
    ],
    allAnswered: false,
    warnings: [
      "多题回复未写 Q{n}=，只收下了第 1 题，其余用默认",
    ],
  };
}

// ─── Internal: format helpers ───

function formatSingle(q: AskUserQuestionItem): string {
  const lines: string[] = [];
  lines.push(`❓ [${q.header ?? "提问"}]`);
  lines.push(q.question);
  if (q.detail) lines.push(q.detail);
  lines.push("");
  appendOptions(lines, q);
  lines.push("");
  lines.push(buildHint(q));
  return lines.join("\n");
}

function formatMulti(items: ReadonlyArray<AskUserQuestionItem>): string {
  const total = items.length;
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const q = items[i]!;
    lines.push(`❓ 问题 ${i + 1}/${total} [${q.header ?? "提问"}]`);
    lines.push(q.question);
    if (q.detail) lines.push(q.detail);
    lines.push("");
    appendOptions(lines, q);
    if (i < total - 1) lines.push("");
  }
  lines.push("");
  lines.push(buildMultiHint(items));
  return lines.join("\n");
}

function appendOptions(lines: string[], q: AskUserQuestionItem): void {
  for (let i = 0; i < (q.options?.length ?? 0); i++) {
    const opt = q.options![i]!;
    const line = opt.description
      ? `${i + 1}. ${opt.label} — ${opt.description}`
      : `${i + 1}. ${opt.label}`;
    lines.push(`  ${line}`);
  }
  if (q.multiSelect === true) {
    lines.push("  （可多选；用逗号分隔数字回复）");
  }
}

function buildHint(q: AskUserQuestionItem): string {
  const base =
    (q.options?.length ?? 0) === 0
      ? "💡 直接回复你的答案。"
      : "💡 回复选项编号（如 1），多选可用 1, 3，也可以直接打自己的话。";
  return base + "\n   跳过：发送 `/rq`（别名 `/reject-question`）关闭此卡。";
}

function buildMultiHint(items: ReadonlyArray<AskUserQuestionItem>): string {
  const lines: string[] = [
    "💡 回复格式：选选项用 Q{n}={值}，自定义用 Q{n}-{文字}（空格分隔，顺序不限）：",
  ];
  if (items.length === 2) {
    lines.push("   • 单选：Q1=1 Q2=2");
    lines.push("   • 多选：Q1=1, 3 Q2=2");
    lines.push("   • 自定义：Q2-这题我有自己想法（短横线表示自由文本）");
  } else {
    lines.push("   • 混答：Q1=1 Q2-这题我有自己想法 Q3=3");
    lines.push("   • 跳过某题（用默认）：不要写那个 Qn");
  }
  lines.push("   标记两侧空格可忽略：Q1 = 1、Q1 =1、Q1= 1 都可以。");
  lines.push("");
  lines.push("   全部跳过：发送 `/rq`（别名 `/reject-question`）。");
  lines.push("");
  lines.push("   简写（按顺序）：1 --- 2 --- 3");
  return lines.join("\n");
}

// ─── Internal: parse helpers ───

/** Matches the Qn-marker pattern anywhere in the string (for Step 0 detection). */
const QN_PATTERN = /\bQ\d+\s*[=\-]/;

/** Matches one Qn segment: "Q\d+\s*[=\-]\s*rest" — the rest is the answer content. */
const QN_SEGMENT_RE = /^Q(\d+)\s*([=\-])\s*(.*)$/;

/** Splits a segment into tokens. Treats digit-only tokens as numbers; anything else is text. */
const SEGMENT_TOKEN_RE = /[,;、\s]+/;

function parseQnFormat(input: string, items: ReadonlyArray<AskUserQuestionItem>): ParseResult {
  const answers: (string[] | null)[] = items.map(() => null);
  const warnings: string[] = [];

  const re = /Q(\d+)\s*([=\-])\s*([\s\S]*?)(?=Q\d+\s*[=\-]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const n = parseInt(match[1]!, 10);
    const marker = match[2] as "=" | "-";
    const rest = (match[3] ?? "").trim();

    if (n < 1 || n > items.length) {
      warnings.push(`Q${n} 超出范围（共 ${items.length} 题）`);
      continue;
    }

    const idx = n - 1;
    const q = items[idx]!;
    let parsed: string[];

    if (marker === "-") {
      // "-" marker: force custom (even pure digits stay as text)
      if (rest === "") {
        warnings.push(`Q${n} 短横线后没有内容，已用默认`);
        parsed = defaultAnswerFor(q);
      } else {
        parsed = capAnswer([rest]);
      }
    } else {
      // "=" marker: parse normally (numberList or customText)
      if (rest === "") {
        warnings.push(`Q${n} 内容为空，已用默认`);
        parsed = defaultAnswerFor(q);
      } else {
        parsed = parseSegment(rest, q);
      }
    }

    // Second occurrence overrides the first.
    answers[idx] = parsed;
  }

  const finalAnswers = answers.map((a, i) => a ?? defaultAnswerFor(items[i]!));
  const allAnswered = finalAnswers.every((a) => a.length > 0);
  return { answers: finalAnswers, allAnswered, warnings };
}

function parseDashFormat(input: string, items: ReadonlyArray<AskUserQuestionItem>): ParseResult {
  const segments = input
    .split(/\s*---\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const answers: (string[] | null)[] = items.map(() => null);
  const warnings: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (i < items.length) {
      const q = items[i]!;
      answers[i] = parseSegment(seg, q);
    } else {
      // Extra segment: merge into the last question's answer (append label).
      const lastIdx = items.length - 1;
      const lastQ = items[lastIdx]!;
      const lastAnswer = answers[lastIdx] ?? defaultAnswerFor(lastQ);
      const extra = parseSegment(seg, lastQ);
      for (const e of extra) {
        if (lastAnswer.length < 10) {
          lastAnswer.push(e);
        }
      }
      answers[lastIdx] = capAnswer(lastAnswer);
      warnings.push(`多出的一段「${truncate(seg, 30)}」已并入 Q${lastIdx + 1}`);
    }
  }

  const finalAnswers = answers.map((a, i) => a ?? defaultAnswerFor(items[i]!));
  const allAnswered = finalAnswers.every((a) => a.length > 0);
  return { answers: finalAnswers, allAnswered, warnings };
}

/**
 * Convert the parse-internal string[] answers into DSH answer items.
 * Callers pass the same items array they passed to `parseQuestionReply`.
 */
export function buildAnswer(parsed: ParseResult, items: ReadonlyArray<AskUserQuestionItem>): AskUserQuestionAnswer {
  const answerItems: AskUserQuestionAnswerItem[] = parsed.answers.map((answer, index) => {
    const item = items[index];
    if (!item) {
      return { id: `q${index + 1}`, selected: [...answer] };
    }
    const options = item.options ?? [];
    const selected: string[] = [];
    let custom: string | undefined;
    for (const element of answer) {
      if (options.some((o: { label: string; description?: string }) => o.label === element)) {
        selected.push(element);
      } else if (custom === undefined) {
        custom = element;
      }
    }
    return { id: item.id, selected, ...(custom !== undefined ? { custom } : {}) };
  });
  return { answers: answerItems };
}

/**
 * Parse one segment into an Answer (string[]).
 *
 * Rules:
 *   - If all whitespace-/comma-/semicolon-/顿号-separated tokens are pure
 *     digits, treat as numberList → resolve to option labels.
 *     - Out-of-range numbers are silently dropped.
 *   - Otherwise treat the whole segment (trimmed) as a single custom string.
 *   - Empty / all-out-of-range falls back to the question's default.
 */
function parseSegment(value: string, item: AskUserQuestionItem): string[] {
  const trimmed = value.trim();
  if (!trimmed) return defaultAnswerFor(item);

  const tokens = trimmed
    .split(SEGMENT_TOKEN_RE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return defaultAnswerFor(item);

  const options = item.options ?? [];
  if (options.length > 0 && tokens.every((t) => /^\d+$/.test(t))) {
    // All-digit tokens → numberList
    const labels: string[] = [];
    let anyInRange = false;
    for (const t of tokens) {
      const n = parseInt(t, 10);
      if (n < 1 || n > options.length) {
        // silent drop (out of range)
        continue;
      }
      anyInRange = true;
      const opt = options[n - 1]!;
      labels.push(opt.label);
    }
    if (!anyInRange) {
      // All numbers were out of range; fall back to custom so the user's
      // text isn't silently lost (e.g. "99" → ["99"], not []).
      return capAnswer([trimmed]);
    }
    return capAnswer(labels);
  }

  // Mixed or pure text → customText
  return capAnswer([trimmed]);
}

/** The default answer for a question = the first option's label. */
function defaultAnswerFor(q: AskUserQuestionItem): string[] {
  if ((q.options?.length ?? 0) === 0) return [];
  return [q.options![0]!.label];
}

/** Truncate each element to MAX_ANSWER_ELEMENT_LEN chars. Preserves array structure. */
function capAnswer(answer: string[]): string[] {
  return answer.map((a) => truncate(a, MAX_ANSWER_ELEMENT_LEN));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
