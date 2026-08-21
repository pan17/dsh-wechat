# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.5.5] - 2026-08-21

### Added

- 繁忙时投递行为（与 DSH 同源）：agent 运行中收到微信消息时，按 DSH 设置 `ui-conversation.busyEnter`（GUI 通用设置的「繁忙时 Enter 键行为」）决定投递方式——`queue`（默认）走 `agent.followup` 排队下一轮，`steer` 走 `agent.steer` 立即插入运行中轮次的最近 step 边界（窗口已关闭时由 AgentLoop 自动降级为下一次唤醒的排队轮，消息不丢）；空闲会话始终新开一轮，与 GUI「空闲 Enter=Queue」语义一致。媒体消息同路径覆盖
- 新增 `/enter queue|steer|status` 微信命令（别名 `/busy`，支持 `排队`/`插话` 中文参数）：直接读写 DSH 设置文档 `ui-conversation` 命名空间（`$DSH_HOME/settings.yaml`），与 GUI 设置页双端共用同一事实源、实时互见；设置服务缺失/命名空间未注册时读回落 `queue`（等同旧行为）、写提示降级；卡片等待时可 bypass 执行
- `/status` 新增 `• 繁忙投递: queue（排队）/ steer（插话）` 一行；帮助与 README 命令表同步
- `DshOps.busyEnter()/saveBusyEnter()`：结构化读取/写入 host settings（`get(ns)` resolved 值 + `update(ns, patch)`），异常隔离回落

## [0.5.4] - 2026-08-20

### Fixed

- 设置页 `WeChat` 卡片的 `跨会话通知` 与 `静默` 开关勾选后 1-2 秒回弹、来不及保存：`src/client.js` 移除 3 秒轮询对表单的强制覆写（`setInterval(refresh, 3000)` + 每次 `refresh` 无条件 `setForm({crossSessionNotify/silent: server值})`），改为仅在进入页面时初始化一次（`prev ??`），后续仅在 `保存配置` / `重新扫码` / `重连` / `退出登录` 成功后显式 `refresh()`，本地编辑直到保存前不再被覆盖

## [0.5.3] - 2026-08-20

### Added

- 新增 `/history [数量]` 微信命令：查看当前会话最近历史消息，默认 5 条、最多 20 条（`/history`→5、`/history 10`→10、`/history 30`→20，`0`/`abc` 等非法参数回 `用法: /history [数量]（1-20，默认 5）`）；按时间升序渲染为 `序号 [时间] 角色: 摘要`（`你`/`助手`），单条超 300 字截断为 `…`，自动走 `sendReply` 的 `splitText`/`10条限流`与 `/next` 缓存；无会话/空历史友好提示；帮助与 `isBypassSlashCommand` 同步、去重 `history`，卡片等待时仍可执行
- `DshOps.getSessionHistory(sessionId, limit)`：优先读内存 `agents.get(sessionId).session.events`，回落 `sessionQuery.listEvents` 持久化日志，兼容 `data.message.content[]` / `data.content` / `data.text` 等多形态抽取，异常隔离回空

## [0.5.2] - 2026-08-20

### Changed

- `/reasoning` 命令语法统一为 `list | default | switch <等级>`，与 `/workspace`、`/session`、`/preset`、`/model`、`/perm` 一致；裸等级名（如 `/reasoning high`）不再被识别为切换，需显式 `/reasoning switch high`；帮助与 `/reasoning list` 提示同步更新
- 设置页 `WeChat` 卡片的 `cwd`、`textChunkLimit`、`cardTimeoutMs`、`跨会话通知`、`静默` 字段标签后新增 `?` 图标，hover/键盘聚焦弹出黑色气泡说明字段语义（纯 CSS 实现，无新依赖）

## [0.5.1] - 2026-08-19

### Added

- 跨会话通知（单用户单闸，默认关闭）：后台会话的已完成（`turn/end`）、报错（`agent/error`）、审批/提问卡通过微信提醒，卡片与完成/报错共用同一开关；新增微信命令 `/notify on|off|status`（别名 `/watch`），与网页设置同源
- `/status` 新增 `• 跨会话通知: on/off` 一行（单用户单闸）
- 设置页 `设置 → WeChat` 合并为单卡：连接表单（`baseUrl / cdnBaseUrl / botType / cwd / textChunkLimit / cardTimeoutMs`）+ `跨会话通知`（全局）与 `静默` 开关同卡，按 **保存配置** 统一落盘；状态与用户数同卡显示

### Changed

- 跨会话通知收敛为单用户单闸：`shouldNotifyCrossSession` 仅看全局 `config.crossSessionNotify`，`inherit/on/off` 的每用户分流已移除；`/notify` 直接读写全局并落 `config.json`
- 设置页由 3 卡收敛为 1 大卡，文案精简，单用户场景不再展示多用户列表

### Fixed

- 关闭跨会话后，网页回答提问仍向微信推送 `✅ 提问已回答` / `🔒 权限结果` 的回声：`approval/resolved` 与 `question/resolved` 现同样受 `crossSessionNotify` 总闸门控
- 网页 `静默` 勾选即时 `已更新` 的不一致：改为与 `跨会话通知` 同为保存才生效（`POST /wechat/api/config` + `POST /wechat/api/user {silent}` 一次保存）
- 网页 `POST /wechat/api/user/:id` 的 `405`：移除对 `req.method` 的硬校验，新增 `POST /wechat/api/user` 直达路由（`{userId, silent}`），`prefix` 与 `exact` 双注册兜底

## [0.5.0] - 2026-08-19

### Added

- 原生 slash 命令接入：微信消息先查询 DSH 的 `ctx.commands` 注册中心
  （`@deepseek-ai/dsh-commands`），命中的命令（`/plan`、`/goal`、
  `/compact` 等）走原生 handler，与 GUI 同款命令管线、回执、日志生命周期；
  DSH 加新命令 bundle 微信端零改动自动可用
- `/status` 末尾的"会话级状态"段：通过 `ctx.sessionProjections.snapshot()`
  通用读取 DSH 全部 session-level projection（plan mode、goal、
  tokenUsage、contextPressure、sessionStats、imageLimits、permissions
  等），按 `[模式]` / `[用量与统计]` / `[会话]` / `[其它]` 四段显示，
  每个已知 key 走专有 smart renderer（`on` / `active · ship · 3/64 轮`
  / `192.0k / 1.0M（18%）` 等），未知 key 走 JSON fallback
- `parseCommandName(text)` —— DSH 命令注册中心 `parseCommand()` 的
  最小 wire 镜像；用于"未知 shape 命令"探测

### Changed

- `/status` 输出末尾的"会话级状态"段重写：从平铺的
  `• key: {...json}` 改为分组 + smart formatter 形态：`plan` 行显示
  `on`/`off` 而不是 `{active:true,pending:false}` JSON；`contextPressure`
  显示 `192k / 1M (18%)` 而不是 raw token 数字；`sessionStats` 拆多行
  显示 turns/steps/timing；`null` 显示为 `（无）`、空 title 显示为
  `（未设标题）`、`subagentTiming.settledMs=0` 显示为 `未结算` —— 视觉
  层次清晰、单位换算
- `/help` 输出末尾加 `── DSH 原生命令（当前 profile 已注册）──` 段：
  动态列出当前 profile 注册的 `/xxx` 命令，本地白名单里已有的名字不
  重复出现
- README "与 DSH 原生命令同步" 段折叠到 `<details>` 下，README 顶部一眼
  只剩命令表

### Fixed

- 修复原生命令 dispatch 的 shape bug：`ctx.commands.execute()` 返回
  `{commandId, result: CommandResult}` 嵌套结构，第一版代码读
  `result.kind` 顶层（undefined）→ 错误地走 error 分支 → 显示
  `⚠️ 命令出错：Enter or leave plan mode`（plan-mode description），
  而用户输入 `/plan` 实际已进入 plan mode。修后读
  `execution.result.kind` / `execution.result.text`，并把 success 无 text
  的 fallback 从 description 改为 `✅ <name>`，避免 description 误入
  success 路径

### Removed

- `/compact` 本地特殊路径：`handleCompactCommand` 方法、
  `parseCompactCommand` 函数、`CompactCommand` 类型、`/compact` 在本地
  命令表的行——由 `tryNativeCommand` generic 路径统一处理

## [0.4.3] - 2026-08-19

### Fixed

- 提问/审批卡待处理时输入 slash 命令会被吞为卡片回复：
  `handleMessage` 在收到 `question/requested` 或 `approval/requested` 帧后
  把下一条文本当成卡片答案（`handleQuestionReply` /
  `handleApprovalReply`）。之前只有 `/help`/`/rp`/`/rq`/`/stop`（仅
  question）有"提前命令"分支，其它已识别的管理命令会被强解释为卡片
  答案——`/next` 在提问卡上被当成 custom-text 答案提交给 agent，
  `/next` 在审批卡上变成"unrecognized reply"警告。修复：新增
  `isBypassSlashCommand(text)` 把所有管理命令（`/next`、`/silent`、
  `/status`、`/workspace`、`/session`、`/preset`、`/model`、`/perm`、
  `/reasoning`、`/compact`、`/help`）纳入 bypass 集合；在
  `handleMessage` 顶部统一算 `bypassCard`，两个卡分支前置条件追加
  `&& !bypassCard` 让命令走原有 slash 命令解析路径。`/rp`、`/rq`、
  `/stop` 仍是卡专属语义，留在卡片处理器里保持原行为。

## [0.4.2] - 2026-08-18

### Fixed

- 微信/GUI 提示词自动注入失效：`agent/inbox/spliced` 事件在每条消息的
  生命周期内会发两次——enqueue（`inserted=[wx-msg-...]`）和
  `inbox.claim`（`inserted=[]`，纯删除）；旧逻辑在第二次 splice 里把
  刚设的 `"wechat"` 标记用 `markSessionSource("gui")` 覆盖掉，导致
  `dsh-wechat-surface` 的 `text` 回调在 prompt assembly 时永远读到
  `"gui"` → 微信消息也返回空上下文 → 两端都看不到提示词。修复：只有
  `inserted.length > 0`（真正有新消息入队）时才更新 source 标记，
  `inbox.claim` 的纯删除 splice 不再触碰 marker

- 动态上下文 `text` 回调改为三路取 sessionId（`agent.session.header.id
  ?? agent.session.id ?? agent.id`），兼容 DSH Agent 形状漂移；
  `surface-prompt.test.ts` 新增 enqueue+claim 的 regression test
  验证 `wechat → claim → 仍然 wechat` 不会翻成 `gui`

## [0.4.1] - 2026-08-18

### Added

- iLink `sendtyping` 原生「正在输入」提示：agent 处理一轮时微信端显示
  native typing indicator，与 `/status` 的 `agent.status` 同步——开启于
  `agent/inbox/spliced`（next-turn，无论消息来源是微信还是 GUI，对绑定的
  微信用户来说都在等回复），关闭于 `turn/end` / `agent/error` /
  `bridge.stop()`。长轮次每 10 秒自动续期 typing 防止微信客户端自动隐藏；
  2 分钟 TTL safety net 兜底。`getconfig` 拿 `typing_ticket`，缓存 5 分钟；
  所有失败 best-effort 吞掉，不影响主流程

### Changed

- `send_wechat` 工具解除会话绑定要求：任何会话的 agent 都能调用；
  未绑定会话的消息回退到首个已知微信用户（保持单用户部署默认行为，
  与既有 `recipientForSession` 一致）；无任何微信用户时返回明确错误

### Fixed

- 非当前会话的卡提醒永久吞掉的 bug：之前
  `notifiedCardSessions` 只在 `/session switch` 进该会话时清掉，
  在 GUI 端 / 微信回复 / 超时 / `/rp` `/rq` 解决卡时不会清，导致
  后续同一会话的提问/权限卡永远不再发微信提醒。改为：每次
  `removeApprovalCard` / `removeQuestionCard` 后，若该会话已无
  pending 卡则清掉标记——同一批次仍然只提醒一次，跨批次会再提醒
- 设置页 → WeChat 的「保存配置」按钮显示为纯黑（无文字可见）：
  原样式用 `--dsw-alias-button-primary-fill` / `--dsw-alias-brand-primary-invert`
  主题变量，部分主题下两者都解析为黑色，导致文字与底色同色。改为
  直接用 `#1976d2` / `#fff` 高对比度配色，不再依赖主题变量

## [0.4.0] - 2026-08-17

### Added

- `/compact` 微信 slash 命令：手动触发当前会话历史压缩，
  与 GUI `/compact` 走同一注册 handler（dsh-command-compact），
  共享 `command/run` ↔ `command/done` 日志生命周期，复用其
  `ManualCompactionError` 全部分类（busy/cancelled/changed/summary/
  commit/persistence）的本地化提示，微信不重复实现错误翻译

## [0.3.2] - 2026-08-17

### Fixed

- `/reasoning` 命令误用 `llm.resolveModel(...)` 拿到旧版 llm 服务接口；
  `dsh-llm@0.1.0-rc.6` 的 `LlmRuntime` 只暴露 `resolveModelInfo`，旧名调用
  抛 TypeError 被 try/catch 吞掉，永远显示"当前模型不支持推理等级"
  （Web GUI 同款命令正常），改为 `resolveModelInfo` 后与 GUI 数据同源

## [0.3.1] - 2026-08-15

### Fixed

- 微信图片保存为真实格式扩展名：iLink 协议不声明图片格式，此前统一保存
  为 `image.jpg`，PNG/WebP/GIF 原图会出现"扩展名 .jpg 但实际是 PNG"的
  误标；现在按文件头（magic bytes）检测真实格式（png/jpg/gif/webp）保存

## [0.3.0] - 2026-08-15

### Added

- `/session new` 复用当前工作区空白会话（与 GUI「新建会话」同款
  "reuse-or-create its blank session"）：当前会话空白则保持，否则复用该
  工作区最新空白会话，无空白才新建

### Changed

- 微信创建的会话 id 与 GUI 统一为 `session-<uuid>`（不再用 `wx-` 前缀），
  新旧会话在列表/工作区/日志导出中完全一致；存量 `wx-` 会话不受影响
- `/workspace list` 会话数不再统计已归档会话

### Fixed

- `/s list`（及 `/s list current`、`/s switch` 编号）不再显示 GUI 已归档
  的会话（与 GUI 侧边栏同规则，dsh-workspace `archivedSessionIds`）

## [0.2.0] - 2026-08-15

### Added

- 微信渠道提示词动态注入：agent 系统提示（runtime context）在微信消息
  驱动会话时注入"你正在通过微信(WeChat)与用户聊天"，GUI 消息驱动时自动
  消失——按消息来源（`agent/inbox/spliced` 入队时判定）动态切换，任何
  会话（GUI/微信创建、新旧）一视同仁

### Fixed

- 微信渠道提示词不再受 preset `complete` section 替换影响（改用
  `systemPrompt.context()` 注册，sections 的 complete 替换不会波及）
- GUI 消息后微信提示词残留一轮的问题（来源标记从 `user/message` echo
  提前到 `agent/inbox/spliced` 入队时，早于 agent 组装系统提示）

## [0.1.2] - 2026-08-15

### Added

- `/s list` 按最近活动排序并显示相对时间（刚刚/X 分钟前/X 小时前，与 GUI
  侧边栏同源）；重启后从会话日志恢复活动时间（冷启动恢复）

### Fixed

- 非当前会话的卡不再劫持微信消息：`/s list` 等 slash 命令在卡属于其他
  会话时正常工作（卡回复只对当前会话的卡生效）
- 卡片提醒去重时序：context token 缺失（重启后）时不标记已提醒，避免
  后续同一会话的提醒被去重吞掉

## [0.1.1] - 2026-08-15

### Added

- `/reasoning` 命令：查看/设置模型推理等级（当前会话实时生效 + 写入 DSH
  默认，与 GUI 模型选择器同步）；`/reasoning list` 列出当前模型支持的
  等级，`/reasoning default` 恢复模型默认
- 审批/提问卡显示会话归属：卡片头部标注 `📂 工作区 · 💬 会话`
- 卡片按当前会话路由：非当前会话的卡只提醒一次（去重），`/session
  switch` 切换到该会话后自动补发；回复（`1`/`2`、`P1=…`、`/rp`、`/rq`）
  只作用于当前会话的卡

### Changed

- `/status` 模型行附当前推理等级
- 微信发送图片/视频使用原生媒体类型（IMedia），聊天内直接显示而非文件
  附件
- 微信视频消息自动下载保存到临时目录并注入路径
- `/status` 显示上下文用量（token-meter `contextPressure` 投影，与 GUI
  同源）

### Fixed

- 微信会话缺少模型选择瀑布导致 `{{model}}` 提示词变量报错
- 微信新建会话未 attach 工作区导致 GUI 侧边栏"未分组"
- 微信会话未挂载 agent preset 导致工具缺失（pwsh 等）
- `/s list` 在微信端换行错乱（改为一行制）

## [0.1.0] - 2026-08-15

### Added

- 微信（iLink bot 协议）↔ DSH 双向桥接：文本/图片/文件/语音消息收发，
  媒体自动下载解密并作为本地路径附件注入
- 微信 slash 命令：`/workspace`、`/session`（含 `list current`）、
  `/preset`、`/model`、`/perm`、`/silent`、`/next`、`/status`、`/stop`、
  `/rp`、`/rq`
- 审批/提问卡双端同卡：订阅原生 `apiProxy.events.mux` 帧流，微信与 GUI
  弹一致卡片，`apiProxy.respond()` 注入决策，谁先回复谁生效
- `send_wechat` 工具：agent 主动推送文本/图片/视频/文件到微信
- DSH 设置页 → WeChat：扫码登录、状态、重连、连接配置
- 二维码登录页 `/wechat/qr`（SVG 二维码，iLink URL 渲染）
- 断点续传：`sync-buf` 与会话映射持久化，重启后自动恢复
- Preset/权限/模型默认值与 GUI 设置页同源同步（DSH 设置文档）
- 微信 10 条/轮发送限制：自动缓存 + `/next` 继续，第 8 条起提醒
