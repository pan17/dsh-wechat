/**
 * dsh-wechat client half — Settings → WeChat page.
 *
 * Authored directly in the DSH client module format (window.__ModuleLoader__),
 * the same delivery shape as dsh-mcp-manager's prebuilt client bundle: the
 * host-side client-modules service serves this file at /plugins/dsh-wechat/
 * client.js and the browser kernel loads it. Communicates with the host
 * through the plugin's own HTTP API (/wechat/api/*) registered on the GUI
 * webserver — no @deepseek-ai imports at runtime.
 */
window.__ModuleLoader__.load({
	id: "dsh-wechat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;

		const inject = ["slots"];

		const css = `
.wx_section{display:flex;flex-direction:column;gap:16px;padding:0 24px 24px}
.wx_card{border:1px solid rgba(128,128,128,.3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wx_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wx_title{font-weight:600;font-size:14px}
.wx_badge{font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4)}
.wx_badge.ok{color:#2e7d32;border-color:#2e7d32}
.wx_badge.wait{color:#ed6c02;border-color:#ed6c02}
.wx_badge.err{color:#c62828;border-color:#c62828}
.wx_btn{cursor:pointer;font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}
.wx_btn:hover{background:rgba(128,128,128,.12)}
.wx_btn:disabled{opacity:.5;cursor:default}
.wx_btn.primary{border-color:transparent;background:#1976d2;color:#fff}
.wx_btn.primary:hover{background:#1565c0}
.wx_btn.danger{border-color:#c62828;color:#c62828}
.wx_meta{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.wx_err{color:#c62828;font-size:12px}
.wx_ok{color:#2e7d32;font-size:12px}
.wx_qr img{width:200px;height:200px;border:1px solid #eee;border-radius:8px}
.wx_form{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wx_form label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.wx_form input{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}
.wx_form .wide{grid-column:1 / -1}
.wx_actions{margin-left:auto;display:flex;gap:8px}`;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-wechat/section\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-wechat";
			tag.dataset.pluginCss = "dsh-wechat/section";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const PHASE_LABEL = {
			idle: "未登录",
			"waiting-qr": "等待扫码",
			scaned: "已扫码，待确认",
			"logged-in": "已登录",
			failed: "登录失败",
		};

		function api(path, options) {
			return fetch("/wechat/api" + path, {
				headers: { "Content-Type": "application/json" },
				...options,
			}).then(async (resp) => ({ ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) }));
		}

		function WechatSection() {
			const [status, setStatus] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [msg, setMsg] = react.useState({ kind: "", text: "" });
			// Editable form state (initialized from status.config).
			const [form, setForm] = react.useState(null);

			const refresh = react.useCallback(() => {
				api("/status").then((r) => {
					if (!r.ok) return;
					setStatus(r.body);
					// Fill the form once.
					setForm((prev) => prev ?? {
						baseUrl: r.body.config?.baseUrl ?? "",
						cdnBaseUrl: r.body.config?.cdnBaseUrl ?? "",
						botType: r.body.config?.botType ?? "",
						cwd: r.body.config?.cwd ?? "",
						textChunkLimit: String(r.body.config?.textChunkLimit ?? ""),
						cardTimeoutMs: String(r.body.config?.cardTimeoutMs ?? ""),
					});
				}).catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
				const t = setInterval(refresh, 3000);
				return () => clearInterval(t);
			}, [refresh]);

			const run = async (action, next) => {
				setBusy(action);
				setMsg({ kind: "", text: "" });
				try {
					const r = await api(action, { method: "POST" });
					setMsg(r.ok ? { kind: "ok", text: r.body.message || "完成" } : { kind: "err", text: r.body.message || `失败 (HTTP ${r.status})` });
					if (r.ok) refresh();
				} catch (e) {
					setMsg({ kind: "err", text: String(e) });
				}
				setBusy("");
			};

			const saveConfig = async () => {
				if (!form) return;
				setBusy("config");
				setMsg({ kind: "", text: "" });
				try {
					const r = await api("/config", {
						method: "POST",
						body: JSON.stringify({
							baseUrl: form.baseUrl.trim(),
							cdnBaseUrl: form.cdnBaseUrl.trim(),
							botType: form.botType.trim(),
							cwd: form.cwd.trim(),
							textChunkLimit: Number(form.textChunkLimit) || undefined,
							cardTimeoutMs: Number(form.cardTimeoutMs) || undefined,
						}),
					});
					setMsg(r.ok ? { kind: "ok", text: r.body.message || "配置已保存" } : { kind: "err", text: r.body.message || `保存失败 (HTTP ${r.status})` });
					if (r.ok) refresh();
				} catch (e) {
					setMsg({ kind: "err", text: String(e) });
				}
				setBusy("");
			};

			const phase = status?.phase ?? "idle";
			const badgeClass = phase === "logged-in" ? "ok" : phase === "failed" ? "err" : "wait";
			const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

			return createElement("div", { className: "wx_section" },
				createElement("div", { className: "wx_card" },
					createElement("div", { className: "wx_row" },
						createElement("span", { className: "wx_title" }, "微信桥接状态"),
						createElement("span", { className: `wx_badge ${badgeClass}` }, PHASE_LABEL[phase] ?? phase),
						status?.monitorRunning ? createElement("span", { className: "wx_meta" }, "监控运行中") : createElement("span", { className: "wx_meta" }, "监控未运行"),
					),
					status?.botId ? createElement("div", { className: "wx_meta" }, `Bot: ${status.botId}`) : null,
					status?.userCount ? createElement("div", { className: "wx_meta" }, `已绑定微信用户: ${status.userCount}`) : null,
					status?.error ? createElement("div", { className: "wx_err" }, status.error) : null,
					phase === "waiting-qr" || phase === "scaned"
						? createElement("div", { className: "wx_qr" },
							status?.qrUrl
								? createElement("img", { src: "/wechat/api/qr-image?v=" + encodeURIComponent(status.qrUrl), alt: "扫码登录二维码" })
								: createElement("div", { className: "wx_meta" }, "正在获取二维码…"),
							createElement("div", { className: "wx_meta" }, "用微信扫描二维码，确认后自动登录"),
						)
						: null,
					createElement("div", { className: "wx_row" },
						createElement("button", { className: "wx_btn", onClick: () => run("/relogin"), disabled: busy !== "" }, busy === "/relogin" ? "…" : "重新扫码"),
						createElement("button", { className: "wx_btn", onClick: () => run("/reconnect"), disabled: busy !== "" }, busy === "/reconnect" ? "…" : "重连"),
						createElement("button", { className: "wx_btn danger", onClick: () => { if (confirm("确定退出微信登录？")) run("/logout"); }, disabled: busy !== "" }, busy === "/logout" ? "…" : "退出登录"),
					),
				),

				createElement("div", { className: "wx_card" },
					createElement("div", { className: "wx_title" }, "连接配置"),
					createElement("div", { className: "wx_meta" }, "保存后立即生效；网关地址变更会自动重连。存储于 ~/.dsh-wechat/config.json。"),
					form ? createElement("div", { className: "wx_form" },
						createElement("label", null, "iLink 网关 baseUrl",
							createElement("input", { value: form.baseUrl, onChange: set("baseUrl"), placeholder: "https://ilinkai.weixin.qq.com" })),
						createElement("label", null, "媒体 CDN cdnBaseUrl",
							createElement("input", { value: form.cdnBaseUrl, onChange: set("cdnBaseUrl"), placeholder: "https://novac2c.cdn.weixin.qq.com/c2c" })),
						createElement("label", null, "botType",
							createElement("input", { value: form.botType, onChange: set("botType"), placeholder: "3" })),
						createElement("label", null, "会话工作目录 cwd（默认；已用 /workspace 切换过的用户保留原样）",
							createElement("input", { value: form.cwd, onChange: set("cwd"), placeholder: "F:\\work" })),
						createElement("label", null, "单条消息上限 textChunkLimit",
							createElement("input", { value: form.textChunkLimit, onChange: set("textChunkLimit"), placeholder: "4000" })),
						createElement("label", null, "卡片超时 cardTimeoutMs",
							createElement("input", { value: form.cardTimeoutMs, onChange: set("cardTimeoutMs"), placeholder: "1800000" })),
					) : null,
					msg.text ? createElement("div", { className: msg.kind === "err" ? "wx_err" : "wx_ok" }, msg.text) : null,
					createElement("div", { className: "wx_row" },
						createElement("button", { className: "wx_btn primary", onClick: saveConfig, disabled: busy !== "" || !form }, busy === "config" ? "…" : "保存配置"),
					),
				),
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "wechat",
				order: 40,
				label: "WeChat",
			}, WechatSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
