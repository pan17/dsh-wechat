/**
 * Inbound adapter: convert WeChat messages to DSH content blocks.
 * Ported and adapted from wechat-opencode (MIT) —
 * https://github.com/pan17/wechat-opencode (src/adapter/inbound.ts)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WeixinMessage, MessageItem } from "../weixin/types.js";
import { MessageItemType } from "../weixin/types.js";
import { parseAesKey, downloadAndDecrypt } from "../weixin/media.js";

export interface PromptBlock {
  type: "text";
  text: string;
}

/**
 * Save downloaded file to temp directory with a unique name.
 */
function saveToTemp(buffer: Buffer, fileName: string, tempDir: string): string {
  fs.mkdirSync(tempDir, { recursive: true });
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${fileName.replace(/[^\w.-]/g, "_")}`;
  const filePath = path.join(tempDir, safeName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
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
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
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
 * Convert a WeChat message to prompt content blocks for a DSH session.
 *
 * The WeChat surface context is NOT injected here — it lives in an
 * agent-scoped system-prompt section (dsh/sessions.ts agentSetup) so
 * user-message content stays clean: the session-title generator reads the
 * user message verbatim, and a hint block would pollute session titles.
 */
export async function weixinMessageToPrompt(
  msg: WeixinMessage,
  cdnBaseUrl: string,
  log: (msg: string) => void,
  tempDir: string,
): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = [];

  // Extract text
  const text = extractText(msg.item_list);
  if (text) {
    blocks.push({ type: "text", text });
  }

  // Try to download and attach media
  const mediaItem = findMediaItem(msg.item_list);
  if (mediaItem) {
    try {
      const attached = await convertMediaItem(mediaItem, cdnBaseUrl, log, tempDir);
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
): Promise<PromptBlock | null> {
  if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
    const media = item.image_item.media;
    const aesKey = parseAesKey(media);
    if (!aesKey || !media.encrypt_query_param) return null;

    log("Downloading image from CDN...");
    const buffer = await downloadAndDecrypt(media.encrypt_query_param, aesKey, cdnBaseUrl);
    const realPath = saveToTemp(buffer, "image.jpg", tempDir);

    return {
      type: "text",
      text: `[收到图片] 文件已保存到: ${realPath}`,
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

    // Text files: also read content and include it
    if (isTextFile(fileName)) {
      const content = buffer.toString("utf-8");
      return {
        type: "text",
        text: `[收到文件: ${fileName}]\n文件路径: ${realPath}\n\n文件内容:\n${content}`,
      };
    }

    // Binary files: just tell agent where it is
    return {
      type: "text",
      text: `[收到文件: ${fileName}] 文件已保存到: ${realPath}\n你可以使用这个路径来读取或处理文件。`,
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
      text: `[收到视频] 文件已保存到: ${realPath}`,
    };
  }

  return null;
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt", "md", "json", "js", "ts", "py", "java", "c", "cpp", "h",
    "css", "html", "xml", "yaml", "yml", "toml", "ini", "cfg", "sh",
    "bash", "rs", "go", "rb", "php", "sql", "csv", "log", "env",
  ].includes(ext);
}
