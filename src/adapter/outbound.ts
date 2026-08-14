/**
 * Outbound adapter: format agent output for WeChat delivery.
 * Ported from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

/**
 * Strip markdown formatting for cleaner WeChat display.
 * Preserves code blocks (as they're useful even in plain text).
 */
export function formatForWeChat(text: string): string {
  // Remove image references ![alt](url)
  let out = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[$1]");

  // Convert links [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Remove bold/italic markers but keep text
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/\*(.+?)\*/g, "$1");
  out = out.replace(/__(.+?)__/g, "$1");
  out = out.replace(/_(.+?)_/g, "$1");

  // Remove heading markers
  out = out.replace(/^#{1,6}\s+/gm, "");

  // Clean up excessive blank lines
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}
