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
.wx_form input,.wx_form textarea{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;width:100%;box-sizing:border-box}
.wx_form textarea{min-height:88px;resize:vertical;line-height:1.45}
.wx_form .wide{grid-column:1 / -1}
.wx_prompt_field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.wx_disclosure{display:flex;align-items:center;gap:6px;cursor:pointer;font:inherit;font-size:12px;color:inherit;background:none;border:none;padding:0;text-align:left;width:100%}
.wx_disclosure:hover{opacity:.85}
.wx_disclosure_chevron{display:inline-block;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:5px solid currentColor;transition:transform .12s;flex:0 0 auto}
.wx_disclosure_chevron.open{transform:rotate(90deg)}
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
.wx_field_label{display:inline-flex;align-items:center}
.wx_limits{border:1px solid rgba(237,108,2,.4);border-radius:12px;padding:12px 16px;background:rgba(237,108,2,.06);display:flex;flex-direction:column;gap:8px}
.wx_limits_title{font-weight:600;font-size:13px;color:#ed6c02;display:flex;align-items:center;gap:6px}
.wx_limits ol{margin:0;padding-left:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.6}
.wx_limits li{margin-bottom:4px}`;
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
			const [promptOpen, setPromptOpen] = react.useState(false);

			const refresh = react.useCallback(() => {
				api("/status").then((r) => {
					if (!r.ok) return;
					setStatus(r.body);
					const firstUser = r.body.users && r.body.users[0];
					// Fill the form once — only when first entering the page.
					// Polling below only ever calls setStatus; user edits stay
					// locally until Save, and are only re-synced when the user
					// refreshes the page or after a successful save/relogin/
					// logout (which all call refresh() explicitly).
					setForm((prev) => prev ?? {
						baseUrl: r.body.config?.baseUrl ?? "",
						cdnBaseUrl: r.body.config?.cdnBaseUrl ?? "",
						botType: r.body.config?.botType ?? "",
						cwd: r.body.config?.cwd ?? "",
						textChunkLimit: String(r.body.config?.textChunkLimit ?? ""),
						cardTimeoutMs: String(r.body.config?.cardTimeoutMs ?? ""),
						crossSessionNotify: !!r.body.config?.crossSessionNotify,
						surfacePromptEnabled: !!r.body.config?.surfacePromptEnabled,
						surfacePrompt: r.body.config?.surfacePrompt ?? "",
						silent: !!(firstUser && firstUser.silent),
					});
				}).catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
			}, [refresh]);

			// Poll /status while the login flow is in flight. The host's
			// `/relogin` resets phase to `idle` synchronously and then fires
			// the async QR generation — a single refresh right after the
			// action returns still sees `idle` and the QR never appears
			// until the user manually refreshes. Same after a successful
			// scan: phase transitions `waiting-qr → scaned → logged-in`
			// happen on the host without any in-flight action the client
			// can wait on. Polling at 2s while in any non-terminal phase
			// (`idle` / `waiting-qr` / `scaned` / `failed`) keeps the
			// section in sync; the interval stops automatically once the
			// user reaches `logged-in` (the only true terminal state for
			// the login flow — `failed` is kept in the poll set so a
			// retried relogin picks up the next phase change).
			react.useEffect(() => {
				const phase = status?.phase;
				if (phase === "logged-in") return undefined;
				const id = setInterval(() => {
					refresh();
				}, 2000);
				return () => clearInterval(id);
			}, [status?.phase, refresh]);

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
							surfacePromptEnabled: !!form.surfacePromptEnabled,
							surfacePrompt: form.surfacePrompt,
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
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.surfacePromptEnabled, onChange: (e) => setForm({ ...form, surfacePromptEnabled: e.target.checked }) }),
							createElement("span", null, "微信渠道提示词"),
							createElement(HelpTip, { text: "开启后，最近一条用户消息来自微信时会把下方提示词注入 agent 的 runtime context；GUI 发消息时自动隐藏。也可用微信 /surface on|off 切换。" }),
						),
						(status?.users && status.users.length === 0) ? createElement("span", { className: "wx_meta" }, "（暂无绑定用户，静默将在首条微信消息后生效）") : null,
					),
					form ? createElement("div", { className: "wx_form", style: { marginTop: "4px" } },
						createElement("div", { className: "wide wx_prompt_field" },
							createElement("button", {
								type: "button",
								className: "wx_disclosure",
								onClick: () => setPromptOpen((open) => !open),
								"aria-expanded": promptOpen,
							},
								createElement("span", { className: "wx_disclosure_chevron" + (promptOpen ? " open" : "") }),
								createElement("span", { className: "wx_field_label" }, "微信渠道提示词正文",
									createElement(HelpTip, { text: "仅在设置页编辑。微信消息驱动会话时注入到 runtime context；留空等于关闭注入。" })),
							),
							promptOpen
								? createElement("textarea", {
									value: form.surfacePrompt,
									onChange: set("surfacePrompt"),
									placeholder: "你正在通过微信(WeChat)与用户聊天…",
								})
								: null,
						),
					) : null,
					msg.text ? createElement("div", { className: msg.kind === "err" ? "wx_err" : "wx_ok" }, msg.text) : null,
					createElement("div", { className: "wx_row", style: { marginTop: "8px" } },
						createElement("button", { className: "wx_btn primary", onClick: saveConfig, disabled: busy !== "" || !form }, busy === "config" ? "…" : "保存配置"),
						createElement("div", { style: { marginLeft: "auto", display: "flex", gap: "8px" } },
							createElement("button", { className: "wx_btn", onClick: () => run("/relogin"), disabled: busy !== "" }, busy === "/relogin" ? "…" : "重新扫码"),
							createElement("button", { className: "wx_btn danger", onClick: () => { if (confirm("确定退出微信登录？")) run("/logout"); }, disabled: busy !== "" }, busy === "/logout" ? "…" : "退出登录"),
						),
					),
				),
				createElement("div", { className: "wx_limits" },
					createElement("div", { className: "wx_limits_title" },
						createElement("span", null, "⚠"),
						createElement("span", null, "已知限制"),
					),
					createElement("ol", null,
						createElement("li", null, "微信 iLink 通道限制：bot 单窗口最多连续向同一用户发送 10 条消息，达到上限后必须由用户在微信端主动发一条消息才能解锁并继续推送（超过的部分会进 /next 缓存队列）。"),
						createElement("li", null, "用户最后一次在微信端发消息后的 24 小时内 bot 可以主动向其发送消息，超过 24 小时未互动则需要用户先在微信发一条消息才能继续接收 bot 回复（微信平台策略，非本插件限制）。"),
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
