/**
 * Read listing facts from a session's raw JSONL log.
 *
 * Why this exists: the host's `sessionQuery.listEvents()` / `readTitle()`
 * both `inspect()` the complete validated log. `/s list` only needs a
 * handful of facts (runtime preset, last `user/message` time, latest
 * `session/title`) and must not scale with session count × log size.
 *
 * The persistence layer keeps each session as a multi-frame Zstandard
 * file at `$DSH_HOME/sessions/${projectKey(cwd)}/${encodeSegment(id)}/`.
 * Format v0 is `session.jsonl.zstd`; later generations are
 * `session.vN.jsonl.zstd` (DSH 0.1.5 writes v3). Host `open()` picks the
 * highest generation; this reader does the same.
 *
 * This module therefore:
 *   - caches folded facts against (path, size, mtime)
 *   - on append, only scans frames after the previously consumed byte
 *   - recovers recency by walking zstd frames newest-first and stopping
 *     at the first `user/message` (no full decompress)
 *   - skips JSON.parse on frames that cannot contain a relevant event
 *
 * The disk layout and projectKey encoding are documented in
 * `@deepseek-ai/dsh-session-persistence-jsonl` (`projectKey` /
 * `sessionDir` / `logPath`). We reimplement the encoder here so the
 * bridge has no runtime coupling to `@deepseek-ai/*`.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 little-endian

/** The Zstandard-compressed suffix DSH uses for session artifacts. */
const COMPRESSED_SUFFIX = ".jsonl.zstd";

/**
 * Canonical generation filenames (dsh-session-format):
 *   v0 → session.jsonl[.zstd]
 *   vN → session.vN.jsonl[.zstd]  (N ≥ 1, no leading zeros)
 * Temporary / uppercase / `.v0` names are not canonical.
 */
const GENERATION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u;

/** Bound the in-process cache so a long-lived bridge cannot grow without limit. */
const CACHE_LIMIT = 256;

/** Byte window for newest-first recency recovery of compressed logs. */
const RECENCY_CHUNK = 512 * 1024;

/**
 * GUI `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES` is 1024: a reusable blank
 * session is header-only. Anything larger is treated as used without
 * decompressing the log (`/s new` must not inspect every cwd session).
 */
const BLANK_LOG_MAX_BYTES = 1024;

/**
 * @typedef {{
 *   size: number,
 *   mtimeMs: number,
 *   scannedBytes: number,
 *   preset: string | undefined,
 *   headerPreset: string | undefined,
 *   title: string | undefined,
 *   lastUserMessageTime: number | undefined,
 *   recencyChecked: boolean,
 *   complete: boolean,
 * }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const cache = new Map();

/** Read `$DSH_HOME`, falling back to the platform default `~/.dsh`. */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv;
  return path.join(os.homedir(), ".dsh");
}

/**
 * Reproduce `@deepseek-ai/dsh-session-persistence-jsonl`'s `projectKey`
 * function — a workspace path becomes a safe directory name of the
 * form `--<slug>--`. Slashes/colons/dashes collapse; non-ASCII and
 * other unsafe chars become `~XXXX` hex-encoded; total capped at 255.
 */
function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("projectKey: cwd must be a non-empty string");
  }
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Reproduce `@deepseek-ai/dsh-session-persistence-jsonl`'s
 * `encodeSegment` for the per-session directory name. The host uses
 * `encodeURIComponent` with a few safe chars re-added; we mirror
 * that exact set so a path built here resolves to the same on-disk
 * directory as one written by DSH.
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment);
}

/**
 * Build the on-disk session log path for `(cwd, sessionId)`. Returns
 * a `.jsonl.zstd` path even if the artifact is currently plaintext —
 * we just read what exists at the compressed path or the plain path.
 */
function sessionLogPath(cwd, sessionId, root) {
  const base = root || resolveDshHome();
  const projectDir = path.join(base, "sessions", projectKey(cwd));
  return path.join(projectDir, encodeSegment(sessionId), `session${COMPRESSED_SUFFIX}`);
}

/**
 * Parse a canonical generation filename. Returns the format version
 * (0 for the untagged `session.jsonl`) or undefined when the name is
 * not a committed generation.
 */
function parseGenerationLogFilename(filename) {
  const match = GENERATION_LOG_NAME.exec(filename);
  if (!match) return undefined;
  if (match[1] === undefined) return 0;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}

/**
 * Locate the current session log. Mirrors host `open()`: scan the
 * session directory and pick the highest canonical generation. A
 * migrated 0.1.5 session is `session.v3.jsonl.zstd` with the older
 * `session.jsonl.zstd` left in place as an immutable predecessor —
 * reading the v0 file would miss later events.
 *
 * Returns undefined when the directory is missing or contains no
 * canonical generation. We do not synthesise or write — read-only.
 */
function locateSessionLog(cwd, sessionId, root) {
  const dir = path.dirname(sessionLogPath(cwd, sessionId, root));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let bestVersion = -1;
  let bestName;
  for (const name of names) {
    const version = parseGenerationLogFilename(name);
    if (version === undefined || version < bestVersion) continue;
    bestVersion = version;
    bestName = name;
  }
  return bestName === undefined ? undefined : path.join(dir, bestName);
}

/**
 * Parse Zstandard frame boundaries without decompressing the payload.
 * Faithful port of `@deepseek-ai/dsh-session-persistence-jsonl`'s
 * `scanZstdFrames` — we only need to know where each frame starts
 * and ends so we can decompress them one at a time. Returns
 * `{frames, tornStart?}` ranges in byte offsets within `buffer`.
 */
function scanZstdFrames(buffer, maxFrames) {
  const frames = [];
  const limit = maxFrames === undefined ? Number.POSITIVE_INFINITY : maxFrames;
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length >= limit) return { frames };
  }
  return { frames };
}

/**
 * Decompress one Zstandard frame synchronously. Throws if the buffer
 * does not begin with a valid frame; the caller is expected to have
 * obtained the [start, end] range from `scanZstdFrames`.
 */
function decompressZstdFrame(buffer, frame) {
  return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Mid-write line: skip. The file is append-only and the host
      // guarantees only full lines are visible to readers, but a
      // race with a concurrent write could leave a truncated last
      // line — dropping it is the safe choice.
    }
  }
  return out;
}

function userMessageTime(ev) {
  if (!ev || typeof ev !== "object" || ev.type !== "user/message") return undefined;
  if (typeof ev.time !== "number") return undefined;
  const source = ev.data && typeof ev.data === "object" ? ev.data.source : undefined;
  // Missing source is treated as a user prompt — older logs and the
  // recency-recovery path in `inspectSessionActivity` both walk every
  // `user/message`. An explicit non-user source (plugin / skill / goal)
  // is skipped so a synthetic context injection cannot steal recency.
  if (source && typeof source === "object" && source.kind && source.kind !== "user") {
    return undefined;
  }
  return ev.time;
}

function eventTitle(ev) {
  if (!ev || typeof ev !== "object" || ev.type !== "session/title") return undefined;
  const data = ev.data;
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.title === "string" && data.title.length > 0) return data.title;
  return undefined;
}

/**
 * Fold listing facts out of one JSONL chunk.
 * `into.lastSelected` / `into.title` / `into.lastUserMessageTime` are
 * updated in log order (newest wins). `into.headerPreset` is captured
 * once from the session header.
 */
function extractFromText(text, into) {
  const hasSelected = text.includes("agent-preset/selected");
  const hasTitle = text.includes("session/title");
  const hasUser = text.includes("user/message");
  const needHeader = into.headerPreset === undefined && text.includes('"type":"session"');
  if (!hasSelected && !hasTitle && !hasUser && !needHeader) return;
  for (const ev of parseJsonl(text)) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "agent-preset/selected") {
      const data = ev.data;
      if (data && typeof data.agentPreset === "string" && data.agentPreset.length > 0) {
        into.lastSelected = data.agentPreset;
      }
    } else if (
      into.headerPreset === undefined &&
      ev.type === "session" &&
      typeof ev.agentPreset === "string" &&
      ev.agentPreset.length > 0
    ) {
      into.headerPreset = ev.agentPreset;
    }
    const title = eventTitle(ev);
    if (title !== undefined) into.title = title;
    const t = userMessageTime(ev);
    if (t !== undefined) into.lastUserMessageTime = t;
  }
}

function emptyFacts() {
  return {
    lastSelected: undefined,
    headerPreset: undefined,
    title: undefined,
    lastUserMessageTime: undefined,
  };
}

function scanLogBuffer(buffer, compressed, into) {
  if (!compressed) {
    extractFromText(buffer.toString("utf8"), into);
    return { scannedBytes: buffer.length };
  }
  const { frames, tornStart } = scanZstdFrames(buffer);
  for (const frame of frames) {
    let text = "";
    try {
      text = decompressZstdFrame(buffer, frame).toString("utf8");
    } catch {
      continue;
    }
    extractFromText(text, into);
  }
  if (typeof tornStart === "number") return { scannedBytes: tornStart };
  return { scannedBytes: buffer.length };
}

function mergeFacts(base, extra) {
  return {
    lastSelected: extra.lastSelected !== undefined ? extra.lastSelected : base.lastSelected,
    headerPreset: extra.headerPreset !== undefined ? extra.headerPreset : base.headerPreset,
    title: extra.title !== undefined ? extra.title : base.title,
    lastUserMessageTime: extra.lastUserMessageTime !== undefined
      ? extra.lastUserMessageTime
      : base.lastUserMessageTime,
  };
}

function factsFromCache(hit) {
  return {
    // Seed the already-resolved preset so a tail without a new
    // `agent-preset/selected` keeps the cached value (newest still wins
    // when the tail does contain one).
    lastSelected: hit.preset,
    headerPreset: hit.headerPreset,
    title: hit.title,
    lastUserMessageTime: hit.lastUserMessageTime,
  };
}

function entryFromFacts(st, scannedBytes, facts, flags) {
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    scannedBytes,
    headerPreset: facts.headerPreset,
    preset: facts.lastSelected ?? facts.headerPreset,
    title: facts.title,
    lastUserMessageTime: facts.lastUserMessageTime,
    recencyChecked: flags.recencyChecked === true,
    complete: flags.complete === true,
  };
}

function remember(file, entry) {
  if (cache.has(file)) cache.delete(file);
  cache.set(file, entry);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function clearSessionLogCache() {
  cache.clear();
}

/**
 * Read every event line from a session log. Returns parsed JSON
 * objects in log order. Header line (`type: "session"`) is included
 * as the first element — caller can ignore it. Not used by the
 * preset hot path (that path never materialises the full event list).
 */
function readSessionEvents(cwd, sessionId, root) {
  const file = locateSessionLog(cwd, sessionId, root);
  if (!file) return [];
  const buffer = fs.readFileSync(file);
  if (!file.endsWith(COMPRESSED_SUFFIX)) {
    return parseJsonl(buffer.toString("utf8"));
  }
  const { frames } = scanZstdFrames(buffer);
  const events = [];
  for (const frame of frames) {
    let text = "";
    try {
      text = decompressZstdFrame(buffer, frame).toString("utf8");
    } catch {
      continue;
    }
    for (const ev of parseJsonl(text)) events.push(ev);
  }
  return events;
}

function readRange(file, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return n === length ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, start, size) {
  return readRange(file, start, size - start);
}

function lastUserMessageTimeInText(text) {
  if (!text.includes("user/message")) return undefined;
  const events = parseJsonl(text);
  for (let i = events.length - 1; i >= 0; i--) {
    const t = userMessageTime(events[i]);
    if (t !== undefined) return t;
  }
  return undefined;
}

function lastUserMessageTimeInFrames(buffer, frames) {
  for (let i = frames.length - 1; i >= 0; i--) {
    let text = "";
    try {
      text = decompressZstdFrame(buffer, frames[i]).toString("utf8");
    } catch {
      continue;
    }
    const t = lastUserMessageTimeInText(text);
    if (t !== undefined) return t;
  }
  return undefined;
}

/**
 * Walk a compressed log newest-frame-first until a user prompt is found.
 * A tail window rarely starts on a frame boundary, so we locate Zstandard
 * magics inside the window instead of requiring the first byte to be one.
 */
function recencyFromCompressedTail(file, size) {
  const start = Math.max(0, size - RECENCY_CHUNK);
  const chunk = readRange(file, start, size - start);
  if (chunk.length < 4) return { time: undefined, recencyChecked: start === 0 };
  // A tail window usually starts mid-frame. The first valid magic is
  // the oldest complete frame in this window; one scan then covers
  // every newer frame through the torn tail. Finding a user prompt
  // here is the last prompt in the file (logs are append-only).
  for (let offset = 0; offset <= chunk.length - 4; offset++) {
    if (chunk.readUInt32LE(offset) !== ZSTD_MAGIC) continue;
    let frames;
    try {
      ({ frames } = scanZstdFrames(chunk.subarray(offset)));
    } catch {
      continue;
    }
    if (frames.length === 0) continue;
    const time = lastUserMessageTimeInFrames(chunk.subarray(offset), frames);
    if (time !== undefined) return { time, recencyChecked: true };
    return { time: undefined, recencyChecked: start === 0 };
  }
  return { time: undefined, recencyChecked: start === 0 };
}

function recencyFromPlainTail(file, size) {
  const window = Math.min(size, RECENCY_CHUNK);
  const chunk = readRange(file, size - window, window);
  const time = lastUserMessageTimeInText(chunk.toString("utf8"));
  if (time !== undefined) return { time, recencyChecked: true };
  // A short file is complete; a truncated first line of a large file
  // is not a proof of "no user message".
  return { time: undefined, recencyChecked: size <= RECENCY_CHUNK };
}

function emptyListFacts() {
  return { preset: undefined, title: undefined, lastUserMessageTime: undefined };
}

function listFactsFromEntry(entry) {
  if (!entry) return emptyListFacts();
  return {
    preset: entry.preset,
    title: entry.title,
    lastUserMessageTime: entry.lastUserMessageTime,
  };
}

function locateStat(cwd, sessionId, root) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  const file = locateSessionLog(cwd, sessionId, root);
  if (!file) return undefined;
  try {
    return { file, st: fs.statSync(file), compressed: file.endsWith(COMPRESSED_SUFFIX) };
  } catch {
    return undefined;
  }
}

function rememberRecency(file, st, hit, recency) {
  const base = hit && hit.size <= st.size ? hit : undefined;
  const entry = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    scannedBytes: base && base.complete ? base.scannedBytes : 0,
    headerPreset: base?.headerPreset,
    preset: base?.preset,
    title: base?.title,
    lastUserMessageTime: recency.time !== undefined ? recency.time : base?.lastUserMessageTime,
    recencyChecked: recency.recencyChecked === true,
    complete: base && base.complete && base.size === st.size,
  };
  remember(file, entry);
  return entry;
}

function recencyOfFile(file, st, compressed) {
  return compressed
    ? recencyFromCompressedTail(file, st.size)
    : recencyFromPlainTail(file, st.size);
}

/**
 * Cheap used/blank hint for `/s new`.
 * - `used`: has a user prompt, or the artifact is larger than a blank header
 * - `blank`: small artifact, fully readable, no `user/message`
 * - `unknown`: missing file or unreadable small artifact (caller may inspect)
 *
 * @returns {{ status: "used", time?: number } | { status: "blank" } | { status: "unknown" }}
 */
function readSessionUsedHint(cwd, sessionId, root) {
  const located = locateStat(cwd, sessionId, root);
  if (!located) return { status: "unknown" };
  const { file, st, compressed } = located;
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    if (hit.lastUserMessageTime !== undefined) return { status: "used", time: hit.lastUserMessageTime };
    if (hit.recencyChecked && (hit.complete || st.size <= BLANK_LOG_MAX_BYTES)) {
      return { status: "blank" };
    }
  }
  if (st.size > BLANK_LOG_MAX_BYTES) return { status: "used" };
  try {
    const recency = recencyOfFile(file, st, compressed);
    rememberRecency(file, st, hit, recency);
    if (recency.time !== undefined) return { status: "used", time: recency.time };
    if (recency.recencyChecked) return { status: "blank" };
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Last `user/message` time, recovered newest-first. Does not decompress
 * the whole log — `/s list` uses this to sort every session before it
 * spends a full scan on the 20 rows it will actually render.
 */
function readSessionRecency(cwd, sessionId, root) {
  const located = locateStat(cwd, sessionId, root);
  if (!located) return undefined;
  const { file, st, compressed } = located;
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.recencyChecked) {
    remember(file, hit);
    return hit.lastUserMessageTime;
  }
  try {
    if (hit && hit.complete && st.size > hit.size && hit.scannedBytes <= hit.size) {
      const tail = readTail(file, hit.scannedBytes, st.size);
      const aligned = !(compressed && tail.length >= 4 && tail.readUInt32LE(0) !== ZSTD_MAGIC);
      if (tail.length > 0 && aligned) {
        const into = factsFromCache(hit);
        const { scannedBytes: tailScanned } = scanLogBuffer(tail, compressed, into);
        const facts = mergeFacts(factsFromCache(hit), into);
        const recencyChecked = facts.lastUserMessageTime !== undefined || hit.recencyChecked;
        const entry = entryFromFacts(st, hit.scannedBytes + tailScanned, facts, {
          recencyChecked,
          complete: true,
        });
        remember(file, entry);
        return entry.lastUserMessageTime;
      }
    }
    const recency = recencyOfFile(file, st, compressed);
    const entry = rememberRecency(file, st, hit, recency);
    return entry.lastUserMessageTime;
  } catch {
    return undefined;
  }
}

/**
 * Fold listing facts (runtime preset, last user-prompt time, latest
 * title) from the raw log. Used for the displayed `/s list` rows after
 * recency has already picked the top 20.
 */
function readSessionListFacts(cwd, sessionId, root) {
  const located = locateStat(cwd, sessionId, root);
  if (!located) return emptyListFacts();
  const { file, st, compressed } = located;
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.complete) {
    remember(file, hit);
    return listFactsFromEntry(hit);
  }
  try {
    if (hit && hit.complete && st.size > hit.size && hit.scannedBytes <= hit.size) {
      const tail = readTail(file, hit.scannedBytes, st.size);
      const aligned = !(compressed && tail.length >= 4 && tail.readUInt32LE(0) !== ZSTD_MAGIC);
      if (tail.length > 0 && aligned) {
        const into = factsFromCache(hit);
        const { scannedBytes: tailScanned } = scanLogBuffer(tail, compressed, into);
        const facts = mergeFacts(factsFromCache(hit), into);
        const recencyChecked = facts.lastUserMessageTime !== undefined || hit.recencyChecked;
        const entry = entryFromFacts(st, hit.scannedBytes + tailScanned, facts, {
          recencyChecked,
          complete: true,
        });
        remember(file, entry);
        return listFactsFromEntry(entry);
      }
    }
    const buffer = fs.readFileSync(file);
    const into = emptyFacts();
    const { scannedBytes } = scanLogBuffer(buffer, compressed, into);
    if (into.lastUserMessageTime === undefined && hit && hit.recencyChecked) {
      into.lastUserMessageTime = hit.lastUserMessageTime;
    }
    const entry = entryFromFacts(st, scannedBytes, into, {
      recencyChecked: into.lastUserMessageTime !== undefined || hit?.recencyChecked === true,
      complete: true,
    });
    remember(file, entry);
    return listFactsFromEntry(entry);
  } catch {
    return emptyListFacts();
  }
}

/**
 * The preset a session actually runs under, walking the raw event
 * log for `agent-preset/selected` (newest wins, header fallback).
 * Mirrors `@deepseek-ai/dsh-agent-presets.resolveSessionPreset`.
 */
function readSessionRuntimePreset(cwd, sessionId, root) {
  return readSessionListFacts(cwd, sessionId, root).preset;
}

module.exports = {
  COMPRESSED_SUFFIX,
  clearSessionLogCache,
  locateSessionLog,
  parseGenerationLogFilename,
  projectKey,
  readSessionEvents,
  readSessionListFacts,
  readSessionRecency,
  readSessionRuntimePreset,
  readSessionUsedHint,
  resolveDshHome,
  scanZstdFrames,
  sessionLogPath,
};
