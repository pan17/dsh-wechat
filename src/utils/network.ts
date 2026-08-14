/**
 * Shared network-error utilities.
 *
 * Ported from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 * Centralises the transient-network-error classifier used by the WeChat
 * iLink client retry policy.
 */

/**
 * Transient-network-error codes we retry on. The classifier walks the
 * cause chain looking for any of these — undici-style names
 * (`UND_ERR_*`) and Node `errno`-style codes both appear depending on
 * the platform / Node version.
 */
export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  // undici (Node fetch's default backend in Node 18+)
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // Node libuv errno-style codes
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/**
 * Walk the cause chain looking for any `code` matching a known transient
 * network-failure code. Returns false for `AbortError` (the per-attempt
 * timeout sentinel), for plain non-Error values, and for any error
 * without a recognised code in its chain.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const obj = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (obj.name === "AbortError") return false;
    if (typeof obj.code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(obj.code)) {
      return true;
    }
    current = obj.cause;
  }
  return false;
}
