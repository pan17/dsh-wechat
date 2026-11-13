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
    await expect(manager.remove(original)).rejects.toThrow("请先退出");
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
    await manager.get(original).bridge.logout();
    manager.setDefault(original);
    const accountDir = path.join(dir, "accounts", original);
    const attachments = path.join(accountDir, "tempfile");
    fs.mkdirSync(attachments);
    fs.writeFileSync(path.join(attachments, "photo.jpg"), "original attachment");
    await manager.configure(original, { cwd: dir });
    await manager.remove(original);
    expect(manager.list().map(row => [row.id, row.default])).toEqual([[fresh, false]]);
    expect(fs.existsSync(path.join(accountDir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(accountDir, "state.json"))).toBe(false);
    expect(fs.readFileSync(path.join(attachments, "photo.jpg"), "utf8")).toBe("original attachment");
    expect(manager.owner("chat")).toBeUndefined();
    manager.setDefault(fresh);
    const reloaded = new WeChatAccounts({ get: () => undefined, on: () => () => {} }, { ...defaultConfig(), storageDir: dir });
    try {
      expect(reloaded.list().map(row => row.id)).toEqual([fresh]);
      expect((await reloaded.send("chat", { text: "old reply" })).message).toContain("已移除");
      reloaded.inherit("child", { origin: "subagent", parentSession: "chat" });
      expect((await reloaded.send("child", { text: "old reply" })).message).toContain("已移除");
      await reloaded.remove(fresh);
      expect(reloaded.list()).toEqual([]);
    } finally { await reloaded.stop(); }
  } finally {
    confirm();
    await manager.stop();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
