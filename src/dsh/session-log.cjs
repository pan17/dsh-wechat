/**
 * Read the runtime preset of a session by walking its raw JSONL log.
 *
 * Why this exists: the host's `sessionQuery.listEvents()` returns
 * lightweight records (`{sessionId, seq, type, time, surface}`) — NO
 * `data` field — because it's a recency-recovery API. The bridge needs
 * the payload of `agent-preset/selected` events (`data.agentPreset`)
 * to honour the host's `resolveSessionPreset` semantics: a session
 * switched after creation reads as the switched preset, not the
 * frozen header value.
 *
 * The persistence layer keeps each session as a multi-frame Zstandard
 * generation file at `$DSH_HOME/sessions/${projectKey(cwd)}/${encodeSegment(id)}/session.vN.jsonl.zstd`;
 * v0 uses the original `session.jsonl.zstd` spelling and migrated generations
 * may coexist in the same directory.
 *
 * Cost: a long session can be thousands of independent zstd frames
 * (one per write batch). Decompressing every frame on every `/s list`
 * row would scale with session count × log size. This module therefore:
 *   - caches the resolved preset against (path, size, mtime)
 *   - on append, only scans frames after the previously consumed byte
 *     (newest `agent-preset/selected` in the tail wins; otherwise the
 *     cached value still holds — logs are append-only)
 *   - skips JSON.parse on frames that cannot contain a header or a
 *     preset-selected event
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
 * DSH 0.1.3 stores immutable Session format generations as
 * `session.vN.jsonl[.zstd]`; v0 kept the original `session.jsonl[.zstd]`
 * spelling. Keep the parser deliberately structural so future generations
 * remain discoverable without coupling this bridge to a runtime package.
 */
const GENERATION_FILENAME_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** Bound the in-process cache so a long-lived bridge cannot grow without limit. */
const CACHE_LIMIT = 256;

/**
 * @typedef {{
 *   size: number,
 *   mtimeMs: number,
 *   scannedBytes: number,
 *   preset: string | undefined,
 *   headerPreset: string | undefined,
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
 * Reproduce the current DSH `encodeSegment` for the per-session directory
 * name. DSH 0.1.3 stopped using URI escaping: every unsafe UTF-16 code unit
 * is written as `~XXXX`, while `.` and `..` are escaped to prevent traversal.
 */
function encodeSegment(segment) {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new Error("cannot encode an empty path segment");
  }
  if (segment === "." || segment === "..") {
    return segment === "." ? "~002E" : "~002E~002E";
  }
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out;
}

/** The pre-v0.1.3 directory encoding, retained for old session artifacts. */
function legacyEncodeSegment(segment) {
  return encodeURIComponent(segment);
}

/**
 * Build the legacy on-disk session log path for `(cwd, sessionId)`. The
 * exported helper remains a compatibility hint; `locateSessionLog` scans all
 * known generation names and both old/new directory encodings.
 */
function sessionLogPath(cwd, sessionId, root) {
  return path.join(
    sessionDirectoryPath(cwd, sessionId, root, legacyEncodeSegment),
    `session${COMPRESSED_SUFFIX}`,
  );
}

function sessionDirectoryPath(cwd, sessionId, root, encoder) {
  const base = root || resolveDshHome();
  return path.join(base, "sessions", projectKey(cwd), encoder(sessionId));
}

/**
 * Parse one canonical DSH JSONL generation filename. Version zero uses the
 * original suffix-only name; v1+ carries `.vN` before `.jsonl`.
 */
function parseGenerationFilename(filename) {
  const match = GENERATION_FILENAME_RE.exec(filename);
  if (!match) return undefined;
  const version = match[1] === undefined ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(version)) return undefined;
  return { version, compressed: match[2] === ".zstd" };
}

/**
 * Locate the newest session generation. DSH 0.1.3 writes `session.v2.jsonl`
 * or `session.v2.jsonl.zstd`, while migrated v0/v1 files may remain beside
 * it. Prefer the highest generation and compressed storage on a same-version
 * tie, matching the historical compressed-first behavior.
 */
function locateSessionLog(cwd, sessionId, root) {
  const candidates = [];
  const dirs = [
    sessionDirectoryPath(cwd, sessionId, root, encodeSegment),
    sessionDirectoryPath(cwd, sessionId, root, legacyEncodeSegment),
  ];
  const seenDirs = new Set();
  for (const dir of dirs) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const generation = parseGenerationFilename(entry.name);
      if (!generation) continue;
      candidates.push({ path: path.join(dir, entry.name), ...generation });
    }
  }
  candidates.sort((left, right) =>
    right.version - left.version || Number(right.compressed) - Number(left.compressed));
  return candidates[0]?.path;
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

/**
 * Fold header / selected-preset facts out of one JSONL chunk.
 * `into.lastSelected` is updated in log order (newest wins).
 * `into.headerPreset` is captured once from the session header.
 */
function extractFromText(text, into) {
  const hasSelected = text.includes("agent-preset/selected");
  const needHeader = into.headerPreset === undefined && text.includes('"type":"session"');
  if (!hasSelected && !needHeader) return;
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
  }
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

function readTail(file, start, size) {
  const length = size - start;
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, "r");
  try {
    const tail = Buffer.alloc(length);
    const n = fs.readSync(fd, tail, 0, length, start);
    return n === length ? tail : tail.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The preset a session actually runs under, walking the raw event
 * log for `agent-preset/selected` (newest wins, header fallback).
 * Mirrors `@deepseek-ai/dsh-agent-presets.resolveSessionPreset`.
 *
 * @param cwd - the session's recorded working directory.
 * @param sessionId - the durable session id.
 * @param root - optional `$DSH_HOME` override (defaults to env or `~/.dsh`).
 * @returns the preset id, or undefined when the log has no record.
 */
function readSessionRuntimePreset(cwd, sessionId, root) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  const file = locateSessionLog(cwd, sessionId, root);
  if (!file) return undefined;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    remember(file, hit);
    return hit.preset;
  }
  const compressed = file.endsWith(COMPRESSED_SUFFIX);
  try {
    if (hit && st.size > hit.size && hit.scannedBytes <= hit.size) {
      const tail = readTail(file, hit.scannedBytes, st.size);
      if (tail.length > 0 && !(compressed && tail.length >= 4 && tail.readUInt32LE(0) !== ZSTD_MAGIC)) {
        const into = { lastSelected: undefined, headerPreset: hit.headerPreset };
        const { scannedBytes: tailScanned } = scanLogBuffer(tail, compressed, into);
        const entry = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          scannedBytes: hit.scannedBytes + tailScanned,
          headerPreset: into.headerPreset,
          preset: into.lastSelected ?? hit.preset,
        };
        remember(file, entry);
        return entry.preset;
      }
    }
    const buffer = fs.readFileSync(file);
    const into = { lastSelected: undefined, headerPreset: undefined };
    const { scannedBytes } = scanLogBuffer(buffer, compressed, into);
    const entry = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      scannedBytes,
      headerPreset: into.headerPreset,
      preset: into.lastSelected ?? into.headerPreset,
    };
    remember(file, entry);
    return entry.preset;
  } catch {
    return undefined;
  }
}

module.exports = {
  COMPRESSED_SUFFIX,
  clearSessionLogCache,
  locateSessionLog,
  projectKey,
  readSessionEvents,
  readSessionRuntimePreset,
  resolveDshHome,
  scanZstdFrames,
  sessionLogPath,
};
