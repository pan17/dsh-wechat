/**
 * dsh-wechat client half — Settings → WeChat page.
 *
 * Authored directly in the DSH client module format (window.__ModuleLoader__),
 * the same delivery shape as dsh-mcp-manager's prebuilt client bundle: the
 * host-side client-modules service serves this file at /plugins/dsh-wechat/
 * client.js and the browser kernel loads it. Communicates with the host
 * through the plugin's own HTTP API (/wechat/api/*) registered on the GUI
 * webserver — no @deepseek-ai imports at runtime.
 *
 * Layout: one status card (login state, QR, session actions) followed by
 * collapsible groups. A group owns the fields that belong together — the
 * 打字合并 switch and its three window parameters share one group — so the
 * page shows six one-line summaries instead of fifteen controls at once.
 * Collapse state is per-browser (localStorage), never persisted host-side.
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

		/** localStorage key holding the set of expanded group ids. */
		const OPEN_KEY = "dsh-wechat/settings-open";
		/** localStorage key holding whether the 指令帮助 sheet was left open. */
		const HELP_OPEN_KEY = "dsh-wechat/help-open";

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
.wx_dirty{font-size:12px;color:#ed6c02}
.wx_qr img{width:200px;height:200px;border:1px solid #eee;border-radius:8px}
.wx_form{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wx_form label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.wx_form input,.wx_form textarea{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;width:100%;box-sizing:border-box}
.wx_form input:disabled,.wx_form textarea:disabled{opacity:.55}
.wx_form textarea{min-height:88px;resize:vertical;line-height:1.45}
.wx_form .wide{grid-column:1 / -1}
.wx_field_label{display:flex;align-items:center;white-space:nowrap;min-width:0;overflow:hidden}
.wx_key{font:inherit;font-size:11px;padding:0 4px;border-radius:4px;background:rgba(128,128,128,.16);color:var(--dsw-alias-label-secondary,#888);margin-left:6px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.wx_toggles{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px}
.wx_toggles.single{grid-template-columns:1fr}
.wx_toggles .wx_check{min-width:0;align-items:flex-start;line-height:1.45}
.wx_toggles .wx_check input{margin-top:1px;flex:0 0 auto}
.wx_toggles .wx_check span{min-width:0}
.wx_help{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:14px;height:14px;border-radius:50%;background:rgba(128,128,128,.22);color:var(--dsw-alias-label-secondary,#888);font-size:10px;font-weight:600;cursor:help;margin-left:6px;vertical-align:middle;position:relative;user-select:none;line-height:1}
.wx_help:hover,.wx_help:focus{background:rgba(128,128,128,.42);outline:none;color:inherit}
.wx_help_float{position:fixed;z-index:10000;padding:6px 10px;background:rgba(20,20,20,.92);color:#fff;font-size:11px;font-weight:400;white-space:pre-wrap;width:max-content;max-width:min(340px,calc(100vw - 16px));border-radius:6px;line-height:1.5;text-align:left;pointer-events:none;overflow-wrap:anywhere;box-shadow:0 4px 16px rgba(0,0,0,.28)}
.wx_divider{height:1px;background:rgba(128,128,128,.2);margin:2px 0}
.wx_groups{display:flex;flex-direction:column;gap:2px}
.wx_group{border-bottom:1px solid rgba(128,128,128,.14);padding:2px 0}
.wx_group:last-child{border-bottom:none}
.wx_group_head{display:flex;align-items:center;gap:8px;width:100%;font:inherit;font-size:13px;color:inherit;background:none;border:none;padding:9px 2px;cursor:pointer;text-align:left}
.wx_group_head:hover{opacity:.85}
.wx_group_head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1976d2);outline-offset:2px;border-radius:6px}
.wx_group_title{font-weight:600;flex:0 0 auto}
.wx_group_summary{font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;padding-left:10px}
.wx_group_body{display:flex;flex-direction:column;gap:10px;padding:2px 2px 12px}
.wx_group_desc{font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.55}
.wx_sub{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;background:rgba(128,128,128,.06);border:1px solid rgba(128,128,128,.16)}
.wx_sub_off{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.wx_limits{border:1px solid rgba(237,108,2,.4);border-radius:12px;padding:8px 16px 12px;background:rgba(237,108,2,.06);display:flex;flex-direction:column;gap:6px}
.wx_limits_title{font-weight:600;font-size:13px;color:#ed6c02;display:flex;align-items:center;gap:6px}
.wx_limits ol{margin:0;padding-left:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.6}
.wx_limits li{margin-bottom:4px}
.wx_help_panel{max-height:360px;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.55;padding:10px 12px;border:1px solid rgba(128,128,128,.25);border-radius:8px;background:rgba(128,128,128,.06)}
.wx_help_sheet{display:flex;flex-direction:column;gap:10px;max-height:440px;overflow:auto;padding:10px 12px;border:1px solid rgba(128,128,128,.25);border-radius:8px;background:rgba(128,128,128,.04)}
.wx_help_intro{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888)}
.wx_help_tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:sticky;top:0;padding:8px 0;background:linear-gradient(rgba(128,128,128,.04),rgba(128,128,128,.04)),var(--dsw-alias-bg-layer-1,#fff);z-index:1}
.wx_help_search{font:inherit;font-size:12px;padding:5px 9px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;flex:1 1 150px;min-width:0}
.wx_help_toggle{cursor:pointer;font:inherit;font-size:11px;padding:4px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;white-space:nowrap}
.wx_help_toggle:hover{background:rgba(128,128,128,.12)}
.wx_help_empty{font-size:12px;padding:10px 2px;color:var(--dsw-alias-label-secondary,#888)}
.wx_help_retry{cursor:pointer;font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;margin-top:6px}
.wx_help_footer{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888);border-top:1px solid rgba(128,128,128,.18);padding-top:8px}
.wx_cmd_group{display:flex;flex-direction:column;gap:2px}
.wx_cmd_group_title{font-size:12px;font-weight:700;margin-top:4px}
.wx_cmd_group_blurb{font-size:11px;color:var(--dsw-alias-label-secondary,#888);margin-bottom:2px}
.wx_cmd{border-bottom:1px solid rgba(128,128,128,.12)}
.wx_cmd:last-child{border-bottom:none}
.wx_cmd_head{display:flex;align-items:baseline;gap:6px;width:100%;font:inherit;font-size:12px;color:inherit;padding:7px 2px;cursor:pointer;text-align:left;flex-wrap:wrap}
.wx_cmd_head:hover{opacity:.85}
.wx_cmd_open{display:inline-flex;align-items:center;gap:5px;font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer}
.wx_cmd_open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1976d2);outline-offset:2px;border-radius:6px}
.wx_cmd_name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:700;flex:0 0 auto}
.wx_cmd_alias{font-size:11px;color:var(--dsw-alias-label-secondary,#888);flex:0 0 auto}
.wx_cmd_sum{flex:1 1 140px;min-width:0;font-size:12px;line-height:1.5}
.wx_cmd_body{display:flex;flex-direction:column;gap:6px;padding:0 2px 10px 12px}
.wx_cmd_usage{font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary,#888);line-height:1.5;overflow-wrap:anywhere}
.wx_cmd_example{display:flex;flex-direction:column;gap:1px}
.wx_cmd_example_line{cursor:pointer;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;padding:3px 7px;border-radius:6px;border:1px solid rgba(128,128,128,.24);background:rgba(128,128,128,.08);color:inherit;text-align:left;overflow-wrap:anywhere;width:100%;box-sizing:border-box}
.wx_cmd_example_line:hover{background:rgba(128,128,128,.18)}
.wx_cmd_example_note{font-size:11px;color:var(--dsw-alias-label-secondary,#888);line-height:1.5;padding-left:2px}
.wx_cmd_more{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}
.wx_cmd_copied{font-size:11px;color:#2e7d32}
@media (max-width:560px){.wx_form{grid-template-columns:1fr}.wx_toggles{grid-template-columns:1fr}}`;
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

		/** Read one JSON value from localStorage. Storage failures are non-fatal. */
		function readStore(key) {
			try {
				if (typeof window === "undefined" || !window.localStorage) return null;
				const raw = window.localStorage.getItem(key);
				if (!raw) return null;
				return JSON.parse(raw);
			} catch (e) {
				return null;
			}
		}

		function writeStore(key, value) {
			try {
				if (typeof window === "undefined" || !window.localStorage) return;
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch (e) {
				// Private mode / quota: the control still works, it just does not
				// remember across reloads.
			}
		}

		/** Expanded group ids, read once per mount. */
		function loadOpenGroups() {
			const parsed = readStore(OPEN_KEY);
			return parsed && typeof parsed === "object" ? parsed : {};
		}

		function storeOpenGroups(next) {
			writeStore(OPEN_KEY, next);
		}

		/** Whether 指令帮助 was left expanded; a settings page that forgets this
		 * re-collapses under the user every time they come back. */
		function loadHelpOpen() {
			return readStore(HELP_OPEN_KEY) === true;
		}

		function storeHelpOpen(open) {
			writeStore(HELP_OPEN_KEY, !!open);
		}

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
		/**
		 * The "?" badge.
		 *
		 * `text` is both the tooltip body and (by default) the accessible name.
		 * A command row passes a short `label` instead: its tooltip is a
		 * multi-line example list, and announcing all of it as the button name
		 * would turn one control into a paragraph for a screen reader.
		 *
		 * `onActivate` makes a click do something as well as hover: a touch
		 * screen has no hover, and a "?" that does nothing when tapped is worse
		 * than no "?" at all.
		 */
		function HelpTip(props) {
			const text = props.text;
			const label = props.label || text;
			react.useEffect(() => () => removeHelpFloat(), []);
			const show = (e) => placeHelpFloat(e.currentTarget, text);
			const hide = () => removeHelpFloat();
			return createElement("span", {
				className: "wx_help",
				role: "button",
				tabIndex: 0,
				"aria-label": label,
				// No `title`: the browser's native tooltip would open next to
				// (and on top of) the portaled bubble, so every hover showed
				// the same text twice. `aria-label` still names the control.
				onMouseDown: (e) => e.stopPropagation(),
				onClick: (e) => {
					e.stopPropagation();
					if (props.onActivate) props.onActivate(e);
				},
				onMouseEnter: show,
				onMouseLeave: hide,
				onFocus: show,
				onBlur: hide,
			}, "?");
		}

		/**
		 * The tooltip body for one command row: the first two examples plus a
		 * count, because the full list can run to eleven lines and a hover
		 * bubble that tall is unreadable (and gets flipped off-screen).
		 */
		function tooltipFor(entry) {
			const shown = entry.examples.slice(0, 2);
			const lines = shown.map((example) => example.line + "  —  " + example.note);
			if (entry.examples.length > shown.length) {
				lines.push("共 " + entry.examples.length + " 条示例，展开查看全部");
			}
			return lines.join("\n");
		}

		/** Copy helper: clipboard API, then the legacy path, then select the text. */
		function copyText(text, node) {
			const fallbackSelect = () => {
				try {
					const range = document.createRange();
					range.selectNodeContents(node);
					const selection = window.getSelection();
					if (!selection) return;
					selection.removeAllRanges();
					selection.addRange(range);
				} catch (e) {
					// Nothing left to try; the text is visible and selectable by hand.
				}
			};
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).catch(fallbackSelect);
					return;
				}
			} catch (e) {
				// Fall through to the legacy path.
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				document.execCommand("copy");
				area.remove();
			} catch (e) {
				fallbackSelect();
			}
		}

		/** One command row: header (click to expand) + the full example list. */
		function CommandRow(props) {
			const entry = props.entry;
			const open = !!props.open;
			const [copied, setCopied] = react.useState("");
			const bodyId = "wx_cmd_" + entry.id;
			const copy = (example) => (e) => {
				e.stopPropagation();
				copyText(example.line, e.currentTarget);
				setCopied(example.line);
			};
			const examples = entry.examples.map((example, i) =>
				createElement("div", { className: "wx_cmd_example", key: entry.id + "_" + i },
					createElement("button", {
						type: "button",
						className: "wx_cmd_example_line",
						onClick: copy(example),
						title: "点击复制这条",
					}, example.line),
					createElement("div", { className: "wx_cmd_example_note" },
						example.note,
						copied === example.line ? createElement("span", { className: "wx_cmd_copied" }, " · 已复制") : null,
					),
				),
			);
			return createElement("div", { className: "wx_cmd" },
				createElement("div", {
					className: "wx_cmd_head",
					onClick: () => props.onToggle(entry.id),
				},
					createElement("button", {
						type: "button",
						className: "wx_cmd_open",
						onClick: (e) => {
							e.stopPropagation();
							props.onToggle(entry.id);
						},
						"aria-expanded": open,
						"aria-controls": bodyId,
						title: open ? "收起示例" : "展开全部示例",
					},
						createElement("span", { className: "wx_disclosure_chevron" + (open ? " open" : "") }),
						createElement("span", { className: "wx_cmd_name" }, entry.command),
					),
					entry.aliases.length > 0
						? createElement("span", { className: "wx_cmd_alias" }, "(" + entry.aliases.join(", ") + ")")
						: null,
					createElement("span", { className: "wx_cmd_sum" }, entry.summary),
					createElement(HelpTip, {
						text: tooltipFor(entry),
						label: "查看 " + entry.command + " 的用法示例",
						onActivate: () => props.onToggle(entry.id),
					}),
				),
				open
					? createElement("div", { className: "wx_cmd_body", id: bodyId },
						entry.usage ? createElement("div", { className: "wx_cmd_usage" }, entry.usage) : null,
						...examples,
					)
					: null,
			);
		}

		/**
		 * The 指令帮助 sheet.
		 *
		 * Renders the host's plain-language catalog (`/wechat/api/help` →
		 * `catalog`) grouped by what the user is trying to do. The old
		 * behaviour — dumping `formatHelp()`'s grammar table — stays as the
		 * fallback for a host that predates the catalog.
		 */
		function HelpSheet(props) {
			const catalog = props.catalog;
			const [query, setQuery] = react.useState("");
			const [expanded, setExpanded] = react.useState({});
			const [allOpen, setAllOpen] = react.useState(false);
			const needle = query.trim().toLowerCase().replace(/^\//, "");
			const matches = (entry) => {
				if (!needle) return true;
				const haystack = [
					entry.command,
					entry.aliases.join(" "),
					entry.summary,
					entry.usage,
					entry.examples.map((example) => example.line + " " + example.note).join(" "),
				].join(" ").toLowerCase();
				return haystack.includes(needle);
			};
			const groups = catalog.groups
				.map((group) => ({
					group,
					entries: catalog.commands.filter((entry) => entry.group === group.id && matches(entry)),
				}))
				.filter((bucket) => bucket.entries.length > 0);
			const isOpen = (id) => (allOpen ? true : !!expanded[id]);
			const toggle = (id) => {
				if (allOpen) {
					// Leaving "all open" keeps the row the user just clicked open,
					// so the click still feels like it did something.
					setAllOpen(false);
					setExpanded((prev) => ({ ...prev, [id]: true }));
					return;
				}
				setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
			};
			return createElement("div", { className: "wx_help_sheet" },
				createElement("div", { className: "wx_help_intro" }, catalog.intro),
				createElement("div", { className: "wx_help_tools" },
					createElement("input", {
						className: "wx_help_search",
						value: query,
						onChange: (e) => setQuery(e.target.value),
						placeholder: "搜索指令，如「模型」「会话」「/merge」",
						"aria-label": "搜索指令",
					}),
					createElement("button", {
						type: "button",
						className: "wx_help_toggle",
						onClick: () => {
							setAllOpen(!allOpen);
							setExpanded({});
						},
					}, allOpen ? "全部收起" : "全部展开"),
				),
				groups.length === 0
					? createElement("div", { className: "wx_help_empty" }, "没有找到包含「" + query.trim() + "」的指令。换个说法试试，或者清空搜索框。")
					: null,
				groups.map((bucket) =>
					createElement("div", { className: "wx_cmd_group", key: bucket.group.id },
						createElement("div", { className: "wx_cmd_group_title" }, bucket.group.title),
						createElement("div", { className: "wx_cmd_group_blurb" }, bucket.group.blurb),
						bucket.entries.map((entry) =>
							createElement(CommandRow, {
								key: entry.id,
								entry: entry,
								open: isOpen(entry.id),
								onToggle: toggle,
							}),
						),
					),
				),
				createElement("div", { className: "wx_help_footer" }, catalog.footer),
			);
		}

		/**
		 * One collapsible settings group.
		 *
		 * The header is a real <button> (keyboard reachable, `aria-expanded`
		 * announced); the summary is what makes a collapsed group readable —
		 * it is derived from live form state, never a static string, so a
		 * collapsed page still reports the actual values.
		 */
		function Group(props) {
			const open = !!props.open;
			const bodyId = "wx_group_" + props.id;
			return createElement("div", { className: "wx_group" },
				createElement("button", {
					type: "button",
					className: "wx_group_head",
					onClick: () => props.onToggle(props.id),
					"aria-expanded": open,
					"aria-controls": bodyId,
				},
					createElement("span", { className: "wx_disclosure_chevron" + (open ? " open" : "") }),
					createElement("span", { className: "wx_group_title" }, props.title),
					createElement("span", { className: "wx_group_summary" }, props.summary || ""),
				),
				open
					? createElement("div", { className: "wx_group_body", id: bodyId },
						props.desc ? createElement("div", { className: "wx_group_desc" }, props.desc) : null,
						props.children,
					)
					: null,
			);
		}

		function api(path, options) {
			return fetch("/wechat/api" + path, {
				headers: { "Content-Type": "application/json" },
				...options,
			}).then(async (resp) => ({ ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) }));
		}

		/**
		 * The exact body posted to `/wechat/api/config`.
		 *
		 * Kept as one pure function of `form` for two reasons: the dirty
		 * marker has to compare like-for-like with what Save would send, and
		 * a field that is missing here silently saves nothing while the panel
		 * still reports success (see tests/client-panel-wiring.test.ts).
		 */
		function payloadOf(form) {
			return {
				cwd: form.cwd.trim(),
				cardTimeoutMs: Number(form.cardTimeoutMs) || undefined,
				crossSessionNotify: !!form.crossSessionNotify,
				notifyTaskEvents: !!form.notifyTaskEvents,
				silent: !!form.silent,
				finalOnly: !!form.finalOnly,
				mergeEnabled: !!form.mergeEnabled,
				mergeSuffixTokens: !!form.mergeSuffixTokens,
				mediaMergeEnabled: !!form.mediaMergeEnabled,
				mediaAtRefEnabled: !!form.mediaAtRefEnabled,
				allowRemotePermissionEscalation: !!form.allowRemotePermissionEscalation,
				allowAnyFilePath: !!form.allowAnyFilePath,
				// Same blank-means-undefined rule as the rate limit: an
				// empty box must leave the stored value alone instead of
				// sending 0 (which is meaningful for mergeSilenceMs).
				mergeSilenceMs: form.mergeSilenceMs.trim() === "" ? undefined : Number(form.mergeSilenceMs),
				mergeMaxMsgs: form.mergeMaxMsgs.trim() === "" ? undefined : Number(form.mergeMaxMsgs),
				mergeForcedReleaseMs: form.mergeForcedReleaseMs.trim() === "" ? undefined : Number(form.mergeForcedReleaseMs),
				mediaHoldMs: form.mediaHoldMs.trim() === "" ? undefined : Number(form.mediaHoldMs),
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
			};
		}

		const onOff = (value) => (value ? "开" : "关");
		const minutes = (ms) => {
			const n = Number(ms);
			if (!Number.isFinite(n) || n <= 0) return "未设置";
			return n % 60000 === 0 ? `${n / 60000} 分钟` : `${Math.round(n / 1000)} 秒`;
		};
		const bytes = (value) => {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) return "未设置";
			if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
			return `${Math.round(n / 1024)} KiB`;
		};

		/** Allowlist size as the user sees it: blank means "no restriction". */
		function allowlistSummary(raw) {
			const ids = String(raw || "")
				.split(/[\n,]+/)
				.map((entry) => entry.trim())
				.filter((entry) => entry !== "");
			return ids.length === 0 ? "白名单 不限" : `白名单 ${ids.length} 个`;
		}

		function WechatSection() {
			const [status, setStatus] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [msg, setMsg] = react.useState({ kind: "", text: "" });
			// Editable form state (initialized from status.config).
			const [form, setForm] = react.useState(null);
			const [openGroups, setOpenGroups] = react.useState(loadOpenGroups);
			const [helpOpen, setHelpOpen] = react.useState(loadHelpOpen);
			// `helpText` is the verbatim `/help` reply (the fallback panel);
			// `helpCatalog` is the plain-language view the sheet renders when
			// the host is new enough to send one.
			const [helpText, setHelpText] = react.useState("");
			const [helpCatalog, setHelpCatalog] = react.useState(null);
			const [helpBusy, setHelpBusy] = react.useState(false);
			const [helpError, setHelpError] = react.useState("");
			// Serialized payload the host last confirmed; `null` until the form
			// is filled. Refs do not re-render, so `dirty` is recomputed from
			// it on every render the form state triggers.
			const baselineRef = react.useRef(null);

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
						mediaMergeEnabled: !!r.body.config?.mediaMergeEnabled,
						mediaHoldMs: String(r.body.config?.mediaHoldMs ?? ""),
						mediaAtRefEnabled: !!r.body.config?.mediaAtRefEnabled,
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

			// Baseline for the dirty marker: the first filled form, then every
			// successful save. `refresh()` never rewrites the form, so the
			// user's in-progress edits stay "dirty" until they actually save.
			react.useEffect(() => {
				if (form && baselineRef.current === null) {
					baselineRef.current = JSON.stringify(payloadOf(form));
				}
			}, [form]);

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
						body: JSON.stringify(payloadOf(form)),
					});
					if (!r.ok) {
						setMsg({ kind: "err", text: r.body.message || `保存失败 (HTTP ${r.status})` });
						setBusy("");
						return;
					}
					baselineRef.current = JSON.stringify(payloadOf(form));
					setMsg({ kind: "ok", text: r.body.message || "配置已保存" });
					refresh();
				} catch (e) {
					setMsg({ kind: "err", text: String(e) });
				}
				setBusy("");
			};

			const toggleGroup = (id) => {
				setOpenGroups((prev) => {
					const next = { ...prev, [id]: !prev[id] };
					storeOpenGroups(next);
					return next;
				});
			};

			const phase = status?.phase ?? "idle";
			const badgeClass = phase === "logged-in" ? "ok" : phase === "failed" ? "err" : "wait";
			const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
			const isOpen = (id) => !!openGroups[id];
			const dirty = !!form && baselineRef.current !== null && JSON.stringify(payloadOf(form)) !== baselineRef.current;

			/**
			 * Fetch the help payload once, then reuse it.
			 *
			 * The host answers with `{ text, catalog }`: `catalog` drives the
			 * sheet, `text` is the verbatim `/help` reply kept as the fallback
			 * for a host that predates the catalog. A failed request keeps the
			 * error so the panel can offer a retry instead of silently showing
			 * an empty box.
			 */
			const loadHelp = react.useCallback(async () => {
				setHelpBusy(true);
				setHelpError("");
				try {
					const r = await api("/help");
					const body = r.body || {};
					if (r.ok && body.catalog && Array.isArray(body.catalog.commands)) {
						setHelpCatalog(body.catalog);
						if (typeof body.text === "string") setHelpText(body.text);
					} else if (r.ok && typeof body.text === "string" && body.text) {
						setHelpText(body.text);
					} else {
						setHelpError(body.message || `无法加载命令帮助 (HTTP ${r.status})`);
					}
				} catch (e) {
					setHelpError(String(e));
				}
				setHelpBusy(false);
			}, []);

			const toggleHelp = () => {
				const next = !helpOpen;
				setHelpOpen(next);
				storeHelpOpen(next);
				if (next && !helpCatalog && !helpText) loadHelp();
			};

			// The sheet's open state survives a reload, so a page that mounts
			// already-open has to fetch without waiting for a click.
			react.useEffect(() => {
				if (helpOpen && !helpCatalog && !helpText && !helpBusy && !helpError) loadHelp();
			}, [helpOpen, helpCatalog, helpText, helpBusy, helpError, loadHelp]);

			// ── Collapsed-group summaries (derived from live form state) ──
			const mergeSummary = form
				? (form.mergeEnabled
					? `已开启 · 静默 ${form.mergeSilenceMs || "?"}ms · 上限 ${form.mergeMaxMsgs || "?"} 条 · 强制 ${minutes(form.mergeForcedReleaseMs)}`
					: "已关闭 · 每条消息各自一轮")
				: "";
			const deliverySummary = form
				? `静默 ${onOff(form.silent)} · 结论 ${onOff(form.finalOnly)} · 决策推送 ${onOff(form.crossSessionNotify)} · 任务提醒 ${onOff(form.notifyTaskEvents)}`
				: "";
			const mediaSummary = form
				? (form.mediaMergeEnabled
					? `合并 开 · 等待 ${minutes(form.mediaHoldMs)} · ${form.mediaAtRefEnabled ? "@引用" : "路径"}`
					: `合并 关 · 附件各自一轮 · ${form.mediaAtRefEnabled ? "@引用" : "路径"}`)
				: "";
			const connectionSummary = form
				? `${form.cwd || "未设置目录"} · 卡片 ${minutes(form.cardTimeoutMs)} · 限流 ${form.sendWechatRateLimitPerMinute || "不限"}/分 · ${allowlistSummary(form.allowedUsers)}`
				: "";
			const promptSummary = form
				? (form.surfacePromptEnabled ? `已开启 · ${form.surfacePrompt.trim().length} 字` : "已关闭 · 不注入")
				: "";
			const securitySummary = form
				? (() => {
					const relaxed = [
						form.allowRemotePermissionEscalation ? "远程放宽权限" : "",
						form.allowAnyFilePath ? "任意路径发送" : "",
					].filter(Boolean);
					const tail = `文件上限 ${bytes(form.maxOutgoingFileBytes)}`;
					return relaxed.length ? `已放宽：${relaxed.join("、")} · ${tail}` : `默认收紧 · ${tail}`;
				})()
				: "";

			/**
			 * The expanded help area.
			 *
			 * Three states, in priority order: the plain-language sheet (host
			 * sent a catalog), the verbatim `/help` text (older host), and a
			 * loading/error box with a retry. The text fallback is deliberately
			 * kept — a settings page that renders nothing is indistinguishable
			 * from a broken plugin.
			 */
			const renderHelp = () => {
				if (helpCatalog) return createElement(HelpSheet, { catalog: helpCatalog });
				if (helpText) return createElement("div", { className: "wx_help_panel" }, helpText);
				if (helpBusy) return createElement("div", { className: "wx_help_panel" }, "正在加载命令帮助…");
				return createElement("div", { className: "wx_help_panel" },
					helpError || "暂无命令说明",
					createElement("div", null,
						createElement("button", { type: "button", className: "wx_help_retry", onClick: loadHelp }, "重试"),
					),
				);
			};

			return createElement("div", { className: "wx_section" },
				createElement("div", { className: "wx_card" },
					// ── Status block: login state, QR, session actions ──
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
					helpOpen ? renderHelp() : null,
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
						createElement("button", { className: "wx_btn danger", onClick: () => { if (confirm("确定退出微信登录？")) run("/logout"); }, disabled: busy !== "" }, busy === "/logout" ? "…" : "退出登录"),
						createElement("span", { className: "wx_meta" }, "新安装或者更新本插件后，建议重启DSH再使用"),
					),

					createElement("div", { className: "wx_divider" }),

					// ── Collapsible settings groups ──
					form ? createElement("div", { className: "wx_groups" },
						createElement(Group, {
							id: "connection",
							title: "连接与默认行为",
							summary: connectionSummary,
							desc: "这里决定：新会话在哪个文件夹干活、等你点确认的卡片放多久、它主动给你发消息一天能发多少条，以及谁能用微信指挥它。",
							open: isOpen("connection"),
							onToggle: toggleGroup,
						},
							createElement("div", { className: "wx_form" },
								createElement("label", { className: "wide" },
									createElement("span", { className: "wx_field_label" }, "工作目录",
										createElement("code", { className: "wx_key" }, "cwd"),
										createElement(HelpTip, { text: "微信里新开的会话，默认在哪个文件夹干活。已经用 /workspace 或 /session switch 切过项目的不受影响，仍用你切的。" })),
									createElement("input", { value: form.cwd, onChange: set("cwd"), placeholder: "F:\\work" })),
								createElement("label", null,
									createElement("span", { className: "wx_field_label" }, "卡片超时",
										createElement("code", { className: "wx_key" }, "cardTimeoutMs"),
										createElement(HelpTip, { text: "等你点确认的卡片最多等多久，单位毫秒。默认 1800000 = 30 分钟；超时还没回复，这张卡会自动撤回。改成 1800000 就是一小时。" })),
									createElement("input", { value: form.cardTimeoutMs, onChange: set("cardTimeoutMs"), placeholder: "1800000", inputMode: "numeric" })),
								createElement("label", null,
									createElement("span", { className: "wx_field_label" }, "推送限流",
										createElement("code", { className: "wx_key" }, "sendWechatRateLimitPerMinute"),
										createElement(HelpTip, { text: "它主动给你发消息（send_wechat 工具）每分钟最多几条，默认 10，填 0 = 不限。超了就当场失败并告诉它别刷屏，而不是继续轰炸你。留空 = 保持原来的值。" })),
									createElement("input", { value: form.sendWechatRateLimitPerMinute, onChange: set("sendWechatRateLimitPerMinute"), placeholder: "10", inputMode: "numeric" })),
								createElement("label", { className: "wide" },
									createElement("span", { className: "wx_field_label" }, "入站白名单",
										createElement("code", { className: "wx_key" }, "allowedUsers"),
										createElement(HelpTip, { text: "只允许这些人用微信指挥你的 AI，一行一个微信号（用逗号分开也行）。留空 = 谁先给它发消息谁绑定。填了之后，名单外的人发什么都被忽略，也不回复。自己的微信号可以发 /status 看。" })),
									createElement("textarea", { value: form.allowedUsers, onChange: set("allowedUsers"), placeholder: "（留空 = 不限制）" })),
							),
						),

						createElement(Group, {
							id: "delivery",
							title: "消息推送",
							summary: deliverySummary,
							desc: "决定微信里出现多少内容、什么时候出现。想安静一点，先关「静默」不够就开「结论模式」。",
							open: isOpen("delivery"),
							onToggle: toggleGroup,
						},
							createElement("div", { className: "wx_toggles" },
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.crossSessionNotify, onChange: (e) => setForm({ ...form, crossSessionNotify: e.target.checked }) }),
									createElement("span", null, "跨会话决策推送"),
									createElement(HelpTip, { text: "别的会话（不是你现在聊的这个）需要你拍板的权限卡、提问卡，也整张推到微信，你可以直接回复。默认关闭。" })),
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.notifyTaskEvents, onChange: (e) => setForm({ ...form, notifyTaskEvents: e.target.checked }) }),
									createElement("span", null, "跨会话任务完成提醒"),
									createElement(HelpTip, { text: "别的会话的任务做完或者报错了，也用微信提醒你一声。跟上面的决策推送互相独立，默认关闭。" })),
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.silent, onChange: (e) => setForm({ ...form, silent: e.target.checked }) }),
									createElement("span", null, "静默"),
									createElement(HelpTip, { text: "打开后每轮只发它最后那段回复。关掉后，思考过程和工具调用会合成一条「执行过程」一起发过来，能看到它每一步在干什么。微信端也能用 /silent on|off 切换，和这里同一个值。" })),
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.finalOnly, onChange: (e) => setForm({ ...form, finalOnly: e.target.checked }) }),
									createElement("span", null, "结论模式"),
									createElement(HelpTip, { text: "整件事彻底做完，只发一条最终结论；中间自动续跑再多轮也只发一条。权限卡、提问卡、报错照样立刻发，不会被压住。它停手 45 秒后交付，最长 10 分钟一定发一次；等不及就发 /flush 立刻取回。打开后比「静默」更强。微信端也能用 /final on|off 切换，和这里同一个值。" })),
							),
						),

						createElement(Group, {
							id: "merge",
							title: "打字合并",
							summary: mergeSummary,
							desc: "一句话分几段发的时候，把连着几条合成一轮，免得每一段都单独跑一轮。默认关闭：打开后每条消息会多等几秒。",
							open: isOpen("merge"),
							onToggle: toggleGroup,
						},
							createElement("label", { className: "wx_check" },
								createElement("input", { type: "checkbox", checked: !!form?.mergeEnabled, onChange: (e) => setForm({ ...form, mergeEnabled: e.target.checked }) }),
								createElement("span", null, "打字合并"),
								createElement(HelpTip, { text: "默认关闭：每条微信消息各自跑一轮。打开后，你连着发的几条会等你停手几秒再合成一轮（一句话分几段发不用跑好几轮）。消息末尾加 `..` 表示还要接着说，加 `!!` 表示马上提交；图片和文件不参与合并。微信端也能用 /merge on|off 切换，和这里同一个值。" })),
							createElement("div", { className: "wx_sub" },
								form.mergeEnabled
									? null
									: createElement("div", { className: "wx_sub_off" }, "开启「打字合并」后，下面这些参数才生效。"),
								createElement("div", { className: "wx_form" },
									createElement("label", null,
										createElement("span", { className: "wx_field_label" }, "静默窗口",
											createElement("code", { className: "wx_key" }, "mergeSilenceMs"),
											createElement(HelpTip, { text: "你停手多久之后就把已发的几条合成一轮，单位毫秒，默认 3000 = 3 秒。填 0 等于关掉合并（每条消息各自一轮，和 /merge off 一样）。" })),
										createElement("input", { value: form.mergeSilenceMs, onChange: set("mergeSilenceMs"), placeholder: "3000", inputMode: "numeric", disabled: !form?.mergeEnabled })),
									createElement("label", null,
										createElement("span", { className: "wx_field_label" }, "条数上限",
											createElement("code", { className: "wx_key" }, "mergeMaxMsgs"),
											createElement(HelpTip, { text: "一批最多攒几条，默认 10 条。攒够就立刻发出去，防止一直堆着不发。" })),
										createElement("input", { value: form.mergeMaxMsgs, onChange: set("mergeMaxMsgs"), placeholder: "10", inputMode: "numeric", disabled: !form?.mergeEnabled })),
									createElement("label", null,
										createElement("span", { className: "wx_field_label" }, "强制放行",
											createElement("code", { className: "wx_key" }, "mergeForcedReleaseMs"),
											createElement(HelpTip, { text: "最多憋多久，单位毫秒，默认 180000 = 3 分钟。到点不管怎样都发出去，宁可分成两轮，也不会让你的消息一直卡着。" })),
										createElement("input", { value: form.mergeForcedReleaseMs, onChange: set("mergeForcedReleaseMs"), placeholder: "180000", inputMode: "numeric", disabled: !form?.mergeEnabled })),
								),
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.mergeSuffixTokens, onChange: (e) => setForm({ ...form, mergeSuffixTokens: e.target.checked }), disabled: !form?.mergeEnabled }),
									createElement("span", null, "合并后缀 `..` / `!!`"),
									createElement(HelpTip, { text: "要不要认消息末尾的 `..`（继续追加，先别发）和 `!!`（马上提交）。打开时这两个符号会从正文里去掉；关掉后它们只是普通文字。" })),
							),
						),

						createElement(Group, {
							id: "media",
							title: "图片与文件",
							summary: mediaSummary,
							desc: "图片或文件与随后一条文字合并为同一轮；并决定附件的呈现方式：可点击的 @引用，或一行文件路径。两者默认关闭。",
							open: isOpen("media"),
							onToggle: toggleGroup,
						},
							createElement("label", { className: "wx_check" },
								createElement("input", { type: "checkbox", checked: !!form?.mediaMergeEnabled, onChange: (e) => setForm({ ...form, mediaMergeEnabled: e.target.checked }) }),
								createElement("span", null, "图片/文件与文字合并发送"),
								createElement(HelpTip, { text: "默认关闭：图是图、话是话，分两轮跑，AI 先看到图再看到你的问题。打开后，没配文字的图片/文件/视频会先等一等，等你下一条文字到达时合成一轮发出去，AI 一次就同时拿到图和「图要它做什么」。图下面自带文字时照旧立刻发；语音不参与；等太久（见下面「附件等待」）就先单独发出去，不会一直挂着。微信端也能用 /media on|off 切换，和这里同一个值。" })),
							createElement("div", { className: "wx_sub" },
								form.mediaMergeEnabled
									? null
									: createElement("div", { className: "wx_sub_off" }, "开启「图片/文件与文字合并发送」后，下面的等待时间才生效；交付措辞一直生效。"),
								createElement("div", { className: "wx_form" },
									createElement("label", null,
										createElement("span", { className: "wx_field_label" }, "附件等待",
											createElement("code", { className: "wx_key" }, "mediaHoldMs"),
											createElement(HelpTip, { text: "图片/文件最多等你多久，单位毫秒，默认 180000 = 3 分钟。等到还没等来那句话就先单独发出去——没人提问的图也值得看一眼，通道更不能一直挂着。实际等待取它和「打字合并 → 强制放行」里更短的那个。" })),
										createElement("input", { value: form.mediaHoldMs, onChange: set("mediaHoldMs"), placeholder: "180000", inputMode: "numeric", disabled: !form?.mediaMergeEnabled })),
								),
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.mediaAtRefEnabled, onChange: (e) => setForm({ ...form, mediaAtRefEnabled: e.target.checked }) }),
									createElement("span", null, "以 @引用 方式交给 AI"),
									createElement(HelpTip, { text: "关闭（默认）：附件写作「文件已保存到: 路径」一行普通路径，任何环境均可正常阅读。打开：写作 @路径（路径含空格时加引号），在桌面端是可点击的引用，但需要宿主挂载文件引用功能；未挂载时只会显示一行 @C:/…。两种写法都只告知 AI 文件位置，不会把文件内容写入对话，大文件同样如此。文件均先保存到本机。微信端可用 /media at|path 切换。" })),
							),
						),

						createElement(Group, {
							id: "prompt",
							title: "微信渠道提示词",
							summary: promptSummary,
							desc: "给 AI 加一句「你现在是在微信里跟人聊天」的说明，它回话会更短、更像聊天。只在微信发来的那一轮生效，在桌面端打字时自动不生效。",
							open: isOpen("prompt"),
							onToggle: toggleGroup,
						},
							createElement("label", { className: "wx_check" },
								createElement("input", { type: "checkbox", checked: !!form?.surfacePromptEnabled, onChange: (e) => setForm({ ...form, surfacePromptEnabled: e.target.checked }) }),
								createElement("span", null, "微信渠道提示词"),
								createElement(HelpTip, { text: "打开后，微信发来的那一轮会带上下面这段话，让它知道自己在微信里跟你聊天；在桌面端打字时不会带上。微信端也能用 /surface on|off 切换。" })),
							createElement("div", { className: "wx_form" },
								createElement("label", { className: "wide" },
									createElement("span", { className: "wx_field_label" }, "提示词正文",
										createElement("code", { className: "wx_key" }, "surfacePrompt"),
										createElement(HelpTip, { text: "只在这个页面里改。微信发消息时这段文字会一起带给 AI；留空就等于不注入。" })),
									createElement("textarea", {
										value: form.surfacePrompt,
										onChange: set("surfacePrompt"),
										placeholder: "你正在通过微信(WeChat)与用户聊天…",
										disabled: !form?.surfacePromptEnabled,
									})),
							),
						),

						createElement(Group, {
							id: "security",
							title: "安全边界",
							summary: securitySummary,
							desc: "默认全部关着，也就是权限最小的状态。下面任何一项打开，都等于让一条微信消息获得更大的本机权限，请确认你真的需要。",
							open: isOpen("security"),
							onToggle: toggleGroup,
						},
							createElement("div", { className: "wx_toggles single" },
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.allowRemotePermissionEscalation, onChange: (e) => setForm({ ...form, allowRemotePermissionEscalation: e.target.checked }) }),
									createElement("span", null, "允许微信放宽全局默认权限"),
									createElement(HelpTip, { text: "默认关闭：在微信里发 /perm default 只能把默认权限调严，不能调松（danger-full-access 这种放开的会被拒绝）。因为那个默认值是对所有新会话生效的，跟微信无关，属于提权，只该在本机设置页点。当前会话的 /perm switch 不受影响。确实需要远程改全局默认时才打开。" })),
								createElement("label", { className: "wx_check" },
									createElement("input", { type: "checkbox", checked: !!form?.allowAnyFilePath, onChange: (e) => setForm({ ...form, allowAnyFilePath: e.target.checked }) }),
									createElement("span", null, "允许 send_wechat 发送任意路径"),
									createElement(HelpTip, { text: "默认关闭：AI 只能把你当前项目里的文件发到微信，别处的一律拒绝。打开后它能把电脑上任意文件发给你——只在你确实需要时才打开。" })),
							),
							createElement("div", { className: "wx_form" },
								createElement("label", null,
									createElement("span", { className: "wx_field_label" }, "外发文件上限",
										createElement("code", { className: "wx_key" }, "maxOutgoingFileBytes"),
										createElement(HelpTip, { text: "它发文件给你时的大小上限，单位字节，默认 20971520 = 20 MiB。超了就直接拒绝，不会先读进内存。" })),
									createElement("input", { value: form.maxOutgoingFileBytes, onChange: set("maxOutgoingFileBytes"), placeholder: "20971520", inputMode: "numeric" })),
							),
						),
					) : null,

					msg.text ? createElement("div", { className: msg.kind === "err" ? "wx_err" : "wx_ok" }, msg.text) : null,
					createElement("div", { className: "wx_row", style: { marginTop: "4px" } },
						createElement("button", { className: "wx_btn primary", onClick: saveConfig, disabled: busy !== "" || !form }, busy === "config" ? "…" : "保存配置"),
						dirty ? createElement("span", { className: "wx_dirty" }, "● 有未保存的修改") : null,
						(status?.users && status.users.length === 0) ? createElement("span", { className: "wx_meta" }, "（暂无绑定用户也可保存，重新扫码后仍然生效）") : null,
					),
				),

				// ── Platform limits: informational, collapsible for the same reason ──
				createElement("div", { className: "wx_limits" },
					createElement("button", {
						type: "button",
						className: "wx_group_head",
						onClick: () => toggleGroup("limits"),
						"aria-expanded": isOpen("limits"),
						"aria-controls": "wx_group_limits",
					},
						createElement("span", { className: "wx_disclosure_chevron" + (isOpen("limits") ? " open" : "") }),
						createElement("span", { className: "wx_limits_title" },
							createElement("span", null, "⚠"),
							createElement("span", null, "已知限制"),
						),
						createElement("span", { className: "wx_group_summary" }, isOpen("limits") ? "" : "2 条微信平台限制"),
					),
					isOpen("limits")
						? createElement("ol", { id: "wx_group_limits" },
							createElement("li", null, "微信 iLink 通道限制：bot 单窗口最多连续向同一用户发送 10 条消息，达到上限后必须由用户在微信端主动发一条消息才能解锁并继续推送（超过的部分会进 /next 缓存队列）。"),
							createElement("li", null, "用户最后一次在微信端发消息后的 24 小时内 bot 可以主动向其发送消息，超过 24 小时未互动则需要用户先在微信发一条消息才能继续接收 bot 回复（微信平台策略，非本插件限制）。"),
						)
						: null,
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
