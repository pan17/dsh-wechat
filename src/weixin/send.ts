/**
 * Send messages via WeChat iLink API.
 * Ported from wechat-opencode (MIT) — https://github.com/pan17/wechat-opencode
 */

import crypto from "node:crypto";
import { sendMessage, getUploadUrl } from "./api.js";
import { encryptAesEcb, uploadToCdn } from "./media.js";
import {
  MessageType,
  MessageState,
  MessageItemType,
  UploadMediaType,
  type CDNMedia,
  type MessageItem,
} from "./types.js";

export interface WeixinSendOpts {
  baseUrl: string;
  token?: string;
  contextToken?: string;
  /**
   * Number of retries on transient network failures for the underlying
   * `sendMessage` API call. Default: 2 (3 total attempts). Set to 0 to
   * disable retry for paths that are already best-effort.
   */
  retries?: number;
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts: WeixinSendOpts,
): Promise<string> {
  const clientId = `wechat-acp-${crypto.randomUUID()}`;
  await sendMessage({
    baseUrl: opts.baseUrl,
    token: opts.token,
    retries: opts.retries ?? 2,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
  });
  return clientId;
}

export interface SendMediaOpts extends WeixinSendOpts {
  cdnBaseUrl: string;
  fileName?: string;
  mimeType?: string;
  thumbBuffer?: Buffer;
}

/**
 * Send a media message (image/file/video/voice) to a WeChat user.
 *
 * Flow:
 * 1. Generate 16-byte AES key
 * 2. Call getUploadUrl with AES key (server encrypts upload_param with it)
 * 3. Encrypt file content with AES-128-ECB
 * 4. Upload encrypted content to CDN using server-returned upload_param
 * 5. Send message with CDN media reference
 */
export async function sendMediaMessage(
  to: string,
  mediaType: 1 | 2 | 3 | 4, // IMAGE=1, VIDEO=2, FILE=3, VOICE=4
  buffer: Buffer,
  opts: SendMediaOpts,
): Promise<string> {
  const clientId = crypto.randomBytes(16).toString("hex"); // 32-char hex, like openclaw-weixin
  const rawSize = buffer.length;
  const rawMd5 = crypto.createHash("md5").update(buffer).digest("hex");

  // Step 1: Generate a 16-byte AES key
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  // Step 2: Get upload URL from server (server encrypts it with our AES key)
  // filesize should be the encrypted file size (with PKCS7 padding)
  const encryptedSize = Math.ceil((rawSize + 1) / 16) * 16;

  const uploadResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey: clientId,
      media_type: mediaType,
      to_user_id: to,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: encryptedSize,
      no_need_thumb: !opts.thumbBuffer,
      aeskey: aesKeyHex,
    },
  });

  if (!uploadResp.upload_param) {
    throw new Error("getUploadUrl: missing upload_param in response");
  }

  // Step 3: Upload to CDN (uploadToCdn handles encryption internally)
  const uploadUrl = uploadResp.upload_full_url
    ?? `${opts.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param!)}&filekey=${encodeURIComponent(clientId)}`;

  const encryptQueryParam = await uploadToCdn({
    buffer,
    uploadParam: uploadResp.upload_param!,
    aesKey,
    filekey: clientId,
    cdnBaseUrl: opts.cdnBaseUrl,
    uploadUrl,
  });

  // Step 5: Build CDNMedia reference
  // base64-encode the hex string (32 chars → 44 char base64), not raw bytes
  const aesKeyBase64 = Buffer.from(aesKeyHex).toString("base64");

  const cdnMedia: CDNMedia = {
    encrypt_query_param: encryptQueryParam,
    aes_key: aesKeyBase64,
    encrypt_type: 1,
  };

  // Step 7: Handle thumb if provided
  let thumbCdnMedia: CDNMedia | undefined;
  if (opts.thumbBuffer && uploadResp.thumb_upload_param) {
    const thumbAesKey = crypto.randomBytes(16);
    const thumbAesKeyHex = thumbAesKey.toString("hex");

    const encryptedThumb = encryptAesEcb(opts.thumbBuffer, thumbAesKey);
    const thumbEncryptQueryParam = await uploadToCdn({
      buffer: encryptedThumb,
      uploadParam: uploadResp.thumb_upload_param,
      aesKey: thumbAesKey,
      filekey: `${clientId}_thumb`,
      cdnBaseUrl: opts.cdnBaseUrl,
    });

    thumbCdnMedia = {
      encrypt_query_param: thumbEncryptQueryParam,
      aes_key: Buffer.from(thumbAesKeyHex).toString("base64"),
    };
  }

  // Step 7: Construct message item based on media type
  let itemList: MessageItem[];
  switch (mediaType) {
    case UploadMediaType.IMAGE:
      itemList = [{
        type: MessageItemType.IMAGE,
        image_item: {
          media: cdnMedia,
          aeskey: cdnMedia.aes_key,
          url: cdnMedia.encrypt_query_param,
          mid_size: encryptedSize,
        },
      }];
      break;
    case UploadMediaType.VIDEO:
      itemList = [{
        type: MessageItemType.VIDEO,
        video_item: {
          media: cdnMedia,
          thumb_media: thumbCdnMedia,
          video_size: encryptedSize,
        },
      }];
      break;
    case UploadMediaType.FILE:
      itemList = [{
        type: MessageItemType.FILE,
        file_item: {
          media: cdnMedia,
          file_name: opts.fileName ?? "file",
          len: String(rawSize),
        },
      }];
      break;
    case UploadMediaType.VOICE:
      itemList = [{
        type: MessageItemType.VOICE,
        voice_item: {
          media: cdnMedia,
        },
      }];
      break;
    default:
      throw new Error(`Unsupported media type: ${mediaType}`);
  }

  // Step 8: Send the message
  await sendMessage({
    baseUrl: opts.baseUrl,
    token: opts.token,
    retries: opts.retries ?? 2,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        ...(opts.contextToken ? { context_token: opts.contextToken } : {}),
        item_list: itemList,
      },
    },
  });

  return clientId;
}

/**
 * Split text into segments of max length, respecting line breaks where possible.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}
