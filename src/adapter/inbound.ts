/**
 * Inbound adapter: convert WeChat messages to DSH content blocks.
 * Ported and adapted from wechat-opencode (MIT) —
 * https://github.com/pan17/wechat-opencode (src/adapter/inbound.ts)
 */

import path from "node:path";
import crypto from "node:crypto";
import type { WeixinMessage, MessageItem, CDNMedia } from "../weixin/types.js";
import { MessageItemType } from "../weixin/types.js";
import { parseAesKey, downloadAndDecrypt } from "../weixin/media.js";
import { ensurePrivateDir, writePrivateFile } from "../utils/secure-fs.js";
import { formatFileMention } from "../bridge/at-refs.js";

export interface PromptBlock {
  type: "text";
  text: string;
}

/**
 * How a saved inbound media file is announced to the model.
 *
 *   - `"at"` — a host `@文件` reference (`@path` / `@"path with spaces"`), the
 *     exact token the GUI composer produces, so the GUI renders an openable
 *     chip. `dsh-file-reference-local` installs `FILE_REFERENCE_PROMPT` for it,
 *     which tells the model to call `read`. Opt-in: the chip only appears when
 *     the host has that plugin mounted.
 *   - `"path"` (default) — the plain-path wording (`文件已保存到: <abs path>`),
 *     which reads correctly whatever the host has mounted. Same pointer,
 *     different spelling.
 *
 * NEITHER mode pastes the file's content. That is not a mode, it is the rule: a
 * file is a POINTER. Inlining the bytes duplicates what `read` returns, turns
 * the chat bubble into a wall of the file's text, and lets one large attachment
 * burn the context window. (0.12 and earlier did paste small text files; 0.13.0
 * removed that path outright — the wording switch cannot bring it back.)
 */
export type MediaRefStyle = "path" | "at";

/**
 * Save downloaded file to temp directory with a unique name.
 *
 * Inbound media is the user's own content, so it lives under the same private
 * policy as the rest of the storage dir: directory 0o700, file 0o600 (Windows
 * ignores the mode and relies on the inherited ACLs — see secure-fs).
 */
function saveToTemp(buffer: Buffer, fileName: string, tempDir: string): string {
  ensurePrivateDir(tempDir);
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${fileName.replace(/[^\w.-]/g, "_")}`;
  const filePath = path.join(tempDir, safeName);
  writePrivateFile(filePath, buffer);
  return filePath;
}

/**
 * Render one saved path as the pointer the model should see.
 *
 * In `"at"` mode the path goes through {@link formatFileMention} — the SAME
 * spelling layer `/at f` uses, byte-compatible with
 * `@deepseek-ai/dsh-file-reference`'s grammar — with Windows separators folded
 * to `/` so a mention never depends on the host OS. A path that grammar cannot
 * express (a control character or a double quote) falls back to the plain path
 * rather than producing a token that would silently truncate into prose; the
 * inbound filename is already sanitized by {@link saveToTemp}, so this is a
 * belt-and-braces branch, not a reachable user-facing refusal.
 *
 * In `"path"` mode it is just the absolute path — the model gets the same
 * location, only as prose.
 */
function mediaPointer(realPath: string, style: MediaRefStyle): string {
  if (style === "at") {
    const mention = formatFileMention({
      path: realPath.split(path.sep).join("/"),
      kind: "file",
    });
    if (mention) return mention;
  }
  return realPath;
}

/**
 * The phrase the model reads for one saved attachment.
 *
 * `at` → the bare reference (`@C:/…`, which the GUI turns into a chip);
 * `path` → the historical prose ("文件已保存到: C:/…"), so a path-mode bubble
 * reads as a sentence instead of a lone path. Same pointer, different spelling.
 */
function mediaNotice(realPath: string, style: MediaRefStyle): string {
  const pointer = mediaPointer(realPath, style);
  return style === "at" ? pointer : `文件已保存到: ${pointer}`;
}

/**
 * Detect an image file's real format from its magic bytes. WeChat image
 * media is often PNG (or WebP/GIF) while the protocol gives no extension,
 * so a fixed `.jpg` name would leave the agent with a mislabeled file.
 * Returns the extension WITHOUT the leading dot; falls back to "jpg".
 */
export function detectImageExtension(buffer: Buffer): string {
  if (!buffer || buffer.length < 12) return "jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png"; // PNG \x89PNG
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg"; // JPEG SOI
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "gif"; // GIF8
  }
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "webp"; // RIFF....WEBP
  }
  return "jpg";
}

/**
 * Extract text body from a WeChat message's item_list.
 */
export function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Build quoted context
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.text_item?.text) parts.push(ref.message_item.text_item.text);
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // Voice transcription
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/**
 * Find the first media item in a message.
 */
export function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList) return undefined;
  return (
    itemList.find((i) => i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param) ??
    itemList.find((i) => i.type === MessageItemType.VIDEO && i.video_item?.media?.encrypt_query_param) ??
    itemList.find((i) => i.type === MessageItemType.FILE && i.file_item?.media?.encrypt_query_param) ??
    itemList.find(
      (i) => i.type === MessageItemType.VOICE && i.voice_item?.media?.encrypt_query_param && !i.voice_item.text,
    )
  );
}

/**
 * Whether a media item may be HELD so it can share a turn with the sentence
 * the user types next (图片/文件合并).
 *
 * Deliberately narrower than {@link findMediaItem}:
 *
 *   - an IMAGE / FILE / VIDEO (the three the feature is about);
 *   - a VOICE item with an untouched transcript is EXCLUDED — it carries no
 *     usable payload here (`convertMediaItem` only ever answers "无转写"), so
 *     holding it would delay a turn to merge in a placeholder;
 *   - an item with no downloadable media reference is excluded, because the
 *     only thing holding it could produce is a "下载失败" line.
 */
export function isHoldableMediaItem(item: MessageItem | undefined): item is MessageItem {
  if (!item) return false;
  const hasMedia = (media: CDNMedia | undefined): boolean =>
    typeof media?.encrypt_query_param === "string" && media.encrypt_query_param.length > 0;
  if (item.type === MessageItemType.IMAGE) return hasMedia(item.image_item?.media);
  if (item.type === MessageItemType.VIDEO) return hasMedia(item.video_item?.media);
  if (item.type === MessageItemType.FILE) return hasMedia(item.file_item?.media);
  return false;
}

/**
 * Convert a WeChat message to prompt content blocks for a DSH session.
 *
 * The WeChat surface context is NOT injected here — it lives in a
 * global runtime context (index.ts `dsh-wechat-surface`) so
 * user-message content stays clean: the session-title generator reads the
 * user message verbatim, and a hint block would pollute session titles.
 *
 * A saved media file is handed over as a pointer and nothing else — see
 * {@link mediaPointer} and {@link MediaRefStyle}. `opts.refStyle` picks the
 * SPELLING only; no mode inlines the file's content.
 */
export async function weixinMessageToPrompt(
  msg: WeixinMessage,
  cdnBaseUrl: string,
  log: (msg: string) => void,
  tempDir: string,
  opts?: { refStyle?: MediaRefStyle },
): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = [];
  const refStyle: MediaRefStyle = opts?.refStyle ?? "path";

  // Extract text
  const text = extractText(msg.item_list);
  if (text) {
    blocks.push({ type: "text", text });
  }

  // Try to download and attach media
  const mediaItem = findMediaItem(msg.item_list);
  if (mediaItem) {
    try {
      const attached = await convertMediaItem(mediaItem, cdnBaseUrl, log, tempDir, refStyle);
      if (attached) blocks.push(attached);
    } catch (err) {
      log(`Media download failed, skipping: ${String(err)}`);
      const mediaType = mediaItem.type === MessageItemType.IMAGE ? "image"
        : mediaItem.type === MessageItemType.VIDEO ? "video"
        : mediaItem.type === MessageItemType.FILE ? `file (${mediaItem.file_item?.file_name ?? "unknown"})`
        : mediaItem.type === MessageItemType.VOICE ? "voice"
        : "media";
      blocks.push({ type: "text", text: `[收到${mediaType} - 下载失败]` });
    }
  }

  // Fallback: always have at least one content block
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[空消息]" });
  }

  return blocks;
}

async function convertMediaItem(
  item: MessageItem,
  cdnBaseUrl: string,
  log: (msg: string) => void,
  tempDir: string,
  refStyle: MediaRefStyle,
): Promise<PromptBlock | null> {
  if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
    const media = item.image_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log("Downloading image from CDN...");
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);
    const ext = detectImageExtension(buffer);
    const realPath = saveToTemp(buffer, `image.${ext}`, tempDir);

    return {
      type: "text",
      text: `[收到图片] ${mediaNotice(realPath, refStyle)}`,
    };
  }

  if (item.type === MessageItemType.FILE && item.file_item?.media) {
    const media = item.file_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log(`Downloading file "${item.file_item.file_name}" from CDN...`);
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);

    const fileName = item.file_item.file_name ?? "file";
    const realPath = saveToTemp(buffer, fileName, tempDir);

    // A POINTER in both styles, never the bytes: `dsh-file-reference-local`
    // instructs the model to call `read`, and pasting the content would both
    // duplicate that and (for a large attachment) blow the context window. The
    // file is on disk; if the model needs it, it reads it.
    //
    // No "you can use this path to read the file" sentence: it tells the model
    // what the reference prompt already says, and in a WeChat bubble it is pure
    // noise between the user's question and the attachment.
    return {
      type: "text",
      text: `[收到文件: ${fileName}] ${mediaNotice(realPath, refStyle)}`,
    };
  }

  if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    return { type: "text", text: "[收到语音消息 - 无转写]" };
  }

  if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
    const media = item.video_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log("Downloading video from CDN...");
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);
    const realPath = saveToTemp(buffer, "video.mp4", tempDir);

    return {
      type: "text",
      text: `[收到视频] ${mediaNotice(realPath, refStyle)}`,
    };
  }

  return null;
}
