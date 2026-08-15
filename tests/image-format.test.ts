/**
 * Image format detection: WeChat image media is often PNG/WebP/GIF while the
 * protocol gives no extension. The saved file must carry the REAL extension
 * (previously fixed "image.jpg" left the agent with mislabeled files).
 */

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { detectImageExtension } from "../src/adapter/inbound.js";

function pngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
}
function jpgBuffer(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
}
function gifBuffer(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
}
function webpBuffer(): Buffer {
  return Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
}

describe("detectImageExtension", () => {
  it("detects PNG", () => {
    expect(detectImageExtension(pngBuffer())).toBe("png");
  });
  it("detects JPEG", () => {
    expect(detectImageExtension(jpgBuffer())).toBe("jpg");
  });
  it("detects GIF", () => {
    expect(detectImageExtension(gifBuffer())).toBe("gif");
  });
  it("detects WebP", () => {
    expect(detectImageExtension(webpBuffer())).toBe("webp");
  });
  it("falls back to jpg for unknown/empty buffers", () => {
    expect(detectImageExtension(Buffer.from([1, 2, 3, 4]))).toBe("jpg");
    expect(detectImageExtension(Buffer.alloc(0))).toBe("jpg");
  });
});

describe("image save uses the detected extension (integration through temp dir)", () => {
  it("saves a PNG payload with a .png extension", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-img-"));
    try {
      const png = pngBuffer();
      const ext = detectImageExtension(png);
      // Replicate the inbound.ts save: `image.<ext>` with a unique prefix.
      const fileName = `image.${ext}`;
      const safeName = `${Date.now()}-${"abcd1234"}-${fileName}`;
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, png);
      expect(filePath.endsWith(".png")).toBe(true);
      // Content is actually PNG, and the extension matches.
      expect(detectImageExtension(fs.readFileSync(filePath))).toBe("png");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
