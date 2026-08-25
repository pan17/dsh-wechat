/**
 * session-log.cjs: live-preset reads must not decompress a whole
 * multi-frame zstd log on every `/s list` row. Cache keyed by
 * (path, size, mtime); appends scan only the new tail.
 */

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const log = require("../src/dsh/session-log.cjs") as {
  clearSessionLogCache: () => void;
  projectKey: (cwd: string) => string;
  readSessionRuntimePreset: (cwd: string, sessionId: string, root?: string) => string | undefined;
};

function writeLog(opts: {
  dshHome: string;
  cwd: string;
  sessionId: string;
  headerAgentPreset?: string;
  events?: Array<{ type: string; data?: unknown }>;
}) {
  const { dshHome, cwd, sessionId, headerAgentPreset, events = [] } = opts;
  const dir = path.join(dshHome, "sessions", log.projectKey(cwd), encodeURIComponent(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    type: "session",
    version: 0,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    ...(headerAgentPreset ? { agentPreset: headerAgentPreset } : {}),
  });
  const frames = [zlib.zstdCompressSync(Buffer.from(header + "\n"))];
  for (const ev of events) {
    frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(ev) + "\n")));
  }
  fs.writeFileSync(path.join(dir, "session.jsonl.zstd"), Buffer.concat(frames));
}

function appendFrame(opts: {
  dshHome: string;
  cwd: string;
  sessionId: string;
  event: { type: string; data?: unknown };
}) {
  const file = path.join(
    opts.dshHome,
    "sessions",
    log.projectKey(opts.cwd),
    encodeURIComponent(opts.sessionId),
    "session.jsonl.zstd",
  );
  const extra = zlib.zstdCompressSync(Buffer.from(JSON.stringify(opts.event) + "\n"));
  fs.appendFileSync(file, extra);
}

describe("session-log runtime preset cache", () => {
  let dshHome: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    log.clearSessionLogCache();
    dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-slog-"));
    originalEnv = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
  });

  afterEach(() => {
    log.clearSessionLogCache();
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalEnv;
  });

  it("returns the newest agent-preset/selected, else the header", () => {
    const cwd = "C:\\work";
    writeLog({
      dshHome, cwd, sessionId: "s-1",
      headerAgentPreset: "standard",
      events: [
        { type: "user/message", data: {} },
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
      ],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-1", dshHome)).toBe("cordis");
  });

  it("does not decompress again when size and mtime are unchanged", () => {
    const cwd = "C:\\work";
    writeLog({
      dshHome, cwd, sessionId: "s-cache",
      headerAgentPreset: "standard",
      events: [
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
        { type: "user/message", data: {} },
        { type: "user/message", data: {} },
      ],
    });
    const spy = vi.spyOn(zlib, "zstdDecompressSync");
    expect(log.readSessionRuntimePreset(cwd, "s-cache", dshHome)).toBe("cordis");
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(log.readSessionRuntimePreset(cwd, "s-cache", dshHome)).toBe("cordis");
    expect(spy.mock.calls.length).toBe(first);
  });

  it("only scans the appended tail after the first read", () => {
    const cwd = "C:\\work";
    writeLog({
      dshHome, cwd, sessionId: "s-tail",
      headerAgentPreset: "standard",
      events: [
        { type: "agent-preset/selected", data: { agentPreset: "cordis" } },
        { type: "user/message", data: {} },
        { type: "user/message", data: {} },
        { type: "user/message", data: {} },
      ],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-tail", dshHome)).toBe("cordis");
    const spy = vi.spyOn(zlib, "zstdDecompressSync");
    appendFrame({
      dshHome, cwd, sessionId: "s-tail",
      event: { type: "user/message", data: { n: 1 } },
    });
    expect(log.readSessionRuntimePreset(cwd, "s-tail", dshHome)).toBe("cordis");
    // Header + original events stay cached; only the new frame is decoded.
    expect(spy.mock.calls.length).toBe(1);
  });

  it("picks up a newer agent-preset/selected written after the cached scan", () => {
    const cwd = "C:\\work";
    writeLog({
      dshHome, cwd, sessionId: "s-flip",
      headerAgentPreset: "standard",
      events: [{ type: "agent-preset/selected", data: { agentPreset: "cordis" } }],
    });
    expect(log.readSessionRuntimePreset(cwd, "s-flip", dshHome)).toBe("cordis");
    appendFrame({
      dshHome, cwd, sessionId: "s-flip",
      event: { type: "agent-preset/selected", data: { agentPreset: "minimal" } },
    });
    expect(log.readSessionRuntimePreset(cwd, "s-flip", dshHome)).toBe("minimal");
  });
});
