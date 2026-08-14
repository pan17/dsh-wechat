/**
 * AES-128-ECB encrypt/decrypt for WeChat CDN media.
 * Adapted from @tencent-weixin/openclaw-weixin cdn/aes-ecb.ts and
 * wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

import crypto from "node:crypto";
import type { CDNMedia } from "./types.js";

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse the AES key from CDN media reference.
 * The key can be either:
 *   - base64 → 16 raw bytes (use directly)
 *   - base64 → 32 hex chars → parse hex → 16 bytes
 */
export function parseAesKey(media: CDNMedia): Buffer | null {
  const raw = media.aes_key;
  if (!raw) return null;

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hexStr = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, "hex");
    }
  }
  return decoded.subarray(0, 16);
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKey: Buffer,
  cdnBaseUrl: string,
  filekey?: string,
): Promise<Buffer> {
  let url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  if (filekey) {
    url += `&filekey=${encodeURIComponent(filekey)}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download failed: HTTP ${res.status}`);
  const ciphertext = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(ciphertext, aesKey);
}

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;

export async function uploadToCdn(params: {
  buffer: Buffer;
  uploadParam: string;
  aesKey: Buffer;
  filekey: string;
  cdnBaseUrl: string;
  uploadUrl?: string;
}): Promise<string> {
  const encrypted = encryptAesEcb(params.buffer, params.aesKey);
  const url = params.uploadUrl ?? `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encrypted),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        const body = await res.text();
        throw new Error(`CDN upload: missing x-encrypted-param header. Body: ${body}`);
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        // retry
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }

  return downloadParam ?? "";
}
