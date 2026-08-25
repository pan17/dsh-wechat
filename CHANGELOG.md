# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.6.5] - 2026-08-26

### Fixed

- iLink `getUpdates` / `sendMessage` 在 `errcode: -14 "session timeout"` 时陷入 60 分钟死循环。原先 monitor 命中 -14 就 pauseSession 60 分钟，60 分钟后重试 `getUpdates` 但**从不重建服务端会话**，立刻再次拿到 -14，再 pause 60 分钟——无限循环。改动沿用 Tencent/openclaw-weixin [PR #161](https://github.com/Tencent/openclaw-weixin/pull/161) 的恢复合约：`src/weixin/monitor.ts` 命中 -14（包括解析得到的 `resp.errcode === -14` **和** undici `InvalidArgumentError: invalid content-length header`——后者的根因是 iLink 对 -14 返回 HTTP 200 + 畸形 Content-Length，body 还没读就抛了）时先调 `ilink/bot/msg/notifystart`（10s timeout）重建服务端会话；成功 → 重置状态 + 5s 后重试；失败 → 指数退避（5s → 10s → 20s → … 封顶 5 min），连续 6 次失败才提示「请重新扫码」；任何成功的 poll 会重置恢复状态，避免单次 -14 拖出的大 backoff 污染未来。`src/weixin/api.ts` 顺手修了上游 [PR #118/#120](https://github.com/Tencent/openclaw-weixin/pull/120) 的手动 `Content-Length` 头（Node 24+ 的 undici 严格校验 body 字节数会抛 `RequestContentLengthMismatchError`，让 fetch 自己算就好）。参考 issue #1
- 新增 `tests/api-session-timeout.test.ts`（8 个用例：谓词匹配 / cause 链 / 环状 cause 不死循环 / 不误报普通 fetch 错 / `getUpdates` 不重试不包装地传播）+ `tests/monitor-session-timeout.test.ts`（7 个用例：parseable -14 与 content-length 错误共走恢复路径、notifyStart 成功后状态重置、失败 backoff 远低于 60 min、正常流量不调 notifyStart、连续两次 -14 都能恢复、6 次持续失败后 re-scan 提示出现）

## [0.6.4] - 2026-08-25

### Changed

- `/s list` 现在显示每条会话实际运行的 Preset（事件感知），而非会话创建时的 header 值；当一条会话在创建后用 `/preset switch cordis` 切到过 cordis 但 header 仍是 standard，会列成「Preset:创造模式」。新增 `src/dsh/session-log.cjs`（多 frame Zstandard，按 `(path, size, mtime)` 缓存，追加只扫尾巴）直接读 `session.jsonl.zstd`，避免走 `sessionQuery.listEvents`（该接口不带 `data.agentPreset`）；`resolveSessionPreset` 接受可选 `cwd`，`/s list` 直接传 header 里的 cwd，每行不再单独查表
- `/status` 把一行 `Preset:` 拆成两行：「当前会话 Preset」跟在 Agent 后，「默认 Preset」放在权限之后；默认与当前会话一致时默认行始终存在，未绑定会话时为「（未绑定）」
- `/preset status` 改为显示全局默认 Preset（与 `/preset list` 同源），不再误读当前会话 live preset；当前会话与全局默认不一致时另起一行「当前会话」

### Added

- 新增 `tests/preset-display.test.ts`（6 个用例）覆盖 `/s list`、`/status`、`/preset status` 的展示合约
- 新增 `tests/session-log.test.ts`（4 个用例）覆盖 `session-log.cjs` 的缓存命中、追加只扫、新切换覆盖旧值
- `scripts/copy-client.mjs` 同步把 `src/dsh/session-log.cjs` 拷到 `dist/dsh/`，避免 tsc 不复制 `.cjs` 造成运行时缺文件

## [0.6.3] - 2026-08-24

### Changed

- `/workspace switch` / `/workspace add` 成功回复补一行「已恢复会话: 名字（完整 id）」；工作区没有可见会话时改说「该工作区暂无会话，发送消息将创建」。恢复时跳过已归档会话
- `/session switch` 成功回复同时带会话名字和完整 id（不再只回 id 前 12 位）
- 去掉桥接日志里的 `typing ended for …`（输入态收起逻辑不变）
- 提问卡 / 权限卡的桥接套壳文案改为中文（回复提示、`/rq` 说明、权限卡标题与选项说明）；DSH 插件给出的题干/选项原文不翻译

## [0.6.2] - 2026-08-24

### Fixed

- 设置页 WeChat 卡点击「重新扫码」后二维码不刷新、扫码成功状态不变：原来只在 mount 和 save/relogin/reconnect/logout 之后单次调 `refresh()`，但 host 的 `/relogin` 同步把 phase 设为 `idle`、再异步 (`void startLoginFlow()`) 启动 QR 生成，客户端那一次 refresh 看到的还是 `idle`；扫码成功阶段 (`waiting-qr → scaned → logged-in`) 也是纯 host 端异步转换，客户端无任何 in-flight action 可等。修法：客户端 `WechatSection` 在 phase 不是 `logged-in` 时每 2 秒轮询一次 `/status`，进入 `logged-in` 后自动停止（和独立 `/wechat/qr` 页面 `setTimeout(poll, 2000)` 一致）。`refresh()` 的 `setForm((prev) => prev ?? ...)` 仍然只在首次填充，轮询不会覆盖用户正在编辑的表单
- DSH 原生命令(`/plan`、`/goal`、`/compact` 等)在微信端全部抛 `⚠️ 命令执行异常：Cannot read properties of undefined (reading 'aborted')`：桥接把 `abort.signal` 当作 `ctx.commands.execute` 的第 3 个参数传入，但 host 实际签名是 `(agent, line, images, signal)` 4 个参数——`signal` 被错误地放到 `images` 槽位里，host 内的 `signal` 形参实际为 `undefined`，于是 `if (signal.aborted)` 那一行立刻炸。修复：调用改为 `execute(agent, line, [], abort.signal)`；同时把 `NativeCommandsSurface` 与 `DshOps.CommandsService` 的 `execute` 签名改为 `(agent, line, images, signal)`，并在 `tests/native-command.test.ts` 增加 1 个回归用例 + 在已有 rawInput 用例里增加 `images`/`signal` 形状断言，防止再次退回到 3-arg 形态
- `/model switch` 把之前 `/reasoning switch` 设过的推理等级 (`reasoningEffort`) 擦掉，导致 `/status`（和 `/reasoning status`）的 `• 模型: X/Y（推理: <name>）` 附注在切模型后消失、`默认` 一行也丢失、`/next` 之后的新会话继承不到 effort：写覆盖项与持久化默认时本就不该覆盖 user 已经选过的 effort（`applyModelOverride` 注释也承诺「`/model switch` does not clear a set effort」），实际实现却没做到。修复分两层：
  - **写时保留**：`handleModelCommand` 的 `switch` 分支先读「覆盖项 → 持久化默认」里的 effort，若新模型 `resolveModelInfo` 仍支持同一个 effort id，则把 `reasoningEffort` 一起写进新的 `selection` / `saveSelection`；不支持则清空（避免 LLM 拿到非法值）。命令回复追加「（推理等级 <name> 保留，用 /reasoning 调整）」一行提示
  - **读时回退**：`resolveEffectiveModel` 在覆盖项缺 effort 但持久化默认对同模型有 effort 时把默认 effort 合并进来——升级前已处于损坏状态的用户无需重新 `/reasoning switch` 也能在 `/status` 立刻看到原本的 effort；仅当 provider/model 一致才回退，避免默认的 effort 串到不同模型上
- 新增 `tests/model-reasoning.test.ts`（11 个用例）覆盖：覆盖项 / 默认优先级排序、新模型支持/不支持 effort、不支持推理能力的模型、`applyModelOverride` 合并契约（无 effort 保留 caller 的、有 effort 覆盖 caller 的）；README `/model` 命令行同步注明「当前推理等级若新模型支持则一并保留，否则清空」
- 设置页 README 描述中的登录阶段标签与代码 `PHASE_LABEL` 对齐（`已扫码，待确认` / `登录失败`，原简写为 `已扫码` / `失败`）

## [0.6.1] - 2026-08-22

### Fixed

- 重启 DSH 后、未先在微信发消息时，Web UI（GUI）触发的 AI 回复静默丢失：外发所需的 iLink `context_token` 此前仅存于内存（只在收到微信入站消息时填充），重启后映射为空 → `sendReply` 顶部守卫直接丢弃绑定会话的每条回复（`send_wechat` 工具同理返回 "user has not messaged yet"），直到用户下一次微信 ping 才恢复。修复分两层：
  - **持久化 + 恢复**：每用户最新 `context_token` 写入 `state.json`（`UserState.lastContextToken`），`start()` / `reconnect()` 时回灌内存映射——重启后无需先发微信即可直接送达；若服务端拒绝已过期的旧 token，发送失败自动转入 `/next` 缓存队列，下一条微信消息到达时补发
  - **不再静默丢弃**：彻底无 token（未登录 / 从未有微信交互）时，`sendReply` 改为把格式化分段后的回复暂存 outboundCache（下一条入站消息自动 flush），并新增 `MAX_OUTBOUND_CACHE=100` 上限防止离线期间无限增长（超出丢最旧）；新增 `tests/cold-start.test.ts` 覆盖持久化、重启恢复、暂存补发、队列上限四个场景

## [0.6.0] - 2026-08-22

### Changed

- `send_wechat` 工具接入微信限流管线：工具推送与 assistant 回复共用同一份每用户 10 条窗口预算（`wechatMsgCount`），超限不再直发（避免撞网关频控），而是进入 `/next` 缓存队列——与回复路径同一套「缓存 + 💾 提示 + `/next` 或下一条消息自动 flush」恢复流程；被限流/发送失败的推送返回 `ok: true` + 排队说明（桥接层接管投递，模型不会因收到错误而重试、避免 flush 后重复送达）；正常路径返回文案逐字不变
- 出站发送收敛为单一入口 `deliverOutbound()`：预算判定、⚠️ 第 8-10 条提示后缀（仅作用于发送 payload，缓存原文保持干净）、失败入队、💾 暂存通知去重全部内聚，`sendReply` 与工具路径共用

### Fixed

- 缓存的图片/视频在 `/next` 取回时退化为文件附件：`flushPending` 改用 `mediaTypeForFile` 保留原生媒体类型，与直发行为一致（图片内联显示）
- 无法读取的缓存文件（临时文件已被清理等）在每次 flush 时无限重试：现在读取失败即丢弃该条并在完成摘要中提示（`N 条文件缓存因无法读取被丢弃`）
- 发送失败的回复静默入缓存、用户无感知：现在同样触发一次 💾 暂存提示（文案泛化为「微信限流或发送失败」）
- `send_wechat` 传入不存在的 `file_path`：立即返回 `ok: false`（`file not found`）且不污染缓存队列

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
