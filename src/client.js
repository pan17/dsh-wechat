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
.wx_actions{margin-left:auto;display:flex;gap:8px}
.wx_check{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 0}
.wx_check input{width:16px;height:16px}
.wx_user{border:1px solid rgba(128,128,128,.2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.wx_user_head{font-weight:600;font-size:12px;word-break:break-all}
.wx_toggle{display:flex;align-items:center;gap:8px;font-size:12px}
.wx_help{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:rgba(128,128,128,.22);color:var(--dsw-alias-label-secondary,#888);font-size:10px;font-weight:600;cursor:help;margin-left:6px;vertical-align:middle;position:relative;user-select:none;line-height:1}
.wx_help:hover,.wx_help:focus{background:rgba(128,128,128,.42);outline:none;color:inherit}
.wx_help::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);padding:6px 10px;background:rgba(20,20,20,.92);color:#fff;font-size:11px;font-weight:400;white-space:normal;width:max-content;max-width:260px;border-radius:6px;opacity:0;pointer-events:none;transition:opacity .12s;z-index:20;line-height:1.5;text-align:left}
.wx_help::before{content:"";position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);border:4px solid transparent;border-top-color:rgba(20,20,20,.92);opacity:0;pointer-events:none;transition:opacity .12s;z-index:20}
.wx_help:hover::after,.wx_help:focus::after,.wx_help:hover::before,.wx_help:focus::before{opacity:1}
.wx_field_label{display:inline-flex;align-items:center}`;
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

		// Small "?" badge with a CSS-driven tooltip (data-tip). Used next to
		// settings labels whose semantics are not obvious. Hover or keyboard
		// focus shows the explanation; clicking it does not toggle the
		// surrounding <label>/checkbox.
		function HelpTip(props) {
			const text = props.text;
			return createElement("span", {
				className: "wx_help",
				"data-tip": text,
				role: "tooltip",
				tabIndex: 0,
				"aria-label": text,
				onMouseDown: (e) => e.stopPropagation(),
				onClick: (e) => e.stopPropagation(),
			}, "?");
		}

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
					const firstUser = r.body.users && r.body.users[0];
					// Fill the form once — only when first entering the page.
					// No polling: user edits stay locally until Save, and are
					// only re-synced when the user refreshes the page or after
					// a successful save/relogin/reconnect/logout (which all call
					// refresh() explicitly).
					setForm((prev) => prev ?? {
						baseUrl: r.body.config?.baseUrl ?? "",
						cdnBaseUrl: r.body.config?.cdnBaseUrl ?? "",
						botType: r.body.config?.botType ?? "",
						cwd: r.body.config?.cwd ?? "",
						textChunkLimit: String(r.body.config?.textChunkLimit ?? ""),
						cardTimeoutMs: String(r.body.config?.cardTimeoutMs ?? ""),
						crossSessionNotify: !!r.body.config?.crossSessionNotify,
						silent: !!(firstUser && firstUser.silent),
					});
				}).catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
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
							crossSessionNotify: !!form.crossSessionNotify,
						}),
					});
					if (!r.ok) {
						setMsg({ kind: "err", text: r.body.message || `保存失败 (HTTP ${r.status})` });
						setBusy("");
						return;
					}
					// 同步保存单用户静默开关（与全局一起保存）
					const firstUser = status && status.users && status.users[0];
					if (firstUser && typeof form.silent === "boolean" && form.silent !== !!firstUser.silent) {
						const ru = await api("/user", {
							method: "POST",
							body: JSON.stringify({ userId: firstUser.userId, silent: !!form.silent }),
						});
						if (!ru.ok) {
							setMsg({ kind: "err", text: ru.body.message || `静默保存失败 (HTTP ${ru.status})` });
							setBusy("");
							return;
						}
					}
					setMsg({ kind: "ok", text: r.body.message || "配置已保存" });
					refresh();
				} catch (e) {
					setMsg({ kind: "err", text: String(e) });
				}
				setBusy("");
			};

			const toggleUser = async (userId, patch) => {
				setBusy("user-" + userId);
				try {
					const r = await api("/user", {
						method: "POST",
						body: JSON.stringify({ userId, ...patch }),
					});
					setMsg(r.ok ? { kind: "ok", text: r.body.message || "已更新" } : { kind: "err", text: r.body.message || `更新失败 (HTTP ${r.status})` });
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
						createElement("span", { className: "wx_title" }, "WeChat"),
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
					createElement("div", { style: { height: "1px", background: "rgba(128,128,128,.2)", margin: "6px 0" } }),
					form ? createElement("div", { className: "wx_form" },
						createElement("label", null, "baseUrl",
							createElement("input", { value: form.baseUrl, onChange: set("baseUrl"), placeholder: "https://ilinkai.weixin.qq.com" })),
						createElement("label", null, "cdnBaseUrl",
							createElement("input", { value: form.cdnBaseUrl, onChange: set("cdnBaseUrl"), placeholder: "https://novac2c.cdn.weixin.qq.com/c2c" })),
						createElement("label", null, "botType",
							createElement("input", { value: form.botType, onChange: set("botType"), placeholder: "3" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "cwd",
								createElement(HelpTip, { text: "新会话的工作目录。仅影响未通过 /workspace 或 /session switch 显式切过工作区的用户；显式切过的保留原样。" })),
							createElement("input", { value: form.cwd, onChange: set("cwd"), placeholder: "F:\\work" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "textChunkLimit",
								createElement(HelpTip, { text: "微信单条消息长度上限（字符）。超出后会被自动拆成多条发送。" })),
							createElement("input", { value: form.textChunkLimit, onChange: set("textChunkLimit"), placeholder: "4000" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "cardTimeoutMs",
								createElement(HelpTip, { text: "提问 / 权限卡软超时（毫秒），默认 1800000（30 分钟）。超时未答复的卡会被自动撤回。" })),
							createElement("input", { value: form.cardTimeoutMs, onChange: set("cardTimeoutMs"), placeholder: "1800000" })),
					) : null,
					createElement("div", { className: "wx_row", style: { marginTop: "4px" } },
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.crossSessionNotify, onChange: (e) => setForm({ ...form, crossSessionNotify: e.target.checked }) }),
							createElement("span", null, "跨会话通知"),
							createElement(HelpTip, { text: "后台会话的已完成 / 报错 / 卡片提醒通过微信推送，默认关闭。" })),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.silent, onChange: (e) => setForm({ ...form, silent: e.target.checked }) }),
							createElement("span", null, "静默"),
							createElement(HelpTip, { text: "开启后 agent 每轮的中间过程（工具调用、思考等）不再逐条推送，只在轮次结束时发送最终回复，避免刷屏。" }),
						),
						(status?.users && status.users.length === 0) ? createElement("span", { className: "wx_meta" }, "（暂无绑定用户，静默将在首条微信消息后生效）") : null,
					),
					msg.text ? createElement("div", { className: msg.kind === "err" ? "wx_err" : "wx_ok" }, msg.text) : null,
					createElement("div", { className: "wx_row", style: { marginTop: "8px" } },
						createElement("button", { className: "wx_btn primary", onClick: saveConfig, disabled: busy !== "" || !form }, busy === "config" ? "…" : "保存配置"),
						createElement("div", { style: { marginLeft: "auto", display: "flex", gap: "8px" } },
							createElement("button", { className: "wx_btn", onClick: () => run("/relogin"), disabled: busy !== "" }, busy === "/relogin" ? "…" : "重新扫码"),
							createElement("button", { className: "wx_btn", onClick: () => run("/reconnect"), disabled: busy !== "" }, busy === "/reconnect" ? "…" : "重连"),
							createElement("button", { className: "wx_btn danger", onClick: () => { if (confirm("确定退出微信登录？")) run("/logout"); }, disabled: busy !== "" }, busy === "/logout" ? "…" : "退出登录"),
						),
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
