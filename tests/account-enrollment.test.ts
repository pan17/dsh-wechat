import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { WeChatAccounts } from "../src/accounts.js";
import { defaultConfig } from "../src/config.js";
import { saveToken } from "../src/weixin/auth.js";

it("only confirmed accounts join the directory, and only connected accounts appear in send_wechat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-enroll-"));
  const original = randomUUID(), abandoned = randomUUID();
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({
    accounts: [{ id: original, name: "主微信", bot: "first" }, { id: abandoned, name: "微信 2" }],
    bindings: { chat: { accountId: original } }, defaultId: abandoned,
  }));
  saveToken(path.join(dir, "accounts", original), {
    token: "first-token", accountId: "first", userId: "first-peer", baseUrl: "https://gw.invalid", savedAt: "",
  });
  let confirm: () => void = () => {};
  const confirmation = new Promise<void>(resolve => { confirm = resolve; });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = String(input);
    if (url.includes("get_bot_qrcode")) return Response.json({ qrcode: "qr", qrcode_img_content: "https://gw.invalid/scan" });
    if (url.includes("get_qrcode_status")) {
      await confirmation;
      return Response.json({ status: "confirmed", ilink_bot_id: "second", bot_token: "second-token", ilink_user_id: "second-peer" });
    }
    if (url.includes("getupdates")) return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error("aborted"));
      else init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return Response.json({});
  });
  const manager = new WeChatAccounts({ get: () => undefined, on: () => () => {} }, { ...defaultConfig(), storageDir: dir, baseUrl: "https://gw.invalid" });
  const list = async () => (await manager.send("", { list_accounts: true })).accounts?.map(r => r.id);
  try {
    await manager.start();
    expect(await list()).toEqual([original]);
    expect(manager.list()[0]?.default).toBe(false);
    expect(manager.owner("chat")).toBe(manager.get(original).bridge);
    const canceled = manager.add();
    await manager.cancelLogin(canceled);
    const fresh = manager.add();
    expect(manager.add()).toBe(fresh);
    await vi.waitFor(() => expect(manager.pendingLogin()?.qrUrl).toBeTruthy());
    expect(manager.list().map(a => a.id)).toEqual([original]);
    expect(await list()).toEqual([original]);
    expect(() => manager.setDefault(fresh)).toThrow();
    expect((await manager.send("", { recipients: [fresh], text: "hello" })).ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, "accounts.json"), "utf8")).not.toContain(fresh);
    confirm();
    await vi.waitFor(async () => expect(await list()).toEqual([original, fresh]));
    expect(manager.pendingLogin()).toBeNull();
    await manager.get(fresh).bridge.logout();
    expect(await list()).toEqual([original]);
    expect(manager.list().map(row => row.id)).toEqual([original, fresh]);
  } finally {
    confirm();
    await manager.stop();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
