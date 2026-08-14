/**
 * Approval card formatting and reply parsing for the WeChat mirror card.
 *
 * The card mirrors the DSH GUI approval card exactly (tool name, reason,
 * allow-once / reject) because it renders the same `approval/requested`
 * frame; the decision is injected back through `apiProxy.respond()` into
 * the native pending table. Reply grammar:
 *   `1` / `2`          → positional (once / reject) for a single card
 *   `once` / `reject`  → keyword forms (case-insensitive)
 *   `P1=1 P2=2`        → per-card decisions when several are pending
 *   `P2-reject`        → dash forces reject for that card
 */

export type ApprovalReplyValue = "once" | "reject";

export interface ApprovalDecision {
  /** The card's rpcId (respond echo). */
  rpcId: string;
  reply: ApprovalReplyValue;
}

export interface PendingApprovalCard {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  reason?: string;
  askedAt: number;
}

/** Max length of a freeform rejection message. */
const MAX_MESSAGE_LEN = 500;
/** Soft cap on the full card size; headroom under WeChat's 2000-char limit. */
const MAX_CARD_LEN = 1800;

/** Render one approval frame as a WeChat-friendly card (GUI-equivalent info). */
export function formatApprovalCard(entry: PendingApprovalCard, index?: number, total?: number): string {
  const lines: string[] = [];
  const header =
    index !== undefined && total !== undefined && total > 1
      ? `🔒 Permission ${index}/${total}`
      : "🔒 Permission requested";
  lines.push(header);
  lines.push("");

  lines.push(`Tool: ${entry.toolName}`);
  lines.push("");

  if (entry.reason) {
    lines.push("Details:");
    lines.push(`  ${entry.reason}`);
    lines.push("");
  }

  lines.push("Choose one reply:");
  lines.push("  1. once   — allow this call only");
  lines.push("  2. reject — deny this call");
  lines.push("");

  if (index !== undefined && total !== undefined && total > 1) {
    lines.push(`💡 ${total} permissions pending. Send:`);
    lines.push(`  • 1 | 2        — apply to ALL ${total} permissions`);
    lines.push(`  • P${index}=1 P${nextIndex(index)}=2 …  — set per-permission`);
  } else {
    lines.push("Reply with: 1 | 2");
  }
  lines.push("");
  lines.push("（30 分钟未回复自动移除此卡；可在 DSH 界面继续处理）");

  let card = lines.join("\n");
  if (card.length > MAX_CARD_LEN) {
    card = card.slice(0, MAX_CARD_LEN - 1) + "…";
  }
  return card;
}

/** 1-based next index for the Pn=… grammar hint, wrapping at 9. */
function nextIndex(i: number): number {
  return i >= 9 ? 1 : i + 1;
}

/**
 * Parse the user's reply into per-card decisions.
 */
export function parseApprovalReply(
  input: string,
  pending: ReadonlyArray<PendingApprovalCard>,
): { decisions: ApprovalDecision[]; warnings: string[] } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { decisions: [], warnings: ["empty input"] };
  }
  if (pending.length === 0) {
    return { decisions: [], warnings: ["no pending approvals"] };
  }

  const decisions: ApprovalDecision[] = [];
  const warnings: string[] = [];

  // Step 1: per-card P{n}= / P{n}- segments.
  const PN_SEGMENT_RE = /P(\d+)\s*([=\-])\s*([\s\S]*?)(?=P\d+\s*[=\-]|$)/gi;
  let pnMatch: RegExpExecArray | null;
  const matchedIndices = new Set<number>();

  while ((pnMatch = PN_SEGMENT_RE.exec(trimmed)) !== null) {
    const n = parseInt(pnMatch[1]!, 10);
    const marker = pnMatch[2] as "=" | "-";
    const rest = (pnMatch[3] ?? "").trim();

    if (n < 1 || n > pending.length) {
      warnings.push(`P${n} out of range (have ${pending.length} card(s))`);
      continue;
    }
    const idx = n - 1;
    const target = pending[idx]!;
    matchedIndices.add(idx);

    if (marker === "-") {
      // Dash forces reject (message allowed as trailing text).
      if (!rest) {
        warnings.push(`P${n} dash with empty content; skipping`);
        continue;
      }
      upsertDecision(decisions, { rpcId: target.rpcId, reply: "reject" });
      continue;
    }

    // "=" marker: parse the value.
    if (rest === "") {
      warnings.push(`P${n} empty content; skipping`);
      continue;
    }
    if (/[,;、]/.test(rest)) {
      warnings.push(`P${n} multi-select not supported; reply with a single 1/2 or P1=once|reject`);
      continue;
    }
    const parsed = parseValue(rest);
    if (!parsed) {
      warnings.push(`P${n} unrecognized value "${truncate(rest, 40)}"`);
      continue;
    }
    upsertDecision(decisions, { rpcId: target.rpcId, reply: parsed });
  }

  // Step 2: fall back to positional/keyword against all pending cards.
  if (decisions.length === 0 && matchedIndices.size === 0) {
    if (/[,;、]/.test(trimmed)) {
      warnings.push("multi-select not supported; reply with a single 1/2 or P1=once|reject");
    } else {
      const positional = parseValue(trimmed);
      if (positional) {
        if (pending.length > 1) {
          warnings.push(`single decision applies to all ${pending.length} pending cards`);
        }
        for (const target of pending) {
          upsertDecision(decisions, { rpcId: target.rpcId, reply: positional });
        }
      } else {
        warnings.push(`unrecognized reply "${truncate(trimmed, 50)}"; expected 1|2 or once|reject`);
      }
    }
  }

  return { decisions, warnings };
}

function upsertDecision(decisions: ApprovalDecision[], decision: ApprovalDecision): void {
  const existing = decisions.findIndex((d) => d.rpcId === decision.rpcId);
  if (existing >= 0) {
    decisions[existing] = decision;
  } else {
    decisions.push(decision);
  }
}

/** `1`/`once` → once; `2`/`reject` → reject. */
function parseValue(value: string): ApprovalReplyValue | null {
  const lower = value.trim().toLowerCase();
  if (lower === "1" || lower === "once" || lower.startsWith("once ")) return "once";
  if (lower === "2" || lower === "reject" || lower.startsWith("reject ")) return "reject";
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/** Keep MAX_MESSAGE_LEN exported for parity with the reference grammar. */
export { MAX_MESSAGE_LEN };
