/**
 * Streaming markdown filter — character-level state machine that strips
 * unsupported markdown syntax on the fly.
 *
 * Ported from Tencent/openclaw-weixin `src/messaging/markdown-filter.ts`
 * (MIT) — https://github.com/Tencent/openclaw-weixin
 *
 * WeChat renders bot text with its own markdown support that differs from
 * ordinary user text, so this filter is deliberately *selective*: it passes
 * most syntax through untouched and only removes the constructs the client
 * cannot render.
 *
 * Constructs passed through (not filtered):
 * - Code fences (```) and inline code (`)
 * - Tables (|...|), links ([text](url)), H1-H4 headings
 * - Horizontal rules (---, ***, ___)
 * - Bold (**) and italic/bold-italic wrapping non-CJK content
 *
 * Constructs filtered (markers stripped, content kept):
 * - Italic/bold-italic wrapping CJK content
 * - Headings H5/H6 (#####, ######)
 * - Images (![alt](url)) — removed entirely
 *
 * Outputs as much filtered text as possible on each `feed()` call, holding
 * back only the minimum characters needed for pattern disambiguation (e.g. a
 * trailing `*` that might still become `***`).
 */

type InlineKind = "image" | "bold3" | "italic" | "ubold3" | "uitalic";

const INLINE_MARKERS: Record<InlineKind, string> = {
  image: "![",
  bold3: "***",
  italic: "*",
  ubold3: "___",
  uitalic: "_",
};

export class StreamingMarkdownFilter {
  private buf = "";
  private fence = false;
  private sol = true;
  private inl: { type: InlineKind; acc: string } | null = null;

  feed(delta: string): string {
    this.buf += delta;
    return this.pump(false);
  }

  flush(): string {
    return this.pump(true);
  }

  private pump(eof: boolean): string {
    let out = "";
    while (this.buf) {
      const sLen = this.buf.length;
      const sSol = this.sol;
      const sFence = this.fence;
      const sInl = this.inl;

      if (this.fence) out += this.pumpFence(eof);
      else if (this.inl) out += this.pumpInline();
      else if (this.sol) out += this.pumpSOL(eof);
      else out += this.pumpBody(eof);

      if (
        this.buf.length === sLen &&
        this.sol === sSol &&
        this.fence === sFence &&
        this.inl === sInl
      ) {
        break;
      }
    }

    if (eof && this.inl) {
      out += INLINE_MARKERS[this.inl.type] + this.inl.acc;
      this.inl = null;
    }
    return out;
  }

  /** Inside a code fence: pass content and markers through verbatim. */
  private pumpFence(eof: boolean): string {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return "";
      if (this.buf.startsWith("```")) {
        const nl = this.buf.indexOf("\n", 3);
        if (nl !== -1) {
          this.fence = false;
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.fence = false;
          const line = this.buf;
          this.buf = "";
          return line;
        }
        return "";
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf("\n");
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf;
    this.buf = "";
    return chunk;
  }

  /** At start of line: detect and consume line-start patterns, then move to body. */
  private pumpSOL(eof: boolean): string {
    const b = this.buf;

    if (b.charAt(0) === "\n") {
      this.buf = b.slice(1);
      return "\n";
    }

    if (b.charAt(0) === "`") {
      if (b.length < 3 && !eof) return "";
      if (b.startsWith("```")) {
        const nl = b.indexOf("\n", 3);
        if (nl !== -1) {
          this.fence = true;
          const line = b.slice(0, nl + 1);
          this.buf = b.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.buf = "";
          return b;
        }
        return "";
      }
      // A lone backtick starts inline code: keep it, it is rendered.
      this.sol = false;
      return "";
    }

    if (b.charAt(0) === ">") {
      this.sol = false;
      return "";
    }

    if (b.charAt(0) === "#") {
      let n = 0;
      while (n < b.length && b.charAt(n) === "#") n++;
      if (n === b.length && !eof) return "";
      // H5/H6 markers are not rendered; H1-H4 are left intact.
      if (n >= 5 && n <= 6 && n < b.length && b.charAt(n) === " ") {
        this.buf = b.slice(n + 1);
        this.sol = false;
        return "";
      }
      this.sol = false;
      return "";
    }

    if (b.charAt(0) === " " || b.charAt(0) === "\t") {
      if (b.search(/[^ \t]/) === -1 && !eof) return "";
      this.sol = false;
      return "";
    }

    if (b.charAt(0) === "-" || b.charAt(0) === "*" || b.charAt(0) === "_") {
      const ch = b.charAt(0);
      let j = 0;
      while (j < b.length && (b.charAt(j) === ch || b.charAt(j) === " ")) j++;
      if (j === b.length && !eof) return "";
      if (j === b.length || b.charAt(j) === "\n") {
        let count = 0;
        for (let k = 0; k < j; k++) if (b.charAt(k) === ch) count++;
        if (count >= 3) {
          // Horizontal rule: passed through.
          if (j < b.length) {
            this.buf = b.slice(j + 1);
            this.sol = true;
            return b.slice(0, j + 1);
          }
          this.buf = "";
          return b;
        }
      }
      this.sol = false;
      return "";
    }

    this.sol = false;
    return "";
  }

  /** Scan a line body for inline triggers; emit safe characters eagerly. */
  private pumpBody(eof: boolean): string {
    let out = "";
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf.charAt(i);
      if (c === "\n") {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }
      if (c === "!" && this.buf.charAt(i + 1) === "[") {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: "image", acc: "" };
        return out;
      }
      if (c === "~") {
        i++;
        continue;
      }
      if (c === "*") {
        if (i + 2 < this.buf.length && this.buf.charAt(i + 1) === "*" && this.buf.charAt(i + 2) === "*") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "bold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf.charAt(i + 1) === "*") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf.charAt(i + 1) !== " " && this.buf.charAt(i + 1) !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "italic", acc: "" };
          return out;
        }
        i++;
        continue;
      }
      if (c === "_") {
        if (i + 2 < this.buf.length && this.buf.charAt(i + 1) === "_" && this.buf.charAt(i + 2) === "_") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: "ubold3", acc: "" };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf.charAt(i + 1) === "_") {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf.charAt(i + 1) !== " " && this.buf.charAt(i + 1) !== "\n") {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: "uitalic", acc: "" };
          return out;
        }
        i++;
        continue;
      }
      i++;
    }

    // Hold back only what could still complete a marker on the next feed.
    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith("**")) hold = 2;
      else if (this.buf.endsWith("__")) hold = 2;
      else if (this.buf.endsWith("*")) hold = 1;
      else if (this.buf.endsWith("_")) hold = 1;
      else if (this.buf.endsWith("!")) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : "";
    return out;
  }

  /** Accumulate inline content until the closing marker is found. */
  private pumpInline(): string {
    const state = this.inl;
    if (!state) return "";
    state.acc += this.buf;
    this.buf = "";

    switch (state.type) {
      case "bold3": {
        const idx = state.acc.indexOf("***");
        if (idx !== -1) {
          const content = state.acc.slice(0, idx);
          this.buf = state.acc.slice(idx + 3);
          this.inl = null;
          return containsCJK(content) ? content : `***${content}***`;
        }
        return "";
      }
      case "ubold3": {
        const idx = state.acc.indexOf("___");
        if (idx !== -1) {
          const content = state.acc.slice(0, idx);
          this.buf = state.acc.slice(idx + 3);
          this.inl = null;
          return containsCJK(content) ? content : `___${content}___`;
        }
        return "";
      }
      case "italic": {
        for (let j = 0; j < state.acc.length; j++) {
          if (state.acc.charAt(j) === "\n") {
            const r = "*" + state.acc.slice(0, j + 1);
            this.buf = state.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (state.acc.charAt(j) === "*") {
            if (j + 1 < state.acc.length && state.acc.charAt(j + 1) === "*") {
              j++;
              continue;
            }
            const content = state.acc.slice(0, j);
            this.buf = state.acc.slice(j + 1);
            this.inl = null;
            return containsCJK(content) ? content : `*${content}*`;
          }
        }
        return "";
      }
      case "uitalic": {
        for (let j = 0; j < state.acc.length; j++) {
          if (state.acc.charAt(j) === "\n") {
            const r = "_" + state.acc.slice(0, j + 1);
            this.buf = state.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (state.acc.charAt(j) === "_") {
            if (j + 1 < state.acc.length && state.acc.charAt(j + 1) === "_") {
              j++;
              continue;
            }
            const content = state.acc.slice(0, j);
            this.buf = state.acc.slice(j + 1);
            this.inl = null;
            return containsCJK(content) ? content : `_${content}_`;
          }
        }
        return "";
      }
      case "image": {
        const cb = state.acc.indexOf("]");
        if (cb === -1) return "";
        if (cb + 1 >= state.acc.length) return "";
        if (state.acc.charAt(cb + 1) !== "(") {
          const r = "![" + state.acc.slice(0, cb + 1);
          this.buf = state.acc.slice(cb + 1);
          this.inl = null;
          return r;
        }
        const cp = state.acc.indexOf(")", cb + 2);
        if (cp !== -1) {
          this.buf = state.acc.slice(cp + 1);
          this.inl = null;
          return "";
        }
        return "";
      }
    }
  }
}

/** CJK ranges used by the upstream filter to decide italic handling. */
export function containsCJK(text: string): boolean {
  return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
}

/**
 * Whole-text markdown preparation for one WeChat message.
 *
 * The bridge sends complete segments rather than a token stream, so the
 * streaming state machine is driven once and then flushed: unfinished markers
 * are restored exactly as upstream's `flush()` would.
 */
export function filterMarkdown(text: string): string {
  const filter = new StreamingMarkdownFilter();
  return filter.feed(text) + filter.flush();
}
