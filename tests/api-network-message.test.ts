import { afterEach, describe, expect, it, vi } from "vitest";
import { getQrcodeStatus } from "../src/weixin/api.js";

// A network blip during QR polling used to surface as a bare "TypeError: fetch
// failed", which told the user nothing. Every failure that never reached the
// server now reads as one sentence; an HTTP status is the server's answer and
// keeps its own text.
describe("apiGet network error message", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces a fetch rejection with the network message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" })).rejects.toThrow(
      "网络异常，无法连接微信服务器，请检查网络后重试",
    );
  });

  it("keeps the original error on cause", async () => {
    const original = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND gw.example"), { code: "ENOTFOUND" }),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    await expect(getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" })).rejects.toMatchObject({
      cause: original,
    });
  });

  it("replaces a connection that dies mid-body", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"wa'));
        controller.error(new TypeError("terminated"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" })).rejects.toThrow(
      "网络异常，无法连接微信服务器，请检查网络后重试",
    );
  });

  it("keeps the server's answer for an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 503 })));
    await expect(getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" })).rejects.toThrow(
      "HTTP 503: busy",
    );
  });
});
