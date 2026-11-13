import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WeChatDSHBridge } from "./bridge/bridge.js";
import { ConfigStore, type EditableConfig } from "./config-store.js";
import type { WeChatDSHConfig } from "./config.js";
import type { BridgeContext } from "./dsh/sessions.js";
import type { TokenData } from "./weixin/auth.js";
import { writePrivateFile } from "./utils/secure-fs.js";

interface Account {
  id: string;
  name: string;
  bot?: string;
  peer?: string;
}
interface SessionBinding {
  accountId: string;
  source?: "wechat" | "gui";
}
interface Directory {
  accounts: Account[];
  defaultId: string | null;
  bindings: Record<string, SessionBinding>;
}
export interface SendArgs {
  list_accounts?: boolean;
  recipients?: string[];
  text?: string;
  file_path?: string;
}
type Commands = Parameters<WeChatDSHBridge["attachCommands"]>[0];
type Runtime = { bridge: WeChatDSHBridge; store: ConfigStore };

/** One coordinator per host. All ownership changes are synchronous through the
 * atomic rename, so two concurrent WeChat commands cannot both claim a chat. */
export class WeChatAccounts {
  private readonly file: string;
  private directory: Directory;
  private readonly runtimes = new Map<string, Runtime>();
  private pendingId?: string;
  private commands: Commands = null;
  private stopped = false;

  constructor(private readonly ctx: BridgeContext, private readonly config: WeChatDSHConfig) {
    this.file = path.join(config.storageDir, "accounts.json");
    this.directory = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { accounts: [], defaultId: null, bindings: {} };
    if (!Array.isArray(this.directory.accounts) || !this.directory.bindings) throw new Error("微信账号目录损坏");
    // Only rows with a confirmed iLink identity represent enrolled accounts.
    const enrolled = this.directory.accounts.filter(row => row.bot);
    if (enrolled.length !== this.directory.accounts.length) {
      const ids = new Set(enrolled.map(row => row.id));
      const defaultId = this.directory.defaultId;
      this.save({
        accounts: enrolled,
        defaultId: defaultId && ids.has(defaultId) ? defaultId : null,
        bindings: Object.fromEntries(Object.entries(this.directory.bindings).filter(([, b]) => ids.has(b.accountId))),
      });
    }
    for (const row of this.directory.accounts) {
      if (!/^[a-f0-9-]{36}$/.test(row.id) || this.runtimes.has(row.id)) throw new Error("微信账号标识无效");
      this.open(row.id);
    }
  }

  private save(next: Directory) {
    writePrivateFile(this.file + ".tmp", JSON.stringify(next, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
    this.directory = next;
  }

  private open(id: string) {
    const storageDir = path.join(this.config.storageDir, "accounts", id);
    const store = new ConfigStore(storageDir);
    const bridge = new WeChatDSHBridge(this.ctx, store.resolve({ ...this.config, storageDir }), this.commands, store, {
      claim: (session) => this.claim(id, session),
      foreign: (session) => {
        const owner = this.binding(session)?.accountId;
        return owner !== undefined && owner !== id;
      },
      acceptIdentity: (token, persist) => this.identify(id, token, persist),
      recordSource: (session, source) => {
        const binding = this.binding(session);
        if (binding?.accountId === id && binding.source !== source) this.bind(session, { accountId: id, source });
      },
    });
    this.runtimes.set(id, { bridge, store });
    return bridge;
  }

  private row(id: string): Account {
    const row = this.directory.accounts.find((r) => r.id === id);
    if (!row) throw new Error("未找到微信账号，请重新选择");
    return row;
  }

  get(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error("请先选择有效的微信账号");
    return runtime;
  }

  private update(id: string, patch: Partial<Account>) {
    this.row(id);
    this.save({ ...this.directory, accounts: this.directory.accounts.map(row => row.id === id ? { ...row, ...patch } : row) });
  }

  private identify(id: string, token: TokenData, persist?: () => void) {
    const isNew = this.pendingId === id;
    const row = isNew ? undefined : this.row(id);
    if (!token.accountId || !token.token) throw new Error("微信凭据不完整，请重新扫码");
    if (this.directory.accounts.some(r => r.id !== id && (r.bot === token.accountId || (!!token.userId && r.peer === token.userId)))) {
      throw new Error("这个微信已接入其他账号，请选择已有账号");
    }
    if (!row) {
      let n = this.directory.accounts.length + 1;
      while (this.directory.accounts.some(r => r.name === "微信 " + n)) n++;
      const account = { id, name: "微信 " + n, bot: token.accountId, peer: token.userId };
      persist?.();
      this.save({ ...this.directory, accounts: [...this.directory.accounts, account] });
      this.pendingId = undefined;
      return;
    }
    if (row.peer && token.userId ? row.peer !== token.userId : row.bot !== token.accountId) {
      throw new Error("请使用该账号原来的微信扫码。接入另一个微信请点「添加账号」");
    }
    persist?.();
    if (row.bot !== token.accountId || (token.userId && row.peer !== token.userId)) {
      this.update(id, { bot: token.accountId, peer: token.userId || row.peer });
    }
  }

  async start() {
    if (!this.runtimes.size) { this.add(); return; }
    await Promise.all([...this.runtimes.values()].map(async ({ bridge }) => {
      try { await bridge.start(false); }
      catch (error) { console.error("[dsh-wechat] 账号启动失败", error); }
    }));
  }

  add(): string {
    if (this.stopped) throw new Error("插件已停止");
    if (this.pendingId) return this.pendingId;
    const id = randomUUID();
    this.pendingId = id;
    const bridge = this.open(id);
    void bridge.start().catch(error => console.error("[dsh-wechat] 扫码启动失败", error));
    return id;
  }

  pendingLogin() {
    if (!this.pendingId) return null;
    return { id: this.pendingId, ...this.get(this.pendingId).bridge.getLoginState() };
  }

  async cancelLogin(id: string) {
    if (id !== this.pendingId) throw new Error("扫码已结束，请刷新账号列表");
    const { bridge } = this.get(id);
    this.pendingId = undefined;
    this.runtimes.delete(id);
    await bridge.stop();
  }

  async retryLogin(id: string) {
    if (id !== this.pendingId) throw new Error("扫码已结束，请刷新账号列表");
    await this.get(id).bridge.start();
  }

  rename(id: string, name: string) {
    const value = typeof name === "string" ? name.trim() : "";
    if (!value || value.length > 64 || /[\x00-\x1f]/.test(value)) throw new Error("请输入 1 至 64 字的单行备注名");
    if (this.directory.accounts.some(r => r.id !== id && (r.name === value || r.id === value))) {
      throw new Error("该备注名已被其他账号使用");
    }
    this.update(id, { name: value });
  }

  setDefault(id: string | null) {
    if (id !== null) this.row(id);
    this.save({ ...this.directory, defaultId: id });
  }

  list() {
    return this.directory.accounts.map(({ id, name }) => ({
      id, name, connection: this.get(id).bridge.connectionStatus(), default: id === this.directory.defaultId,
    }));
  }

  async configure(id: string, patch: Partial<EditableConfig>) {
    const { bridge, store } = this.get(id);
    if (patch.cwd !== undefined) {
      try {
        if (typeof patch.cwd !== "string" || !path.isAbsolute(patch.cwd) || !fs.statSync(patch.cwd).isDirectory()) throw new Error();
        fs.accessSync(patch.cwd, fs.constants.R_OK | fs.constants.X_OK);
      } catch { throw new Error("工作目录不可用，请填写已存在且可访问的绝对目录"); }
    }
    return bridge.updateConfig(store.update(patch));
  }

  attachCommands(commands: Commands) {
    this.commands = commands;
    for (const { bridge } of this.runtimes.values()) bridge.attachCommands(commands);
  }

  private binding(session: string) {
    return Object.hasOwn(this.directory.bindings, session) ? this.directory.bindings[session] : undefined;
  }

  private bind(session: string, binding: SessionBinding) {
    this.save({ ...this.directory, bindings: { ...this.directory.bindings, [session]: binding } });
  }

  private claim(id: string, session: string) {
    const current = this.binding(session);
    if (current) return current.accountId === id;
    this.bind(session, { accountId: id });
    return true;
  }

  inherit(session: string, header?: { origin?: string; parentSession?: string }) {
    if (this.binding(session) || header?.origin !== "subagent" || !header.parentSession) return;
    const parent = this.binding(header.parentSession);
    if (parent) this.bind(session, { ...parent });
  }

  owner(session?: string) {
    const binding = session && this.binding(session);
    return binding ? this.get(binding.accountId).bridge : undefined;
  }

  async send(session: string, args: SendArgs) {
    const accounts = this.list().filter(row => this.get(row.id).bridge.isConnected());
    if (args.list_accounts) return { ok: true, message: "当前已连接的微信账号", accounts };
    if ((!args.text && !args.file_path) || (args.text && args.file_path)) return { ok: false, message: "每次请选择文字或文件其中一种" };
    const binding = this.binding(session);
    const targets: Account[] = [];
    if (args.recipients !== undefined) {
      if (!Array.isArray(args.recipients) || !args.recipients.length) return { ok: false, message: "请指定接收账号", accounts };
      for (const value of args.recipients) {
        const target = this.directory.accounts.find(r => r.id === value || r.name === value);
        if (!target) return { ok: false, message: "未知接收账号：" + String(value), accounts };
        if (!targets.includes(target)) targets.push(target);
      }
    } else {
      const id = binding?.source === "wechat" ? binding.accountId : this.directory.defaultId;
      if (!id) return { ok: false, message: "未设置默认接收账号，请询问用户要发送给谁", accounts };
      targets.push(this.row(id));
    }
    // A recipient with permissive file settings must never relax the caller's
    // own file policy. Each recipient also applies its own size and path limits.
    if (args.file_path && binding) {
      const refused = await this.get(binding.accountId).bridge.guardOutgoingFile(session, args.file_path);
      if (refused) return { ok: false, message: refused };
    }
    const results = await Promise.all(targets.map(async ({ id, name }) => {
      try {
        const result = await this.get(id).bridge.handleSendWeChat(session, args);
        const status = !result.ok ? "failed" : result.queued ? "queued" : "sent";
        return { id, name, status, ...result };
      } catch (error) {
        return { id, name, status: "failed", ok: false, message: String(error) };
      }
    }));
    return { ok: results.every(r => r.ok), message: results.map(r => r.name + "：" + r.message).join("\n"), results };
  }

  async stop() {
    this.stopped = true;
    await Promise.all([...this.runtimes.values()].map(({ bridge }) => bridge.stop()));
  }
}
