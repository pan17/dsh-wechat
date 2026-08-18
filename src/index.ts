/**
 * dsh-wechat — Bridge WeChat (iLink bot) to DeepSeek Harness (DSH).
 *
 * Cordis host plugin entry. Loaded through the package's cordis.patch.yml
 * bundle layer (`- insert: - id: dsh-wechat name: 'dsh-wechat'`).
 *
 * Zero runtime dependencies on `@deepseek-ai/*` packages: every DSH
 * service is read through `ctx.get(...)` and all message/value types are
 * constructed by local vendors or structural shapes.
 */

import { WeChatDSHBridge } from "./bridge/bridge.js";
import { ConfigStore, type EditableConfig } from "./config-store.js";
import { defaultConfig, type WeChatDSHConfig } from "./config.js";
import { qrSvgFor } from "./qr.js";

export const name = "dsh-wechat";
export const inject: string[] = [];

/** Plugin config accepted from the composition row's `config:` block. */
export interface PluginConfig {
  baseUrl?: string;
  cdnBaseUrl?: string;
  botType?: string;
  storageDir?: string;
  cwd?: string;
  textChunkLimit?: number;
  cardTimeoutMs?: number;
}

export function apply(ctx: unknown, rawConfig: PluginConfig = {}): () => Promise<void> {
  const baseConfig: WeChatDSHConfig = {
    ...defaultConfig(),
    ...pickDefined(rawConfig),
  };
  const configStore = new ConfigStore(baseConfig.storageDir);
  const config = configStore.resolve(baseConfig);
  const context = ctx as {
    get<T = unknown>(name: string): T | undefined;
    on(event: string, listener: (...args: unknown[]) => unknown): () => void;
    inject?: (deps: string[], callback: (ctx: unknown) => unknown) => unknown;
  };

  const bridge = new WeChatDSHBridge(context, config);

  // ─── Session event feed: assistant output → WeChat ───
  context.on("session/event", (session, event) => {
    const sessionId = (session as { id?: string })?.id;
    if (!sessionId) return;
    bridge.handleSessionEvent(sessionId, event as { type: string; [k: string]: unknown });
  });

  // ─── Agent errors → WeChat notification ───
  context.on("agent/error", (payload) => {
    const agentId = (payload as { agent?: { id?: string } })?.agent?.id;
    if (!agentId) return;
    bridge.handleAgentError(agentId, (payload as { error?: unknown })?.error);
  });

  // ─── Model overrides: /model switch applies to the live agent's next
  // request by rewriting the frozen call config (same cooperative pattern
  // as dsh-agent's installModelSelection: await next(), then replace). ───
  context.on("agent/request", async (payload, next) => {
    const agentId = (payload as { agent?: { id?: string } })?.agent?.id;
    const nextFn = next as () => Promise<unknown>;
    const config = await nextFn();
    if (!agentId || !bridge.userForAgent(agentId)) return config;
    return bridge.applyModelOverride(config as { provider: string; model: string }, agentId);
  });

  // ─── send_wechat tool: agent-initiated push to the bound user ───
  // (Approval is fully native — no custom ask gate; the mux frame stream
  // below mirrors DSH's own approval/question frames to WeChat.)
  if (typeof context.inject === "function") {
    context.inject(["tools"], (toolsCtx) => {
      const toolsService = (toolsCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        register(definition: unknown): unknown;
      }>("tools");
      if (!toolsService) return;

      toolsService.register({
        name: "send_wechat",
        description:
          "Send a text message or a local file to a WeChat user. " +
          "If the calling session is bound to a WeChat user, the message goes to that user; " +
          "otherwise it goes to the first known WeChat user (single-user deployments are the norm). " +
          "Use this to proactively push results, confirmations, or files to WeChat.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text message to send to WeChat.",
            },
            file_path: {
              type: "string",
              description: "Absolute path of a local file to send to WeChat.",
            },
          },
        },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            message: { type: "string" },
          },
        },
        render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args: { text?: string; file_path?: string }, exec: { agent?: { id?: string } }) {
        return bridge.handleSendWeChat(exec.agent?.id ?? "", args);
      },
    });
    });
  } else {
    console.warn("[dsh-wechat] ctx.inject unavailable; send_wechat tool disabled");
  }

  // ─── Mux frame stream: approval/question cards mirrored to WeChat ───
  // The decision point stays in the native apiproxy pending table; this
  // subscription renders the same frames as the GUI and injects the WeChat
  // user's decision through apiProxy.respond() (whoever answers first wins).
  if (typeof context.inject === "function") {
    context.inject(["apiProxy"], (apiCtx) => {
      const apiProxy = (apiCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        respond(message: unknown): Promise<{ accepted: boolean; reason?: string }>;
        events?: unknown;
      }>("apiProxy");
      if (!apiProxy) {
        console.warn("[dsh-wechat] apiProxy unavailable; approval/question cards disabled");
        return;
      }
      bridge.attachMux(apiProxy as never);
    });
  }

  // ─── Dynamic WeChat surface prompt (per-message-source) ───
  // Registered as a GLOBAL RUNTIME CONTEXT (not a prompt section): DSH's
  // system-prompt assembly applies a "complete-section replacement" pass to
  // sections (a preset's complete section replaces ALL ordinary sections,
  // which would drop a section-registered surface prompt — exactly the
  // failure observed), while CONTEXTS are assembled on an independent path
  // ("Current runtime context" snapshot) that complete replacement never
  // touches. The context text is evaluated per assembly: the bridge tracks
  // the most recent user-message source per session, and the context returns
  // the WeChat prompt ONLY while the session's last user message came from
  // WeChat; otherwise it returns "" (empty contexts are filtered out, so
  // GUI-driven assemblies are untouched). Global registration means EVERY
  // agent — old or new, GUI- or WeChat-created, live or resumed — gets the
  // same dynamic context, so the WeChat prompt follows the message source
  // rather than the session's setup path.
  if (typeof context.inject === "function") {
    context.inject(["systemPrompt"], (promptCtx) => {
      const systemPrompt = (promptCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        context(entry: {
          name: string;
          order: number;
          text: string | ((context: unknown) => string);
        }): unknown;
      }>("systemPrompt");
      if (!systemPrompt) {
        console.warn("[dsh-wechat] systemPrompt unavailable; WeChat surface prompt disabled");
        return;
      }
      systemPrompt.context({
        name: "dsh-wechat-surface",
        order: 50,
        text: (context) => {
          const agent = (context as { agent?: unknown })?.agent as
            | { session?: { header?: { id?: string } } }
            | undefined;
          const sessionId = agent?.session?.header?.id;
          const source = sessionId ? bridge.surfaceSourceFor(sessionId) : undefined;
          return source === "wechat"
            ? "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（纯文本、适度使用 emoji、避免过长的表格）。"
            : "";
        },
      });
    });
  }

  // ─── QR page + settings-page API ───
  // The webserver row activates only after `webStartup` resolves (it waits on
  // inject), so `ctx.get('webServer')` at apply time is undefined. Use the
  // conditional-inject pattern to register the routes once the service is
  // available; the bridge itself works without them (QR URL is logged).
  if (typeof context.inject === "function") {
    context.inject(["webServer"], (httpCtx) => {
      const webServer = (httpCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        register(route: {
          kind: "exact" | "prefix";
          path: string;
          handler: (req: unknown, res: unknown) => void;
        }): unknown;
      }>("webServer");
      if (!webServer) return;

      // QR login page (standalone viewer; the settings page is the primary UI).
      webServer.register({
        kind: "exact",
        path: "/wechat/qr",
        handler: (_req, res) => {
          const response = res as HttpResponse;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(QR_PAGE);
        },
      });
      // QR image: the iLink qrcode_img_content URL is an HTML page, not an
      // image — the URL string is encoded into a QR server-side instead.
      webServer.register({
        kind: "exact",
        path: "/wechat/api/qr-image",
        handler: (_req, res) => {
          const status = bridge.getStatus() as { qrUrl?: string };
          const response = res as HttpResponse;
          if (!status.qrUrl) {
            response.statusCode = 404;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end("no QR available");
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(qrSvgFor(status.qrUrl));
        },
      });
      // QR page poll endpoint (phase/qrUrl/botId/error).
      webServer.register({
        kind: "exact",
        path: "/wechat/status",
        handler: (_req, res) => {
          sendJson(res, 200, bridge.getStatus());
        },
      });

      // Settings-page API.
      webServer.register({
        kind: "exact",
        path: "/wechat/api/status",
        handler: (_req, res) => {
          sendJson(res, 200, bridge.getStatus());
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat/api/config",
        handler: async (req, res) => {
          try {
            const patch = (await readJsonBody(req)) as Partial<EditableConfig>;
            const stored = configStore.update(patch);
            const result = await bridge.updateConfig(stored);
            sendJson(res, 200, { ok: true, ...result });
          } catch (err) {
            sendJson(res, 400, { ok: false, message: String(err) });
          }
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat/api/relogin",
        handler: async (_req, res) => {
          const result = await bridge.relogin();
          sendJson(res, 200, { ok: result.ok, message: result.message });
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat/api/reconnect",
        handler: async (_req, res) => {
          const result = await bridge.reconnect();
          sendJson(res, 200, { ok: result.ok, message: result.message });
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat/api/logout",
        handler: async (_req, res) => {
          const result = await bridge.logout();
          sendJson(res, 200, { ok: result.ok, message: result.message });
        },
      });
      console.log("[dsh-wechat] Settings UI available: 设置 → WeChat；扫码页 http://127.0.0.1:3080/wechat/qr");
    });
  } else {
    console.log("[dsh-wechat] ctx.inject unavailable; QR page disabled (login QR is logged)");
  }

  // Start the bridge (token resume or QR login), stop on dispose.
  void bridge.start().catch((err) => {
    console.error(`[dsh-wechat] bridge start failed: ${String(err)}`);
  });

  return () => bridge.stop();
}

function pickDefined(raw: PluginConfig): Partial<WeChatDSHConfig> {
  const out: Partial<WeChatDSHConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

// ─── HTTP helpers for the webServer routes ───

interface HttpResponse {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  end(chunk: string): void;
}

function sendJson(res: unknown, status: number, body: unknown): void {
  const response = res as HttpResponse;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function readJsonBody(req: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = req as NodeJS.ReadableStream & {
      on(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    stream.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${String(err)}`));
      }
    });
    stream.on("error", reject);
  });
}

/** Standalone QR login page (no client build needed). */
const QR_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 微信登录</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; padding: 2rem; }
  .card { background: #fff; border-radius: 12px; padding: 2rem; max-width: 420px; width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  .state { color: #666; margin: 1rem 0; min-height: 1.5em; }
  img.qr { width: 260px; height: 260px; border: 1px solid #eee; border-radius: 8px; }
  .error { color: #c0392b; white-space: pre-wrap; }
  .ok { color: #27ae60; font-weight: 600; }
</style>
</head>
<body>
<div class="card">
  <h1>📱 DSH 微信助手 — 扫码登录</h1>
  <div id="state" class="state">正在获取二维码…</div>
  <img id="qr" class="qr" alt="QR" style="display:none" />
  <div id="err" class="error"></div>
  <p style="color:#999;font-size:.8rem">用微信扫描二维码，确认登录后本页自动刷新。二维码 5 分钟有效，过期自动刷新。</p>
</div>
<script>
  async function poll() {
    try {
      const res = await fetch('/wechat/status');
      const data = await res.json();
      const state = document.getElementById('state');
      const qr = document.getElementById('qr');
      const err = document.getElementById('err');
      err.textContent = '';
      if (data.phase === 'logged-in') {
        state.className = 'state ok';
        state.textContent = '✅ 已登录 (Bot: ' + (data.botId || '') + ')';
        qr.style.display = 'none';
        return;
      }
      if (data.phase === 'failed') {
        state.textContent = '❌ 登录失败';
        err.textContent = data.error || '';
        return;
      }
      if (data.phase === 'scaned') {
        state.textContent = '已扫码，请在微信中确认…';
      } else {
        state.textContent = data.qrUrl ? '请用微信扫描下方二维码' : '正在获取二维码…';
      }
      if (data.qrUrl) {
        qr.src = '/wechat/api/qr-image?v=' + encodeURIComponent(data.qrUrl);
        qr.style.display = 'block';
      }
    } catch (e) {
      document.getElementById('state').textContent = '无法连接 DSH（' + e + '）';
    }
    setTimeout(poll, 2000);
  }
  poll();
</script>
</body>
</html>`;
