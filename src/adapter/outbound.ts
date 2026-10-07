/**
 * Outbound adapter: prepare agent output for WeChat delivery.
 *
 * WeChat renders text sent by a bot differently from text typed by an
 * ordinary user, and it supports a subset of markdown. The reference
 * implementation is the official Tencent/openclaw-weixin channel, whose
 * `sendWeixinOutbound` runs every outbound body through
 * `StreamingMarkdownFilter`:
 *
 *   const f = new StreamingMarkdownFilter();
 *   const filteredText = f.feed(rawText) + f.flush();
 *
 * This module applies exactly that filter (see `./markdown-filter.js`), so the
 * bridge matches the official channel's rendering rather than guessing at it.
 * It is deliberately *not* a blanket markdown stripper: bold, links, H1-H4
 * headings, code fences, inline code and tables are rendered by WeChat and
 * therefore pass through untouched.
 */

import { filterMarkdown } from "./markdown-filter.js";

export { StreamingMarkdownFilter, filterMarkdown, containsCJK } from "./markdown-filter.js";

/**
 * Prepare one outbound message body for WeChat.
 *
 * Mirrors the official channel's `feed(...) + flush()` pair, then trims the
 * result.
 */
export function formatForWeChat(text: string): string {
  return filterMarkdown(text).trim();
}
