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
.wx_actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.wx_help_btn{cursor:pointer;font:inherit;font-size:13px;font-weight:700;padding:7px 14px 7px 10px;border-radius:999px;border:none;background:#1976d2;color:#fff;display:inline-flex;align-items:center;gap:6px;line-height:1;box-shadow:0 2px 8px rgba(25,118,210,.35);animation:wx_help_pulse 1.4s ease-out 4}
.wx_help_btn:hover{background:#1565c0}
.wx_help_btn.open{background:#0d47a1;animation:none}
.wx_help_btn_icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.22);font-size:12px;font-weight:800}
@keyframes wx_help_pulse{0%{box-shadow:0 0 0 0 rgba(25,118,210,.55)}70%{box-shadow:0 0 0 12px rgba(25,118,210,0)}100%{box-shadow:0 2px 8px rgba(25,118,210,.35)}}
.wx_check{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 0}
.wx_check input{width:16px;height:16px}
.wx_user{border:1px solid rgba(128,128,128,.2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.wx_user_head{font-weight:600;font-size:12px;word-break:break-all}
.wx_toggle{display:flex;align-items:center;gap:8px;font-size:12px}
.wx_help{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:rgba(128,128,128,.22);color:var(--dsw-alias-label-secondary,#888);font-size:10px;font-weight:600;cursor:help;margin-left:6px;vertical-align:middle;position:relative;user-select:none;line-height:1}
.wx_help:hover,.wx_help:focus{background:rgba(128,128,128,.42);outline:none;color:inherit}
.wx_help_float{position:fixed;z-index:10000;padding:6px 10px;background:rgba(20,20,20,.92);color:#fff;font-size:11px;font-weight:400;white-space:normal;width:max-content;max-width:min(260px,calc(100vw - 16px));border-radius:6px;line-height:1.5;text-align:left;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.28)}
.wx_field_label{display:inline-flex;align-items:center}
.wx_limits{border:1px solid rgba(237,108,2,.4);border-radius:12px;padding:12px 16px;background:rgba(237,108,2,.06);display:flex;flex-direction:column;gap:8px}
.wx_limits_title{font-weight:600;font-size:13px;color:#ed6c02;display:flex;align-items:center;gap:6px}
.wx_limits ol{margin:0;padding-left:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.6}
.wx_limits li{margin-bottom:4px}
.wx_help_panel{max-height:360px;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.55;padding:10px 12px;border:1px solid rgba(128,128,128,.25);border-radius:8px;background:rgba(128,128,128,.06)}`;
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=\"dsh-wechat/section\"]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-wechat";
				tag.dataset.pluginCss = "dsh-wechat/section";
				document.head.appendChild(tag);
			}
			tag.textContent = css;
		}

		const PHASE_LABEL = {
			idle: "未登录",
			"waiting-qr": "等待扫码",
			scaned: "已扫码，待确认",
			"logged-in": "已登录",
			failed: "登录失败",
		};

		// Small "?" badge. Tooltips are portaled to document.body so the
		// settings dialog's overflow:hidden cannot clip them (cwd sits at
		// the top-left of the card).
		let helpFloatEl = null;
		function removeHelpFloat() {
			if (helpFloatEl) {
				helpFloatEl.remove();
				helpFloatEl = null;
			}
		}
		function placeHelpFloat(trigger, text) {
			removeHelpFloat();
			const float = document.createElement("div");
			float.className = "wx_help_float";
			float.setAttribute("role", "tooltip");
			float.textContent = text;
			document.body.appendChild(float);
			helpFloatEl = float;
			const r = trigger.getBoundingClientRect();
			const w = float.offsetWidth;
			const h = float.offsetHeight;
			const gap = 8;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			let left = r.left + r.width / 2 - w / 2;
			left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
			const below = r.bottom + gap;
			const above = r.top - h - gap;
			let top = below;
			if (below + h > vh - 8 && above >= 8) top = above;
			top = Math.min(Math.max(8, top), Math.max(8, vh - h - 8));
			float.style.top = top + "px";
			float.style.left = left + "px";
		}
		function HelpTip(props) {
			const text = props.text;
			react.useEffect(() => () => removeHelpFloat(), []);
			const show = (e) => placeHelpFloat(e.currentTarget, text);
			const hide = () => removeHelpFloat();
			return createElement("span", {
				className: "wx_help",
				role: "button",
				tabIndex: 0,
				"aria-label": text,
				onMouseDown: (e) => e.stopPropagation(),
				onClick: (e) => e.stopPropagation(),
				onMouseEnter: show,
				onMouseLeave: hide,
				onFocus: show,
				onBlur: hide,
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
			const [helpOpen, setHelpOpen] = react.useState(false);
			const [helpText, setHelpText] = react.useState("");
			const [helpBusy, setHelpBusy] = react.useState(false);

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
					// Silent is global (config.json). Fall back to the bound
					// user only for older hosts that have not yet added
					// config.silent.
					setForm((prev) => prev ?? {
						cwd: r.body.config?.cwd ?? "",
						cardTimeoutMs: String(r.body.config?.cardTimeoutMs ?? ""),
						crossSessionNotify: !!r.body.config?.crossSessionNotify,
						notifyTaskEvents: !!r.body.config?.notifyTaskEvents,
						surfacePromptEnabled: !!r.body.config?.surfacePromptEnabled,
						surfacePrompt: r.body.config?.surfacePrompt ?? "",
						silent: !!(r.body.config?.silent ?? (firstUser && firstUser.silent)),
						finalOnly: !!r.body.config?.finalOnly,
						mergeEnabled: !!r.body.config?.mergeEnabled,
						mergeSilenceMs: String(r.body.config?.mergeSilenceMs ?? ""),
						mergeMaxMsgs: String(r.body.config?.mergeMaxMsgs ?? ""),
						mergeForcedReleaseMs: String(r.body.config?.mergeForcedReleaseMs ?? ""),
						mergeSuffixTokens: !!r.body.config?.mergeSuffixTokens,
						allowRemotePermissionEscalation: !!r.body.config?.allowRemotePermissionEscalation,
						allowAnyFilePath: !!r.body.config?.allowAnyFilePath,
						maxOutgoingFileBytes: String(r.body.config?.maxOutgoingFileBytes ?? ""),
						sendWechatRateLimitPerMinute: String(r.body.config?.sendWechatRateLimitPerMinute ?? ""),
						allowedUsers: (r.body.config?.allowedUsers ?? []).join("\n"),
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
							cwd: form.cwd.trim(),
							cardTimeoutMs: Number(form.cardTimeoutMs) || undefined,
							crossSessionNotify: !!form.crossSessionNotify,
							notifyTaskEvents: !!form.notifyTaskEvents,
							silent: !!form.silent,
							finalOnly: !!form.finalOnly,
							mergeEnabled: !!form.mergeEnabled,
							mergeSuffixTokens: !!form.mergeSuffixTokens,
							allowRemotePermissionEscalation: !!form.allowRemotePermissionEscalation,
							allowAnyFilePath: !!form.allowAnyFilePath,
							// Same blank-means-undefined rule as the rate limit: an
							// empty box must leave the stored value alone instead of
							// sending 0 (which is meaningful for mergeSilenceMs).
							mergeSilenceMs: form.mergeSilenceMs.trim() === "" ? undefined : Number(form.mergeSilenceMs),
							mergeMaxMsgs: form.mergeMaxMsgs.trim() === "" ? undefined : Number(form.mergeMaxMsgs),
							mergeForcedReleaseMs: form.mergeForcedReleaseMs.trim() === "" ? undefined : Number(form.mergeForcedReleaseMs),
							maxOutgoingFileBytes: form.maxOutgoingFileBytes.trim() === "" ? undefined : Number(form.maxOutgoingFileBytes),
							// An empty string must NOT become 0 (which means
							// "unlimited") — `Number("")` is 0, so the blank
							// case is mapped to undefined and the stored value
							// is left alone.
							sendWechatRateLimitPerMinute: form.sendWechatRateLimitPerMinute.trim() === ""
								? undefined
								: Number(form.sendWechatRateLimitPerMinute),
							allowedUsers: form.allowedUsers
								.split(/[\n,]+/)
								.map((entry) => entry.trim())
								.filter((entry) => entry !== ""),
							surfacePromptEnabled: !!form.surfacePromptEnabled,
							surfacePrompt: form.surfacePrompt,
						}),
					});
					if (!r.ok) {
						setMsg({ kind: "err", text: r.body.message || `保存失败 (HTTP ${r.status})` });
						setBusy("");
						return;
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

			const toggleHelp = async () => {
				if (helpOpen) {
					setHelpOpen(false);
					return;
				}
				setHelpOpen(true);
				if (helpText) return;
				setHelpBusy(true);
				try {
					const r = await api("/help");
					if (r.ok && typeof r.body.text === "string" && r.body.text) {
						setHelpText(r.body.text);
					} else {
						setHelpText(r.body.message || `无法加载命令帮助 (HTTP ${r.status})`);
					}
				} catch (e) {
					setHelpText(String(e));
				}
				setHelpBusy(false);
			};

			return createElement("div", { className: "wx_section" },
				createElement("div", { className: "wx_card" },
					createElement("div", { className: "wx_row" },
						createElement("span", { className: "wx_title" }, "WeChat"),
						createElement("span", { className: `wx_badge ${badgeClass}` }, PHASE_LABEL[phase] ?? phase),
						status?.monitorRunning ? createElement("span", { className: "wx_meta" }, "监控运行中") : createElement("span", { className: "wx_meta" }, "监控未运行"),
						createElement("div", { className: "wx_actions" },
							createElement("button", {
								type: "button",
								className: "wx_help_btn" + (helpOpen ? " open" : ""),
								onClick: toggleHelp,
								"aria-expanded": helpOpen,
								title: "查看全部微信指令和说明",
							},
								createElement("span", { className: "wx_help_btn_icon", "aria-hidden": "true" }, "?"),
								helpOpen ? "收起指令" : "指令帮助",
							),
						),
					),
					helpOpen ? createElement("div", { className: "wx_help_panel" }, helpBusy ? "正在加载命令帮助…" : (helpText || "暂无命令说明")) : null,
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
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "cwd",
								createElement(HelpTip, { text: "新会话的工作目录。仅影响未通过 /workspace 或 /session switch 显式切过工作区的用户；显式切过的保留原样。" })),
							createElement("input", { value: form.cwd, onChange: set("cwd"), placeholder: "F:\\work" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "cardTimeoutMs",
								createElement(HelpTip, { text: "提问 / 权限卡软超时（毫秒），默认 1800000（30 分钟）。超时未答复的卡会被自动撤回。" })),
							createElement("input", { value: form.cardTimeoutMs, onChange: set("cardTimeoutMs"), placeholder: "1800000" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "sendWechatRateLimitPerMinute",
								createElement(HelpTip, { text: "agent 主动推送（send_wechat 工具）每分钟上限，默认 10，0 = 不限。超限时工具会明确返回失败并告知模型，而不是继续刷屏。留空 = 保持原值。" })),
							createElement("input", { value: form.sendWechatRateLimitPerMinute, onChange: set("sendWechatRateLimitPerMinute"), placeholder: "10" })),
						createElement("label", { className: "wide" },
							createElement("span", { className: "wx_field_label" }, "allowedUsers",
								createElement(HelpTip, { text: "入站白名单：每行一个微信 user id（也可用逗号分隔）。留空 = 现有行为（首个给你发消息的人成为绑定对端）。填了就只处理名单内的 id，其余在去重/建会话/命令分发之前被拦下并记日志，绝不回复。升级时若本机已有绑定用户，会自动把该用户写入这里并在微信里提示一次（可在 /status 查看自己的 id）。" })),
							createElement("textarea", { value: form.allowedUsers, onChange: set("allowedUsers"), placeholder: "（留空 = 不限制）" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "mergeSilenceMs",
								createElement(HelpTip, { text: "打字合并的静默窗口（毫秒，默认 3000）：连续几条微信消息在这个间隔内到达时合并成一轮；0 = 关闭窗口（每条消息各自一轮，等同 /merge off）。" })),
							createElement("input", { value: form.mergeSilenceMs, onChange: set("mergeSilenceMs"), placeholder: "3000" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "mergeMaxMsgs",
								createElement(HelpTip, { text: "打字合并的硬上限（默认 10 条）：达到即立刻合并发出，防止缓冲区无界增长。" })),
							createElement("input", { value: form.mergeMaxMsgs, onChange: set("mergeMaxMsgs"), placeholder: "10" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "mergeForcedReleaseMs",
								createElement(HelpTip, { text: "打字合并的强制放行上限（毫秒，默认 180000 = 3 分钟）：无论窗口、`..` 暂挂还是上一批仍在投递，到点一定发出——宁可两句话一轮，也不让通道卡死。" })),
							createElement("input", { value: form.mergeForcedReleaseMs, onChange: set("mergeForcedReleaseMs"), placeholder: "180000" })),
						createElement("label", null,
							createElement("span", { className: "wx_field_label" }, "maxOutgoingFileBytes",
								createElement(HelpTip, { text: "send_wechat 发送文件的字节上限（默认 20971520 = 20 MiB）。超过的文件在读取之前就被拒绝。" })),
							createElement("input", { value: form.maxOutgoingFileBytes, onChange: set("maxOutgoingFileBytes"), placeholder: "20971520" })),
					) : null,
					createElement("div", { className: "wx_row", style: { marginTop: "4px" } },
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.crossSessionNotify, onChange: (e) => setForm({ ...form, crossSessionNotify: e.target.checked }) }),
							createElement("span", null, "跨会话决策推送"),
							createElement(HelpTip, { text: "任意会话的权限 / 提问卡整卡推到微信，可直接回复拍板。默认关闭。" })),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.notifyTaskEvents, onChange: (e) => setForm({ ...form, notifyTaskEvents: e.target.checked }) }),
							createElement("span", null, "跨会话任务完成提醒"),
							createElement(HelpTip, { text: "跨会话任务完成或报错时通过微信提醒。独立于决策推送，默认关闭。" })),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.silent, onChange: (e) => setForm({ ...form, silent: e.target.checked }) }),
							createElement("span", null, "静默"),
							createElement(HelpTip, { text: "开启后每轮只发送最后一条助手正文。关闭后，思考与工具调用/结果合并为一条「执行过程」，按桌面端单行条目显示，收到下一段正文首个流式片段时立即推送，正文完成后单独发送；提问/审批卡或轮次结束也会发送待发过程。" }),
						),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.finalOnly, onChange: (e) => setForm({ ...form, finalOnly: e.target.checked }) }),
							createElement("span", null, "结论模式"),
							createElement(HelpTip, { text: "只回最终结论：跨轮次的中间过程一律暂存，整条任务彻底停下来后只发一条最终结论（自动续跑再多轮也只发一条）。权限卡、提问卡、报错始终立即推送，不会被压住。默认静默 45 秒后交付，最长 10 分钟必发一次；想看当前进度可随时在微信发 /flush。开启后优先于「静默」。微信端也可用 /final on|off 切换（与这里同一个值）。" }),
						),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.surfacePromptEnabled, onChange: (e) => setForm({ ...form, surfacePromptEnabled: e.target.checked }) }),
							createElement("span", null, "微信渠道提示词"),
							createElement(HelpTip, { text: "开启后，最近一条用户消息来自微信时会把下方提示词注入 agent 的 runtime context；GUI 发消息时自动隐藏。也可用微信 /surface on|off 切换。" }),
						),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.mergeEnabled, onChange: (e) => setForm({ ...form, mergeEnabled: e.target.checked }) }),
							createElement("span", null, "打字合并"),
							createElement(HelpTip, { text: "默认关闭：每条微信消息各自一轮。开启后连续几条消息会在静默窗口内合并成一轮（一句话分几段发不再烧掉几轮），代价是每条消息多等几秒。消息末尾 `..` 表示还要接着说，`!!` 表示立刻提交；图片/文件不参与合并。微信端也可用 /merge on|off 切换（与这里同一个值）。" }),
						),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.mergeSuffixTokens, onChange: (e) => setForm({ ...form, mergeSuffixTokens: e.target.checked }) }),
							createElement("span", null, "合并后缀 `..` / `!!`"),
							createElement(HelpTip, { text: "是否识别消息末尾的 `..`（继续追加，暂不发出）与 `!!`（立刻提交）。开启时这两个后缀会从正文里去掉。关闭后它们只是普通文本。" }),
						),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.allowRemotePermissionEscalation, onChange: (e) => setForm({ ...form, allowRemotePermissionEscalation: e.target.checked }) }),
							createElement("span", null, "允许微信放宽全局默认权限"),
							createElement(HelpTip, { text: "默认关闭：微信里的 /perm default 只能写入不放宽权限的预设；danger-full-access 或审批为 never 的预设会被拒绝（全局默认写入 DSH 设置，对所有新会话生效，与微信无关，属于提权，请在本机设置页操作）。会话级 /perm switch 不受影响。仅在确实需要远程改全局默认时才开启。" }),
						),
						createElement("label", { className: "wx_check" },
							createElement("input", { type: "checkbox", checked: !!form?.allowAnyFilePath, onChange: (e) => setForm({ ...form, allowAnyFilePath: e.target.checked }) }),
							createElement("span", null, "允许 send_wechat 发送任意路径"),
							createElement(HelpTip, { text: "默认关闭：send_wechat 只能发送调用会话工作目录或已注册工作区内的文件，其余路径一律拒绝（否则该工具就是任意文件读取原语）。仅在确实需要时才开启。" }),
						),
						(status?.users && status.users.length === 0) ? createElement("span", { className: "wx_meta" }, "（暂无绑定用户也可保存，重新扫码后仍然生效）") : null,
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
									placeholder: "你正在通过微信(WeChat)与用户聊天…",								})
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
			// Park the registration on the plugin's fiber. `slots.inject`
			// returns a disposer; dropping it leaves the WeChat panel
			// registered after the plugin is unloaded (and re-registering on
			// the next load stacks a duplicate entry). `ctx.effect` is the
			// documented owner for exactly this (see ui-sidebar-terminal /
			// ui-sidebar-files), with the plain call kept as a fallback for a
			// client kernel that predates it.
			const register = () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "wechat",
				order: 40,
				label: "WeChat",
			}, WechatSection));
			if (ctx.effect) ctx.effect(register);
			else register();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
