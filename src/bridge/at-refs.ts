/**
 * `@`-mention rendering for the `/at` command.
 *
 * The GUI composer inserts two kinds of reference, and both are ultimately
 * ORDINARY PROMPT TEXT — no host API accepts a "reference object":
 *
 *   - a session: `@[label](dsh-session:<base64url(JSON.stringify(id))>)`,
 *     which `@deepseek-ai/dsh-session-reference` rewrites to `@label` and
 *     follows with an untrusted `## Referenced sessions` snapshot;
 *   - a file: `@path`, or `@"path with spaces"`, which
 *     `@deepseek-ai/dsh-file-reference-local` describes in its prompt
 *     section (`FILE_REFERENCE_PROMPT`) so the model calls `read` instead of
 *     pretending it inspected the file.
 *
 * WeChat has no caret, so `/at` stages these tokens and the bridge prepends
 * them to the next message. This module is the whole spelling layer: pure,
 * dependency-free, and byte-compatible with the host's own grammar (verified
 * against `dsh-session-reference/lib/types/uri.js` and
 * `dsh-file-reference/lib/types/grammar.js` at DSH 0.2.1-rc.2).
 *
 * Deliberate difference from the host grammar: `formatFileMention` there
 * returns an UNCLOSED `@"dir/` for a directory while completion descends
 * another level. `/at` emits finished prompt text, so a quoted directory is
 * closed (`@"my dir/"`) — the open quote exists only to keep a completion
 * menu alive, which WeChat does not have.
 */

/** URI scheme reserved by the host for session snapshots. */
export const SESSION_REFERENCE_SCHEME = "dsh-session:";

/**
 * Encode a session id as the host's canonical mention URI.
 *
 * `base64url(JSON.stringify(id))` — JSON so ANY JavaScript string id round-
 * trips exactly (including ids with quotes or backslashes), base64url so the
 * result is a single Markdown-link-safe token.
 */
export function encodeSessionReferenceUri(sessionId: string): string {
  return `${SESSION_REFERENCE_SCHEME}${Buffer.from(JSON.stringify(sessionId), "utf8").toString("base64url")}`;
}

/** Escape the two characters a `@[label]` label cannot contain literally. */
export function escapeMentionLabel(label: string): string {
  return label.replace(/[\\\]]/gu, (match) => `\\${match}`);
}

/**
 * Render one session mention.
 *
 * The label is display-only (the host decodes identity from the URI), so a
 * newline or a run of spaces would only break the single-line prompt block:
 * the caller passes an already-cleaned title, and this function still folds
 * whitespace defensively.
 */
export function formatSessionMention(label: string, sessionId: string): string {
  const clean = label.replace(/\s+/gu, " ").trim();
  return `@[${escapeMentionLabel(clean)}](${encodeSessionReferenceUri(sessionId)})`;
}

/** One file-reference candidate, as `ctx.fileReferences.list` reports it. */
export interface FileMentionCandidate {
  /** Workspace-relative (`src/x.ts`) or absolute path. */
  path: string;
  kind: "file" | "directory";
}

/**
 * Render one file mention, or `undefined` when the path cannot be expressed.
 *
 * A path containing a control character or a double quote has no safe
 * spelling in the `@"…"` grammar (the quote would terminate the token early
 * and the remainder would silently become prose), so it is refused here
 * rather than sent as a mention the model would misread.
 */
export function formatFileMention(candidate: FileMentionCandidate): string | undefined {
  const raw = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
  if (raw.length === 0) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(raw)) return undefined;
  if (!/\s/u.test(raw)) return `@${raw}`;
  return `@"${raw}"`;
}

/** One staged reference, ready to render. */
export interface StagedReference {
  kind: "session" | "file";
  /** The exact prompt token. */
  mention: string;
}

/**
 * Render the staged references as one prompt block, or `undefined` when
 * nothing is staged.
 *
 * Sessions come first and files second, regardless of staging order: the host
 * rewrites each session mention in place and follows the message with a long
 * `## Referenced sessions` snapshot, so grouping them keeps the short path
 * tokens together instead of interleaving them with base64 URIs.
 *
 * The caller APPENDS this block after the user's own text rather than
 * prepending it: the host derives a session title from the leading text of the
 * first human message, and a leading `@[标题](dsh-session:…)` would title a new
 * session with a base64 payload. Mention parsing itself is position-independent.
 */
export function buildMentionBlock(staged: readonly StagedReference[]): string | undefined {
  const sessions = staged.filter((s) => s.kind === "session").map((s) => s.mention);
  const files = staged.filter((s) => s.kind === "file").map((s) => s.mention);
  const tokens = [...sessions, ...files];
  if (tokens.length === 0) return undefined;
  return tokens.join(" ");
}

/**
 * Invisible formatting marks that survive `String.prototype.trim()`.
 *
 * Copying a path out of Explorer, a browser address bar, or a PDF frequently
 * carries a bidirectional control — most often U+202A LEFT-TO-RIGHT EMBEDDING —
 * or a zero-width space at one end. None of these is Unicode whitespace, so
 * `trim()` keeps them, and ONE leading U+202A is enough to make
 * `path.isAbsolute()` return false: a pasted `C:\Users\me\a.txt` then resolves
 * RELATIVE to the working directory and `/at f` answers "找不到" for a path
 * that plainly exists.
 *
 * Only the EDGES are stripped. An interior mark is part of a real filename (a
 * legitimate right-to-left name contains them), and deleting it there would
 * silently point the reference at a different file than the one named.
 */

/** The marks themselves, for detection anywhere in a string. */
const EDGE_INVISIBLE_MARKS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/** Edge-anchored, and folded together with whitespace so one pass trims both. */
const EDGE_INVISIBLE = /^[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+|[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+$/gu;

/** Remove edge whitespace and invisible formatting marks. */
function stripEdgeMarks(value: string): string {
  return value.replace(EDGE_INVISIBLE, "");
}

/**
 * Whether the text contains an invisible formatting mark anywhere.
 *
 * Exists so a refusal can name the cause: a path that looks correct in WeChat
 * but fails to resolve usually carries one of these, and the user cannot see it.
 */
export function hasInvisibleMarks(raw: string): boolean {
  return raw.replace(EDGE_INVISIBLE_MARKS, "") !== raw;
}

/**
 * Quote pairs accepted around a `/at f` target.
 *
 * The curly pair is not cosmetic: a Chinese IME auto-corrects `"` to `“`/`”`,
 * so `/at f “a b.txt”` is what a user actually types on such a layout, and
 * accepting only the ASCII pair would refuse a correctly-spelled path.
 */
const TARGET_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["\u201c", "\u201d"],
];

/**
 * Strip one pair of surrounding quotes from a `/at f "…"` target, plus any
 * edge whitespace and invisible formatting marks (see {@link EDGE_INVISIBLE}).
 *
 * Only an exact open/close PAIR is stripped: a lone leading quote is a typo the
 * caller should see refused, not silently repaired into a different path.
 */
export function normalizeAtTarget(raw: string): string {
  const trimmed = stripEdgeMarks(raw);
  for (const [open, close] of TARGET_QUOTES) {
    if (trimmed.length > open.length + close.length - 1
      && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return stripEdgeMarks(trimmed.slice(open.length, trimmed.length - close.length));
    }
  }
  return trimmed;
}
