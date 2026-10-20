# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **`/at` —— 微信端的 `@会话` / `@文件` 引用。** GUI 输入框里打 `@` 会弹补全、选中后插入一个原子引用 chip；微信没有输入框，这个能力此前**完全缺失**：想在微信里让 agent 看看「另一个会话聊了什么」或「某个文件写了什么」，只能手工把会话 id 或路径贴进正文，而会话 id 贴进正文对模型毫无意义（模型看到的是 `session-xxxx`，不是那段对话）。现在 `/at` 补上这条链路，走的仍是宿主自己的引用管线：
  - `/at s <编号|关键词>` —— 引用**其它会话**。编号与 `/s list` / `/s switch` 完全同源（优先复用最近一次列表快照，否则全量列表）；关键词优先交给宿主自己的 `listCandidates`（按工作目录亲缘排序、标题只读投影，不折日志），没有 live agent 时退回按 title / cwd / id 扫 `/s list` 行，两条路径的匹配字段集刻意一致。多命中时列出候选让人指定而不是猜。登记后下一条消息带宿主规范的 `@[标题](dsh-session:<base64url>)`，`@deepseek-ai/dsh-session-reference` 在 `agent/pre-step` 把它改写成可读的 `@标题` 并紧随一条 `## Referenced sessions` 快照——与 GUI 的 `@会话` 是**同一条链路**，不是复制品。
  - `/at f <路径>` —— 引用**文件或目录**。相对路径从当前工作区解析，也接受绝对路径（工作区之外同样可用：`@文件` 是给模型的指针，不是 bridge 自己去读，宿主 `FILE_REFERENCE_PROMPT` 明确写了「绝对路径指代宿主机上的文件或目录」）；目录自动带尾斜杠，含空格的路径自动写成 `@"a b.txt"`（也可直接 `/at f "a b.txt"`）。模型看到的是 `@路径` 文本，`dsh-file-reference-local` 的提示词负责让它调用 `read` 而不是假装读过。路径两端的不可见格式字符会被剥掉（从资源管理器复制常带 U+202A，而 `trim()` 不处理它们，一个前导 U+202A 就足以让 `path.isAbsolute()` 返回 false，把 `C:\…` 当成相对路径解析）；中文输入法的弯引号 `“…”` 与 ASCII `"…"` 同样接受。
  - `/at` 查看暂存（编号列表 + 上限）、`/at rm <编号>` 移除、`/at clear` 清空；`/status` 在**有暂存时**多一行「引用暂存」，没有则一行不加。
  - **暂存式而非立即发送**：命令只登记，引用落在**下一条**投递给 agent 的消息上（打字合并开启时落在合并后的那一批），投递成功即清空。这样路径里的空格、正文从哪开始都不需要额外分隔符，也不会出现「引用发出去、正文还没想好」。引用块**跟在正文之后**：宿主 `dsh-session-title` 用首条用户消息的**开头**生成会话标题（确定性 fallback 取前几个词），前置的 `@[标题](dsh-session:InNlc3N…)` 会把新会话标题写成 base64；而宿主的 mention 解析与位置无关，放后面不影响展开。
  - **可预见的失败全部挡在 `/at` 阶段**，因为宿主的引用失败是**整轮终止**：引用自己（`SESSION_REFERENCE_SELF_REFERENCE`）、第 4 个会话（`SESSION_REFERENCE_TOO_MANY`，上限与宿主 `MAX_REFERENCES = 3` 对齐）、宿主未挂载 `dsh-session-reference`（mention 会被当普通文本转发，模型只看到 base64 串）——三种情况都在登记时拒绝并说明原因，代价是一条回复而不是用户整段 prompt。路径含引号/控制字符的路径同样当场拒绝；找不到路径时给出相近候选（优先用 `ctx.fileReferences`，没有 live agent 时退回目录列举）。
  - 暂存只在内存里，**不写 `state.json`**：一条引用是「这一次」的意图，重启后大概率已不是同一件事；另有 10 分钟 TTL，登出 / 重新扫码 / 换绑整表清空（引用属于上一个对端）。agent 创建/恢复失败时**不清空**，重发正文即可，不必重新 `/at`。
  - 接线与既有本地命令一致：`parseAtCommand` / `isAtCommandAttempt`、卡片 bypass（有待处理卡时 `/at` 照常执行，且参数写错也是回用法而不是被当成卡片答案）、`LOCAL_COMMAND_NAMES` 去重（同名原生命令抢不走）、`/help` 与设置页「指令帮助」同源。
- **`src/bridge/at-refs.ts`** —— mention 渲染层（纯函数，零依赖）：`encodeSessionReferenceUri` / `formatSessionMention` / `formatFileMention` / `buildMentionBlock` / `normalizeAtTarget` / `hasInvisibleMarks`。与宿主 `dsh-session-reference` 的 URI 编解码、`dsh-file-reference` 的 grammar 逐字对齐；唯一有意的差异是目录**闭合引号**（宿主在补全过程中输出未闭合的 `@"dir/` 以保持菜单下钻，微信没有菜单，发出去的是成品文本）。

### Tests

- 新增 `tests/at-command.test.ts`（55 例）：解析矩阵（`list`/`clear`/`rm`/`s`/`f`、缺参数、非法子命令）、与 18 个既有 parser 的别名冲突守卫、mention 语法往返（中文 / `[]` / 反斜杠 label、`@path` / `@"a b.txt"` / 目录尾斜杠 / 控制字符拒绝）、登记与一次性注入（含「第二条消息不再带 mention」、正文保持在首块以免污染会话标题）、打字合并批次只带一次 mention、关键词解析的两条路径（宿主 `listCandidates` 与无 live agent 时的本地行扫描）与歧义提示、全部拒绝路径（引用自己 / 第 4 个会话 / 第 9 个文件 / 服务缺失 / 找不到路径的候选提示）、工作区**之外**的绝对路径引用（含带 U+202A 的粘贴路径回归）、`/at rm` 与 `/at clear`、TTL 过期与「过期后重新登记是全新一组」、登出清空、`/status` 有/无暂存两态、以及有待处理权限卡时 `/at` 不被吞。

## [0.12.0] - 2026-10-19

### Compatibility

- **DSH 0.2.1-rc.2 adaptation.** The enforced host range is now `>=0.2.1-0 <0.3.0` in both `engines.dsh` and the `@deepseek-ai/dsh` peer; 0.2.1-rc.2 is explicitly in the admission matrix. The 0.2.0 line is no longer claimed. No runtime API change was required: `dsh-wechat@0.11.0` passes a real rc.2 host smoke (HTTP 200 + boot marker).

### Changed

- **设置页改为分组折叠，默认全部收起。** 此前是**一张卡片平铺 15 个控件**：8 个裸键名输入框（`cwd` / `cardTimeoutMs` / `sendWechatRateLimitPerMinute` / `allowedUsers` / `mergeSilenceMs` / `mergeMaxMsgs` / `mergeForcedReleaseMs` / `maxOutgoingFileBytes`）、8 个复选框、提示词正文和两个登录按钮挤在同一列，608px 宽的内容区要滚 995px，而**同一个功能的控件被拆散在不同块里**——「打字合并」开关在复选框区，「静默窗口 / 条数上限 / 强制放行」却在上面几行的网格中，中间还隔着 `maxOutgoingFileBytes`。
  - 现按用途分为 5 组：**连接与默认行为**（`cwd` / `cardTimeoutMs` / `sendWechatRateLimitPerMinute` / `allowedUsers`）、**消息推送**（决策推送 / 任务提醒 / 静默 / 结论模式）、**打字合并**（总开关 + 三个窗口参数 + 后缀开关）、**微信渠道提示词**（开关 + 正文）、**安全边界**（两个放宽开关 + 外发文件上限）。「已知限制」告警盒同样可折叠。
  - 收起时标题行右侧显示**由当前配置实时算出**的摘要（如「已关闭 · 每条消息各自一轮」「静默 开 · 结论 关 · 决策推送 开 · 任务提醒 开」），而不是静态文案——折叠不能以看不见配置为代价。
  - 字段标签从裸键名改为中文名 + 键名小字（`工作目录 cwd`），帮助气泡文案原样保留。
  - **打字合并总开关关闭时，其三个窗口参数与后缀开关置灰**（`disabled`）并提示「开启后这些参数才生效」；值仍随保存提交，因此关掉再开不会丢调好的窗口。
  - `重新扫码` / `退出登录` 移到状态区（登录动作属于状态），底部行只留 `保存配置`，并新增 `● 有未保存的修改` 标记——它比对的是 `payloadOf(form)` 与上次保存成功的快照，因此只改空格或改回原值不会被误报。
  - 展开状态记在浏览器 `localStorage`（键 `dsh-wechat/settings-open`），不进 `config.json`；`localStorage` 不可用（隐私模式 / 配额）时退化为「能展开但不记忆」，不抛错。
  - 无新配置键、无 API 变更、无保存语义变更：仍然一次 POST 全量 payload。

### Added

- **`scripts/ci-local.sh` + README 开发须知：Windows 上"全绿"不等于 CI 绿。** CI 是 `ubuntu-latest`，而 PR #11 里一条断言把 Windows 形状的字面量 `C:\home\.dsh` 同时当输入和期望前缀——实现会先对该根目录做 `path.resolve`，在 POSIX 上它是**相对路径**、会解析到 cwd 之下，于是 `startsWith("C:\home\.dsh/sessions")` 恒为 false：本地必绿、CI 必红（该 PR 恰好从未跑过 CI，直到下一次推送才暴露，并因此让 `ci-green` 门禁拦住了 0.11.0 的发布）。脚本在与 CI 完全一致的环境里（复制到本机临时目录后 `npm ci && tsc --noEmit && vitest run`）复现整个流程，且不会用 Linux 版 esbuild/rollup 覆盖工作副本的 `node_modules`。

- **测试临时目录回收（`tests/temp-cleanup.setup.ts`，vitest `globalSetup`）** —— `mkdtempSync` **只创建、从不删除**，而 33 个使用它的测试文件里只有 10 个记得 `rmSync`，其余 23 个（`session-mgmt` 9 处、`cross-session-notify` 8 处，`corrupt-session` / `final-only` / `frames` / `history-truncation` / `preset-display` 各 2 处，另 16 个文件各 1 处）每次运行都往外漏——单次 `npm test` 实测产生 **364 个**孤儿目录。长期反复跑测试的后果是可量化的：截至本次修复，本机 OS 临时目录里已堆积 **21294 个**此类残留（`dsh-wx-sess` 2304、`dsh-wx-cross` 2266、`dsh-wx-frame` 2143、`dsh-wx-type` 1415 居前），其中 10-12 / 10-13 两天占 82.6%，正对应 0.10.0 / 0.11.0 的密集开发。
  - 清理放在 `globalSetup` 而非逐个测试文件补 `finally`：后者改动面大，且**以后新增的测试仍会漏**；前者一次性收口，对现有与将来的用例都生效。
  - 两条安全约束，缺一不可：**① 只删「本次新增」的条目**——`setup` 先对临时目录做快照，`teardown` 只删除快照之外的，因此并发运行的另一个测试进程正在用的目录不会被误删；**② 只删前缀白名单内的条目**（`dsh-wx-` / `dsh-home-` / `dsh-wechat-` / `wx-process-` / `send-wechat-`）——宿主自身的 `dsh-spill-*`、`dsh-subprocess-*`、`dsh-workspace-changes-*`、`dsh-acl-*`、`dsh-mcp-probe-cwd` 不匹配任何前缀，**永不被触碰**，所以「一边跑测试、一边有 DSH 会话在跑」不会互相破坏。`setup` 未执行时 `teardown` 直接返回（`preexisting` 为 `null`），避免任何「快照缺失 ⇒ 全删」的退化路径。
  - 该残留**不涉及凭据泄漏**：抽查 `dsh-wx-relogin-*/auth/token.json` 内容为 `{"token":"t","baseUrl":"https://gw","accountId":"b1","userId":"u"}`，是测试夹具而非真实微信凭据。占用亦极小（21294 个目录合计仅 6.47 MB，多数为空目录或数百字节的 `state.json`）——**真正的问题是条目数量**，而非体积。

- **打字合并 / inbound merge window（`mergeEnabled`，默认关闭 = 需显式开启）** —— 此前每条微信消息都是一次独立 turn，一句话分五段发就要烧掉五轮。开启后同一聊天的裸文本进入缓冲区，静默窗口（`mergeSilenceMs`，默认 3000ms）到点或条数上限（`mergeMaxMsgs`，默认 10）到达时**合并成一条 prompt** 投递。**默认关闭**：合并改变「一轮」的含义（一轮里可能有多条用户消息），且每条消息要多等一个静默窗口，对「把 x 改成 y」这类短指令是净损失，因此按 opt-in 处理——升级后行为与旧版完全一致，需要时用 `/merge on` 或设置页开启。安全规则是这次实现的重点，因为它们决定了这个功能是「省轮次」还是「卡住通道」：
  - **乱序的旧消息不延长计时器**——消息自带的 `create_time_ms` 早于已缓冲的最新时间戳时只追加、不重置静默窗口，否则一条迟到重放就能把批次一直挂住；更新的消息才会顺延。
  - **条数硬上限**（默认 10）作为防御性边界，缓冲区永远不会超过它。
  - **强制放行**（`mergeForcedReleaseMs`，默认 180000 = 3 分钟）：无论静默窗口、`..` 暂挂、还是上一批仍在投递，到点一定发出并记日志——「宁可两句话一轮，也不让通道卡死」。
  - **在途批次不吞消息**：上一批还没投递完时到达的消息进入**新**批次，只为保序等待上一批，且等待上限同样是强制放行时间；超过就记日志后照发。
  - **非文本不合并**：图片/文件/视频/语音（无转写）到达时先把已输入的文字作为**一轮**发出去，再把自己作为**一轮**交给 agent，顺序与用户输入一致。
  - 后缀开关 `mergeSuffixTokens`（默认开）：正文末尾 `..` = 还要接着说（暂不发出），`!!` = 立刻提交；两者会从正文里去掉，且「整条消息只有后缀、又没有待合并内容」时按普通文本处理（不会让消息消失）。裸 `!!` 在有待合并内容时是纯控制符，不会污染正文。
  - 开关：微信 `/merge on|off|status`（别名 `/mg`，与 `/silent` 同款接线：parser、dispatcher、卡片 bypass、`LOCAL_COMMAND_NAMES`、`/help`、`config.json` 持久化），设置页「打字合并」同一个值；`/merge off` 会先把暂存的消息发出去再关闭（那是用户自己说的话）。`/status` 显示窗口/上限/暂存条数。
- **权限提权闸门（S1）** —— 微信 `/perm default <预设>` 此前直接 `settings.update("permission", {defaultPreset})`：这是**全局且持久**的写入，对所有新会话生效（与微信无关），一条聊天消息就能把整机默认权限放宽到 `danger-full-access`。现在默认拒绝**提权**写入：解析出的 `permissionPresets.resolve(name)` 沙箱为 `danger-full-access` **或**审批策略为 `never`（含只降审批的自定义预设）即视为提权，回复里明确要求在 DSH 界面「设置 → 权限」操作。不放宽的写入照旧；**会话级 `/perm switch` 不受影响**（不持久）。新开关 `allowRemotePermissionEscalation`（默认 `false`）可显式恢复旧行为。无法解析的预设按提权处理。
- **`send_wechat` 文件边界（S2）** —— 此前 `file_path` 是任意绝对路径：这个工具因此是一个**任意文件读取原语**（任何 agent、以及任何能说服 agent 的东西都能把 `~/.ssh/id_rsa` 发到微信）。现在只允许**调用会话**工作目录或已注册工作区内的文件（两侧都按 `fs.realpath` 归一后比较，`..` 与符号链接都逃不出去），并有字节上限 `maxOutgoingFileBytes`（默认 20 MiB，`stat` 阶段即拒绝，不会读进内存）。边界按**实际发起调用的会话**求值，而不是按「未绑定会话回退到首个微信用户」解析出的收件人——否则任意会话都能借回退读取别人的工作区。新开关 `allowAnyFilePath`（默认 `false`）恢复旧行为；工具描述同步写明边界。缓存队列里的文件在冲刷时也会重新校验大小。
- **入站白名单升级播种（S3）** —— `allowedUsers` 默认 `[]` 意味着「首个入站者成为绑定对端」，于是**老部署升级后第一个给 bot 发消息的陌生人就能接管它**。现在：`config.json` 里从未写过该键、且 `state.json` 已有绑定用户时，启动把该绑定用户写进 `allowedUsers` 并持久化，同时在微信里**提示一次**、并在 `/status` 增加「入站白名单」行（**显示你自己的 user id**，不必再去别处找）。全新安装（没有绑定用户）**不播种**，保持 first-contact 行为，绝不会把新用户锁在门外；显式存过 `[]`（= 决定开放）也永不覆盖。
- **文件系统与日志卫生 + 审计（S4）** ——
  - `~/.dsh-wechat` 与其下所有文件（`auth/token.json`、`state.json`、`config.json`、`sync-buf.json`、`audit.jsonl`）显式以 `0700` / `0600` 创建（创建时给 mode **并且** `chmod` 一次，否则已存在的文件会保留旧权限）。⚠️ Windows 忽略 mode 参数，实际依赖 `%USERPROFILE%` 继承的 ACL —— 这一点写进了 README。
  - 入站日志行此前打印**完整**发送者 id 与明文正文预览；现在 id 走 `maskUserId`（保留头 2 + 尾 2 便于关联），预览过一次 `maskSecrets`。允许名单拒绝日志同样只记脱敏 id。
  - 新增追加式审计 `~/.dsh-wechat/audit.jsonl`（JSONL，`0600`）：入站（脱敏 id + 字符数，**不含正文**）、slash 命令名、审批/提问决定、`send_wechat` 文件路径、每次出站发送的 kind/结果/窗口计数。按 1 MiB 上限轮转为 `audit.jsonl.1`（只留一份历史）并记日志；写失败**绝不影响**消息路径。

### Fixed

- **卡片被标记为「已推送」但从未发出（S5）** —— 六处 `markCardPushed` 都在 `sendReply` **之前**调用，而机器人登出/`-14` 放弃时 `sendReply` 是**丢弃**（不排队）的：卡片因此被标记成已推送、`isCardPushed` 又挡住重推，直到 30 分钟卡片超时才解封——用户根本看不到卡。现在先确认可达（`botReady()` 且未 give-up）再占用一次性标记，投递抛错时**回滚标记**（与 `notifyCachePendingLocked` 同款），并把「未标记、稍后可重推」记进日志。
- **出站串行槽既不会报错也不会超时（R1）** —— `serializeOutbound` 没有重入断言、也没有上界：锁内再调用公共入口会把该操作排到**自己**后面，永久卡死整条出站链路（这一类缺陷已经真实发生过一次，且是致命的）。现在：① 用 `AsyncLocalStorage` **精确**识别「同一条调用链内重入」（只是恰好同时到达的并发调用仍属正常排队，不会被误判），命中即**立刻抛错并记日志**，修复方式唯一——改调 `*Locked` 版本；② 等待上一个操作**有上界**（30s），超时记日志后照常发出，牺牲极端情况下的严格顺序换取活性。空闲路径仍然零定时器、零额外跳转。
- **四个只涨不降的内存表（R2）** —— `lastAssistantTextBySession`（存整条助手正文，上限 64 会话）、`lastActivityBySession`（上限 512 会话）、`wechatMessageIds`（一次性标记，10 分钟 TTL **加** 512 条硬上限；此前只有 echo 到达才会删，echo 永不到达就永久驻留）、`modelOverrides`（上限 128 会话）现在都有确定性淘汰（插入序 FIFO，淘汰即记日志）。它们都是**缓存**：淘汰只会让显示退回默认值，不会丢队列里的任何消息。
- **重启静默丢弃排队出站（R3）** —— 运行时队列硬上限是 400 条，而 `state.json` 重新加载只保留最后 100 条：一次重启就会**静默丢掉第 101–400 条**（正好是通知、结论、工具推送这些最不该丢的内容）。加载上限现与运行时硬上限对齐（400），重启完整恢复持久化的有界集合。

### Tests

- 新增 `tests/merge-window.test.ts`（24 例）：窗口内五条消息合成**一条** prompt 且顺序不乱、批次投递后缓冲区确实排空（不留只写不读的状态）、`..` / `!!` 后缀语义与「整条消息只有后缀」的退化情形、强制放行在 `..` 暂挂期间仍会发出、非文本项不参与合并、`/merge` 与 `/silent` 同款接线（解析矩阵、`/help`、bypass、持久化、`LOCAL_COMMAND_NAMES` 去重）。
- 新增 `tests/security-hardening.test.ts`（27 例）：S1 提权闸门的放行/拒绝矩阵（含自定义只降审批的预设）、S2 `send_wechat` 的 `..` 与符号链接逃逸、按**调用会话**而非收件人求值、`stat` 阶段拒超大文件、S3 播种三条分支（升级播种 / 全新安装不播种 / 显式 `[]` 永不覆盖）、S4 目录与文件的 `0700`/`0600`、入站日志无原始 id 无正文、审计 sink 的轮转与「写失败不影响消息路径」。
- 新增 `tests/delivery-hardening.test.ts`（12 例）：S5 卡片先确认可达再占用一次性标记、投递抛错时回滚、R1 串行槽的重入立即抛错与 30s 等待上界、R2 四张缓存表的淘汰、R3 重启恢复 150 条而不是截到 100 条。
- `tests/client-panel-wiring.test.ts` 增加「settings panel grouping」分组（现共 57 例）：五个分组的 id 必须同时出现在 `Group({id})` 与 CSS 里、**打字合并的开关与其全部参数必须落在同一个分组切片内**（断言参数控件不出现在 `id: "merge"` 之前）、总开关关闭时四个输入确实 `disabled`、`localStorage` 键与降级路径、未保存标记比对的是 `payloadOf(form)`、以及「面板渲染的每个 `wx_*` 类名都在样式表里有规则」。
- `tests/host-line.test.ts` 扩到 29 例：准入矩阵改为 `0.2.1-0` 起（`0.2.0` 线不再被声称）、rc.2 目标必须被接受，并新增三条 `PUBLISH.md` 文档回归——正文引用的区间必须与 `package.json` 逐字相同、必须继续提醒 peer 要标 `optional`、必须继续写明上界要带 `-0`。

## [0.11.0] - 2026-10-13

> 本版并入上游 v0.9.7 → v0.9.11（流式帧处理、执行过程分组、官方 Markdown 语义、FIFO 发送顺序、入站重放去重、可取消长轮询、`describe()` 设置读取），在其之上加入结论模式、0.2.x 适配修复与投递可信度改进。

### Added

- **结论模式 / final-only（设置页新开关，配置键 `finalOnly`，默认关）**——只回最终结论，中间过程一律不推。此前**没有任何开关能解决**这一场景：一次需求会创建一个 goal，其 round-driver 在 `agent/status → idle` 时自动续跑，**每一轮都是一次独立的 DSH turn**；`silent` 的单位是「轮」，所以 8 轮仍然发 8 条。结论模式把推送触发点从 *turn/end* 改成 ***整条续跑链彻底停下之后***：助手正文与跨会话完成卡都写进按会话的暂存表，静默期内只保留最后一条，到期后作为**一条**结论交付。
  - 交付格式：只有一轮时原文直发；多轮时前缀一行 `✅ 已完成（共 N 轮）`，正文只取最后一段（不逐轮罗列，不拼接）。
  - 静默期 `finalOnlyIdleMs`（默认 45 秒）：助手正文、`turn/end`、`agent/status` 空闲都会把它重新推后；`agent/status` 运行中（下一轮已经开始）会取消倒计时。
  - 硬顶 `finalOnlyCeilingMs`（默认 10 分钟）：从**第一次**暂存起算，且是独立定时器，不被 re-arm 清掉，保证长任务不会永久沉默。
  - **期间安全**：权限卡、提问卡、超时提示、报错一律**立即**推送，不受压制；报错还会丢弃暂存，避免错误之后再补一条过期结论。
  - 逃生口：微信 `/flush`（别名 `/f`）立即取回暂存结论；也可以直接发下一条需求——新人消息到达时会先交付上一件事的结论。
  - 覆盖两条洪水路径：绑定会话的逐轮正文（`assistant/message` / `turn/end` flush）与跨会话的 `✅ 任务已完成` 卡片。
  - 生命周期清理：登出 / 重新扫码 / `resetPeerBinding()` 换绑会**丢弃**暂存（身份变了，结论不该发给下一个绑定者）；**插件 dispose / 宿主关闭则会冲刷交付**——暂存里是 agent 已经产出的结论，对端还是同一个微信用户，丢掉就是白干。
  - 优先级：`finalOnly` 开启时压过 `silent`；枚举式开关会与 `silent` 语义重复，因此保留现有 `silent` 不动、只加一个布尔开关（向后兼容，零迁移）。
- **`/final on|off|status`（别名 `/fo`）——结论模式终于能在微信里开关。** 此前该模式只有三个入口（设置页勾选、`~/.dsh-wechat/config.json`、插件行 `config:`），**微信端一个都没有**：`/status` 能显示「结论模式: on/off」，但没有任何命令能改它，`/final` 会被当成普通文本转发给 agent。现与 `/silent` 对齐补齐（持久化、bypass 卡片、`/help`、`LOCAL_COMMAND_NAMES` 去重）。两个刻意的语义决定：**① `/f` 不当别名**——它已经是 `/flush`，而「把暂存的取回来」和「开始暂存」正好相反，别名会制造一个静默的破坏性歧义（最短无歧义前缀是 `/fo`）；**② `/final off` 先交付再关闭**——暂存里是 agent 已经产出的结论，用户说「别憋着了」时把它丢掉就是白干（与 dispose 同款语义；只有登出/换绑才丢弃）。`status` 额外显示暂存条数。
- `/status` 增加「结论模式」行，开启时显示当前暂存条数。
- `/flush`（`/f`）加入帮助表与 bypass 命令表（有待处理卡时也绕过卡片直接执行，与 `/next` 同款语义）。
- **秘密脱敏 `src/utils/redact.ts`**：JWT / `sk-`·`rk-` / `gh[pousr]_` / `xox[baprs]-` / `AKIA` / `Bearer` / 32+ hex / 40+ base64 → `***`，纯函数、幂等。接在 agent 报错（绑定与跨会话）、原生命令失败、`/history` 读取失败、权限切换失败、跨会话预览这些**错误与摘录**出口上；**绝不作用于正常回复正文**（hex/base64 规则会误伤 commit SHA）。此前 `String(error)` 原样进第三方聊天记录。
- **完成卡预览改取尾部 80 个码点**（并过脱敏）：此前取前 80 字，而结论永远在最后——正好显示开场白。
- **`（i/n）` 有序分段 + Markdown 感知切分**：代码围栏与 GFM 表格**原子不可切**（超长的重复自身围栏 / 表头分隔行），断点优先空行 → 换行 → 空格 → 硬切且必须落在 ≥55% 处，预算按**码点**计且把前缀长度算进去。此前 4000 码元硬切且无序号：3 段回复看起来像 3 条无关消息，被截断还像说完了。
- **出站队列溢出不再静默丢弃**：到达上限时**立即强制发出最旧一条**（限一条、带重入保护）再入队。通知恰恰是绝不能消失的东西，此前只写一行日志就丢掉。
- **`send_wechat` 每分钟限流**（`sendWechatRateLimitPerMinute`，默认 10，`0` = 不限）：滑动 60 秒窗口，超限时**明确拒绝**并告知模型，而不是静默继续刷用户。
- **入站白名单 `allowedUsers`**（默认 `[]`）：空 = 现有行为（首个入站者成为绑定对端）；非空 = 只有名单内的 id 会被处理，其余在**去重 / 预算 / 建会话 / 命令分发之前**就被拦下并记日志，绝不回复。此前任何能给 bot 发消息的联系人都能驱动它。

### Fixed

- **`/stop` 在 DSH 0.2.x 上会让宿主抛错，并写坏会话日志（桌面端历史永久空白）**：`agent.cancel("user-stop")` 传的是字符串，而 0.2.x 的 `AgentCancelCause` 是对象联合（`{kind:'user'|'parent'|'hook'|'disposed'}`），`packages/core/agent-loop/src/agent.ts` 的 `abortedCancelCause` 以 `assertNever` 收尾 ⇒ `unreachable variant: "user-stop"`。该异常抛在 `turn()` 的 `catch` 里、而写日志在 `finally` 里，于是 `turnEnds` 尚未赋值仍为初值 `null`，`finally` 照常把 `{"turn":N,"reason":null}` **落盘**——这是 `reason: null` 的唯一产生路径。桌面端折叠对话时间线时无保护地读 `end.data.reason.kind`，遇 `null` 抛 `TypeError`，整个历史渲染为空；而 agent 与会话状态完好，新消息仍能正常收发，因此极易误判为前端故障，且重启不自愈。现改为 `agent.cancel({ kind: "user" })`，并把 `AgentHandle.cancel` 的结构化类型收窄为真实联合（此前垫片写成 `cause: string`，正是它让这个错误通过了类型检查）。
- **`/preset` 设置默认 Preset 自 0.1.7 起是静默空操作**：设置命名空间是按 profile 配置行 id 解析的，宿主在 0.1.7 把该行由 `agent-presets` 改名为 `agent-preset-registry`，字段由 `default` 改为 `selectedDefault`。写入旧组合会被 `settings.update` 拒绝（`No configurable plugin entry`）并被 catch 吞掉，只留一句「无法写入 DSH 设置」。现按「新组合优先、旧组合兜底」两次尝试，0.1.5 与 0.1.7+ 都能真正写入。
- **`sessionProjectionCache.cachedSnapshot(header, 0)` 在 0.1.7+ 必抛**：第二个参数已由 `inheritedEventCount: number` 改为可选的投影键数组（直接喂 `new Set(keys)`），传 `0` 得到 `TypeError: number 0 is not iterable`，被 try/catch 吞掉后 `/s list`、`/s new` 静默失去零 I/O 列表提示、回落到读原始日志。现改为不传第二个参数，并同步修正结构化类型。
- **`engines.dsh` 缺上界，把 `0.3.0` 与 `1.0.0` 判为兼容**：实际前值是 `>=0.2.0-rc.2`——下限正确，但**没有任何上界**，于是 `0.3.0`、`0.3.0-rc.1`、`1.0.0` 全部落在范围内。现收为单段 `>=0.2.0-rc.2 <0.3.0-0`，两端都精确：下界保持 v0.9.7 起的 `0.2.0-rc.2`（0.1.x 线不再声称支持），上界挡在 0.3.0 线之前。
  - 上界必须带 `-0`：写成 `<0.3.0` 时，`0.3.0-rc.1` 在 `includePrerelease` 语义下仍被放行（已实测）。
  - 不再使用前发布元组枚举（曾一度写成五段 arm）。**唯一**读该字段的消费者是插件市场 `dshmarket`，它固定以 `{ includePrerelease: true }` 求值，在此语义下单段 arm 已放行全部 0.2.x 前发布版；而枚举**永远补不全**——每出现一个新的 0.2.x 元组都要再加一段（旧写法就漏掉了 `0.2.3-rc.1`）。单段写法与枚举式在真实消费者下判定逐项相同，且没有维护债。
  - 事实澄清：该字段在 0.2.x 宿主上是**声明性**的——`evaluatePluginCompatibility` 只校验 `peerDependencies`，宿主代码中**没有任何一处读 `engines`**（已核对 `app.asar`：`engines?.dsh` / `manifest.engines` 等形态命中数为 0）。此前记入本 CHANGELOG 的「前值 `>=0.1.5-rc.1 || >=0.1.7-0 <0.2.0`」**有误**：该值从未出现在本仓任何一个 `package.json` 中（已遍历全部 ref 与全部 blob 核实），真实前值是 `>=0.2.0-rc.2`，故那条基于幽灵前值的说明一并订正。
- **新增 `@deepseek-ai/dsh` peer，让宿主真正校验宿主版本**：此前宿主版本要求仅由 `engines.dsh` 声明，而宿主不读该字段，等于**没有任何强制**。现声明 `peerDependencies["@deepseek-ai/dsh"]`，值与 `engines.dsh` **逐字相同**（`>=0.2.0-rc.2 <0.3.0-0`），宿主 `evaluatePluginCompatibility` 便会以 `{ includePrerelease: true }` 校验运行版本。
  - **同时标 `optional`**，这不是可有可无的修饰。以 `pnpm pack` 后的 tarball 安装（最接近 registry 路径）实测，两个变量都要说清：
    - **不加 `optional`，安装直接失败**（`exit=1`）：peer 被当成需要解析的真实依赖，`@deepseek-ai/dsh` 元包带 82 条 dependencies，会拉进 530 个包，最终撞上 `@deepseek-ai/dsh-type-meta` 的 npm **404**（该包未发布）。
    - 即使解析成功，`optional` 也决定 profile 体积：lockfile 从 28 行膨胀到 **8199 行**（3769 处 `@deepseek-ai/dsh*`）。
    - 加上 `peerDependenciesMeta["@deepseek-ai/dsh"].optional = true` 后 `exit=0`，lockfile 稳定在 28 行、仅 2 处提及（即声明本身）。
    - 宿主门禁**不读** `peerDependenciesMeta`（用真实 `@deepseek-ai/dsh-app-boot@0.2.0-rc.2` 的 `evaluatePluginCompatibility` 实测：标了 optional、范围写错仍判 REJECTED），因此强制力不受影响。
  - 风险与代价必须写明：peer 不匹配时宿主**跳过整个 `dsh-wechat` bundle**（`profile.ts` 把抛错收进 `skippedBundles`）。**不是完全无声**——`reportSkippedBundles` 每次启动会向 stderr 写一行 `dsh: skipping profile bundle "dsh-wechat": …`，但桌面端 GUI 看不到，表现就是插件消失；救回需在 profile 的 `compatibility.json` 里按 `包名@版本` → 运行时版本登记精确豁免。

- **宿主契约硬化（按 `dsh-v0.2.0-rc.2` 源码逐项核对，无其余签名/形状断裂）**：
  - `session-log.cjs` 的 `encodeSegment` 改为宿主同款 `~XXXX` 转义（每个 `[A-Za-z0-9._-]` 之外的码元，`~` → `~007E`，`.`/`..` 特判）。原来的 `encodeURIComponent` 对本仓自铸的 `session-<uuid>` 恰好一致，但 id 含 `~ ! * ' ( )` 或非 ASCII 时会静默指向不存在的目录。
  - 会话根目录改为 `path.resolve` + `~` 展开（此前把 `$DSH_HOME` / 配置值原样拼接）。
  - vendored `createUserMessage` 补 `structuredClone`：此前 `deepFreeze` 会冻结并**共享**调用方的嵌套 `content`/`source`。
  - `tools.register` 与客户端 `slots.inject` 的 disposer 不再丢弃，随插件卸载释放（此前重载后工具/设置面板会残留）。

- **出站队列在封顶强制发送时自死锁（致命，本版新引入）**：`parkOutbound` 只经由 `deliverOutboundLocked` 到达，而后者已持有 `serializeOutbound` 的串行槽；封顶逻辑却调用**会再次抢同一把锁**的 `flushPending`，于是该操作被排到**自己**后面，永不 resolve。后果是第 101 条入队时永久挂起，且此后**整条出站链路全部卡死**（无关的后续发送也一并 HUNG），只能重启进程。现改调锁内版本 `flushPendingLocked`。原先的 `tests/cold-start.test.ts` 直接调 `parkOutbound`、绕过了锁，因此观察不到；新增的 `tests/pr11-regressions.test.ts` 改为经由真实入口 `deliverOutbound` 驱动并加超时断言，确保这类重入不会再溜过。
- **硬上限不再约束内存**：强制发送若**发不出去**（token 失效 / 网关拒收 / 消息窗口关闭），则没有任何条目离开队列，而 `parkOutbound` 照常追加——上限的原始目的（约束内存，连同 `state.json` 快照）被静默取消，实测 300 条入队后队列长度即为 300。现补 `MAX_OUTBOUND_QUEUE_HARD`（软上限的 4 倍）作为真正的内存边界：到达该线时**明确记录日志**并丢弃最旧一条，使「绝不静默丢弃」的承诺退化为「绝不**静默**丢弃」，而不是退化为无界进程。
- **机器人离线期间，跨会话完成通知会被永久压制**：两处完成通知路径把 `if (!this.botReady()) continue;` 放在 `set.add(sessionId)` **之后**，于是不可达时该会话已被标记为「本回合已通知」，且**清理定时器也没挂上**；token 恢复后同一会话再结束，通知再也发不出去。现改为「立即发送路径先确认可达再占用去重位；结论模式暂存路径照常标记（其投递本就要经 `sendReply` 排队，离线暂存正是它能活下来的原因）」，并且**凡标记必挂 30 秒清理定时器**，杜绝无定时器的悬挂标记。
- 移除只写不读的死代码 `currentGoalRound`（全仓无任何读取，投递决策实际由内联的 `source.kind` 判断完成）。

- **`tests/session-log.test.ts` 的 `sessionLogPath` 断言只在 Windows 成立，导致 CI 在 Linux 上失败**：该用例把 Windows 形状的字面量 `C:\home\.dsh` 同时当作输入与期望前缀，但 `sessionLogPath` 会先把根目录过一遍 `resolveDshHome`（内含 `path.resolve`）。在 POSIX 上 `C:\home\.dsh` 是**相对**路径，会被解析到当前工作目录之下，于是字面量不再是结果的合法前缀，断言必然为假——这是**测试自身的缺陷，不是 `session-log.cjs` 的缺陷**（该文件的实现未改动）。现改为与 `resolveDshHome(root)` 的实际返回值比较，并另加一例用 `mkdtemp` 生成平台原生绝对根目录，使该断言在三种 OS 上都有意义。
  - 该缺陷来自 PR #11 的 `02c9791`（`git blame` 可查），而 **PR #11 从未跑过 CI**（其 `statusCheckRollup` 为空，直接合并），因此直到本次推送才第一次暴露。这也说明发布流程的 `ci-green` 门禁是有效的：它拦住了 GitHub Release 与 npm 发布，`0.11.0` 未被发出。

### Tests

- 新增 `tests/final-only.test.ts`（23 例）：8 轮 goal 续跑 → **恰好 1 条**且含第 8 轮正文；同样的 8 轮在 `silent` 下仍为 8 条（钉住这次修复的正是这个缺口）；关闭时逐条直发；只交付最后一段而不拼接；权限卡/报错不被压住；报错丢弃暂存；新人消息先交付上一件事的结论；goal 续跑**不**触发交付；硬顶在永不空闲时仍交付一次；`agent/status` 运行取消 / 空闲重新计时；`/flush` 立即交付且是 bypass 命令；跨会话 8 轮折叠为 1 条；**dispose 冲刷交付**、换绑丢弃暂存；`/final on` 写入 `config.json`、`/final off` 先交付再关闭、`/final` 显示暂存条数、`/f` 不被 `/final` 抢走；外加两条文档回归（README / CHANGELOG 必须描述真实存在的开关——这两处的上一版正好都腐烂过）。
- `tests/native-command.test.ts` 增加一例：即使 profile 恰好注册了同名 `final` 原生命令，`LOCAL_COMMAND_NAMES` 也必须让本地 `/final` 处理器胜出（该用例在移除这两个名字后必然失败）；`tests/bridge-core.test.ts` 补齐 `parseFinalCommand` 的解析矩阵与 `/help`、bypass 断言。
- 新增 `tests/host-line.test.ts`（27 例）：用真实 `semver` 在两种语义下钉住 `engines.dsh` 的准入/拒绝矩阵，断言 `peerDependencies["@deepseek-ai/dsh"]` 与 `engines.dsh` **逐字相同**、被标为 `optional`（否则安装时会把整个 harness 拖进 profile），并钉住「`<0.3.0` 会放行 `0.3.0-rc.1`、必须写 `<0.3.0-0`」这一上界细节。
- 新增 `tests/client-panel-wiring.test.ts`（25 例）：`src/client.js` 没有测试覆盖，而新增开关有三种「静默失效」写法（form 初始化、保存 payload、JSX 各缺一处都会返回 `{ok:true}` 但什么都不落盘）。该文件把设置页渲染的每个开关与 `EDITABLE_KEYS` 两侧钉在一起，并断言结论模式的说明里指向微信端 `/final on|off`（只在设置页读文档的用户否则永远不知道有这个开关）。
- 新增 `tests/pr11-regressions.test.ts`（5 例）：本版三处缺陷的回归网——封顶强制发送不再自死锁（经真实入口 `deliverOutbound` 驱动 + 超时断言，覆盖原 `cold-start` 测试因直调 `parkOutbound` 而看不到的重入）、强制发送失败时队列仍受硬上限约束、机器人离线期间的完成通知不会被永久压制（两条路径各一例）。每个用例都验证过「在未修复代码上必然失败」。
- `tests/session-log.test.ts` 增加一例平台原生绝对根目录的 `sessionLogPath` 断言（25 例），并修正原断言对 `resolveDshHome` 返回值的比较——原写法只在 Windows 成立。
- 新增 `tests/redact.test.ts`、`tests/push-governance.test.ts`、`tests/plugin-dispose.test.ts`：脱敏规则（含误伤边界的两条显式断言）、限流与白名单、dispose 与换绑的相反语义。
- `tests/config-store.test.ts` 增加新配置键的持久化、非法值拒绝与默认值断言；`tests/split-text.test.ts` 按新分段契约重写（含唯一允许的超长例外：最小合法形式本身就超过预算的表格/围栏）；`tests/cold-start.test.ts` 改为断言溢出时**不丢**任何一条。

## [0.10.0] - 2026-10-13

### Added

- `/s list [current] [all|<数量>]` 与 `/workspace list [all|<数量>]` 支持窗口参数：默认各显示 20 行，显式数字看更多，`all` 显示全部；被截断时末尾追加「显示 20/N，看更多: … all（或 … <数量>）」提示（`/s list current` 提示同范围的 `current` 形式）。`all` 不设上限。
- 会话置顶：`/s pin [编号]` / `/s unpin [编号]`（省略编号时作用于当前会话，带编号时按 `/s list` 的行号解析）。读写宿主注册表的持久置顶集合（`workspaceRegistry.pinnedSessionIds` / `pinSession` / `unpinSession`），与 GUI 侧边栏共享同一份事实源，任一端操作另一端立即一致。`/s list` 把置顶会话排在最前并标 `📌`，列表标题注明「📌 置顶优先」。置顶区内部仍按最近活动时间降序（对应 GUI 的「最近更新」视图，置顶时间不参与排序），无置顶时行序与改动前完全一致。归档与置顶互斥：已置顶会话幂等提示、已归档会话拒绝置顶；宿主未提供该服务时提示并降级，不报错。
- 在微信里回答权限/提问卡后给出回执：`✅ 已允许权限卡 P{n}（工具名）。` / `⛔ 已拒绝权限卡 P{n}（工具名）。` / `✅ 已回复提问卡 P{n}。`。覆盖裸回复、`P{n}=…` 指定、一次 `P1=1 P2=2` 批量四条路径。结算会把卡片从待处理表里摘除，因此 `P{n}` 在整批处理开始时一次性快照——否则 `P1=1 P2=2` 的每条回执都取不到编号，只能降级成不带编号的文案。已被其他端抢先处理的卡仍只回「已在其他端处理」，不会误报成功。回执是用户自己动作的确认，不受 `/notify` 两个开关与静默模式影响。

### Changed

- 跨会话卡片正文的提示由「来自其他会话」改为「**❗来自其他会话**」，与当前会话的卡一眼可分。
- `/s list` 的行序改为「置顶优先，其余按最近活动降序」：置顶会话（`📌`）排在最前，`/s switch <编号>` 与 `/s pin <编号>` 的编号都按这个顺序解析。无置顶时顺序不变。
- `/workspace list` 标题由「按最近使用排序」改为「按添加顺序，共 N 个」：注册表顺序本就是添加顺序（新建的排最前，之后只有 GUI 拖拽会改），旧文案与实现不符。
- `/workspace list` 默认由不限条数改为 20 行，避免工作区很多时一次生成上百条分段消息、把微信发送额度全部吃满。

### Fixed

- `/s list current` 的当前目录匹配改用宿主的 canonical path 规则（`fs.promises.realpath`，与 `@deepseek-ai/dsh-workspace` 的 `realpathNormalize` 同源）：`C:\work` 与 `C:\work\`、含 `.`/`..` 段或混用分隔符的写法现在能匹配到同一批会话，不再误报「当前工作目录下暂无会话」。Windows 上大小写也一并折叠，与 GUI 工作区分组保持一致；目录不可解析时退化为 `path.resolve` 归一。
- `/workspace list` 的「◀ 当前」标记使用同一套规范化比较。
- `/s new` 复用空白会话时同样改用 canonical path 比较：此前若设置页 `cwd` 改过写法（尾斜杠、大小写）或 `/workspace switch` 传入的路径写法与会话 header 里记录的不同，`/s new` 会找不到可复用的空白会话而**不断新建**，同一目录下堆积多个空会话；现在与 GUI「新建会话」的复用行为一致。
- 跨会话任务完成/报错提醒的收件人解析（`watchedSessions` 未命中时的 workspace/cwd 回退路径）改用同一套规范化比较，避免 cwd 写法不同导致提醒发给错误的用户或落到「首个已知用户」兜底。
- 删除无调用方的死代码 `DshOps.workspaceOfSession`（此前只有 `dist/` 里的编译产物引用它）。

### 说明

- `/s switch <编号>` 的编号仍按**完整**列表校验（保持原行为）：默认列表只显示 20 行，但 `/s switch 25` 依旧能切到未显示的第 25 条。

## [0.9.11] - 2026-10-07

### Fixed

- 修复微信 `/preset switch` 无法写入 DSH 0.2 设置的问题：根据设置服务公布的命名空间写入 `agent-preset-registry.selectedDefault`，与 GUI 的默认 Preset 选择同步；保留旧版 `agent-presets.default` 接口兼容。
- 设置写入失败时明确提示「默认 Preset 切换失败，默认 Preset 未更改」，不再误报「已切换」或「仅本次进程内生效」，也不会继续修改空白会话的 Preset。
- 新增 Preset 切换回归测试，覆盖新版与旧版设置接口、新会话默认值、空白与已有内容会话，以及设置服务缺失和拒绝写入的情况。

## [0.9.10] - 2026-10-07

> 0.9.8、0.9.9 未发布到 npm，本次一并发布，变更合并记录于此。

### Added

- 非静默模式将思考与工具合并为过程分组消息，内容采用桌面端收起条目的规则：中文工具标题、思考首行、路径/描述、任务清单完成计数与变更；成功结果正文隐藏，失败仅显示一行错误。分组标题按类别汇总（如 `已读取文件并执行了命令`），并带 emoji（`⚙️ 🧠 📄 🔍 💻 🌐 📝 ✏️ 📋 ❓ 🤝`，失败为 `❌`）。

### Changed

- `engines.dsh` 由精确匹配 `0.2.0-rc.2` 改为 `>=0.2.0-rc.2`，允许在更高版本的 DSH 上安装；低于该版本的 DSH 仍会被拒绝安装。
- 出站文本改为官方微信渠道（[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)）的 `StreamingMarkdownFilter` 语义，不再一律剥掉 Markdown 标记：微信能渲染的语法（`**粗体**`、链接、H1–H4 标题、代码块、行内代码、`>` 引用、`---` 分隔线、表格）原样发送，只移除图片（整段）与 H5/H6 标记，并去掉包裹中文的 `*`/`_`/`***`/`___` 强调标记（内容保留）。
- 微信渠道提示词默认值去掉「纯文本」要求，改为「支持简单的 Markdown」；设置页已保存过旧正文的用户仍使用自己的值，可在设置页改回默认文案。
- 「任务完成提醒」改名为「跨会话任务完成提醒」（设置页、`/status`、`/notify` 输出、`/help` 同步），并去掉 `/notify` 帮助与设置页提示里多余的后台任务说明。
- 「跨会话决策推送」设置页提示去掉「后台任务完成 / 报错请用旁边的…」一句。

### Fixed

- 修复过程推送实际仍在正文结束后才发送的问题。DSH 为**每一帧**（start、每个 chunk、end）分配新的 `revision`，而旧代码要求 chunk 的 `revision` 与 start 帧相等，导致真实运行时所有流式 chunk 被丢弃，只能等 `assistant/message` 提交后才发送过程。现改为「`revision` 必须严格大于上一次处理过的值」，收到下一段正文的首个有效片段即发送待发过程，正文提交后单独发送。
- 补齐过程分组标题、思考及各类工具条目的 emoji。
- 流式思考与提交消息去重，不再重复推送同一段思考。
- 保持过程、正文及长消息分段的发送顺序：失败或限流时后续消息追加到 FIFO 缓存而不越过未发送的过程分组；退出登录、切换会话、静默开关与插件停止都会清理未发送的过程和流状态。
- 测试改用真实递增 revision 序列，并新增回归用例（此前用例统一传 `revision: 0`，掩盖了流式帧被丢弃的缺陷）。

## [0.9.7] - 2026-10-06

### Changed

- `engines.dsh` 改为精确匹配 `0.2.0-rc.2`，安装兼容性限定为当前桌面版 DSH 版本。

### Fixed

- 修复同一条微信入站消息重复投递、并发创建多个 DSH 会话的问题（#9）。按用户与有效服务端 `message_id` / `seq` 去重，同一用户的会话检查与创建串行执行；相同文本但不同消息身份及无有效身份的消息仍正常处理。
- 停止/重连将取消进行中的长轮询，丢弃旧轮询迟到的消息；重连等待旧轮询结束后只启动一个新轮询。插件停止后，尚在等待会话创建或媒体转换的消息不再启动推理。
- 修复 DSH 0.2 设置服务不再提供 `get()` 时，微信 `/status` 和实际繁忙投递错误回落到排队的问题。改为从 `describe()` 读取 `ui-conversation` 的当前生效值，桌面版插话/排队设置与微信同步。

## [0.9.6] - 2026-09-10

### Changed

- `/history` 默认只列真人轮次和助手回复；压缩检查点、插件注入、goal 续跑等合成 user 消息标成「系统」，用 `/history all` 一起查看。冷路径仍读完整原始日志，不改成模型当前面。
- `/history` 每条改成独立一块：`👤 你` / `🤖 助手` / `⚙️ 系统` 单独一行，正文保留原来的换行，不再压成一行摘要。

## [0.9.5] - 2026-09-10

### Fixed

- `/status` 的「权限」行和 `/perm list` 的「当前会话」标记在 DSH 0.1.5 上不再静默消失。`permissionPresets.current()` 改为传入活 Session（宿主自 0.1.2-alpha.2 起走 `sessionProjections.stateOf(session, "permissions")`），不再传事件数组。

## [0.9.4] - 2026-09-10

### Fixed

- `/s list current` 现在会提示并支持 `/s switch current <编号>`；紧接着使用普通 `/s switch <编号>` 也会复用最近一次列表的编号快照，切换时不再把当前目录列表的编号误映射到全量 `/s list`。

## [0.9.3] - 2026-09-10

### Changed

- 适配 DSH **0.1.5-rc.1**：`setup(agentCtx, agent)` 使用显式 Agent（`ctx.agent` 已移除）；仍兼容旧 host 把 Agent 挂在 context 上的单参数调用。
- 会话 raw-log 读取按代选择最高 `session.vN.jsonl[.zstd]`（当前为 v3）。迁移后 v0 源文件会留在目录里，不再误读旧代。
- 热路径日志优先 `session.snapshotEvents()`（0.1.5 公开 API），没有时再回落到旧的 `session.events` 数组。`/history`、`/s list`、`/preset switch` 空白判断、权限 `current()` 共用这一层。
- `engines.dsh` 提高到 `>=0.1.5-rc.1`。低于此版本的 DSH 安装时会被 `dsh plugin add` 拒绝。

## [0.9.2] - 2026-09-09

### Fixed

- `/model switch` 按已知提供商前缀切分，不再用第一个 `/` 截断模型 id。OpenRouter 这类 `openrouter/inclusionai/ling-3.0-flash-fin:free` 可以切到正确模型；漏写 `/` 时提示用法，不再当未知命令转发给 agent。

### Changed

- `/s list` 冷启动不再对每个会话走 `sessionQuery.listEvents()`（会完整 inspect 整本日志）。排序改为 live 会话内存日志 → 投影缓存 `sessionListMetadata.lastPromptAt` → 原始日志**从尾部**找最近一次 `user/message`；只有实际展示的 20 条才折叠 title + live preset。同一条日志的二次 `/s list` 仍是 stat 命中缓存。
- `/s new` 找可复用空白会话时，对明显已经聊过的会话（live 日志 / 投影缓存 / 日志大于空白 header）不再 `listEvents()` 整本 inspect；只有小文件且无法判定时才回落到完整读取。
- `/status`、`/s switch`、`/workspace switch`、`/preset status` 以及卡片来源标签不再走 host `readTitle()`（整本 inspect）；标题和 live preset 与 `/s list` 共用 raw-log fold。`/s switch` 编号与 `/s list` 使用同一套廉价 recency。

## [0.9.1] - 2026-09-07

### Changed

- 设置页连接表单只保留 `cwd` 与 `cardTimeoutMs`；`baseUrl` / `cdnBaseUrl` / `botType` / `textChunkLimit` 仍可写 `config.json` 或插件 `config:`，保存配置不会清空它们。
- 设置页 WeChat 卡标题行新增醒目的 **指令帮助** 按钮，展开与微信 `/help` 同源的本地命令列表（`GET /wechat/api/help`）。DSH 原生命令仍只在微信 `/help` 末尾按当前 profile 列出。

### Fixed

- 设置页字段 `?` 说明气泡改为挂到页面上并避开视口边缘，不再被设置对话框裁切。

## [0.9.0] - 2026-09-06

### Added

- 跨会话决策推送：`/notify on` 后，任意会话的权限/提问卡整卡推到微信（带来源标签与 `P{n}` 编号），可直接回复拍板，不必先 `/session switch`。
- 后台任务完成/报错提醒拆成独立开关 `notifyTaskEvents`（默认关）；微信 `/notify tasks on|off`，设置页「任务完成提醒」。

### Changed

- `/notify` 只控制决策卡，不再兼管任务完成/报错。关闸时入站拦截、`/rq` `/history` 都只覆盖当前会话，避免没推过的后台卡吞掉当前会话消息。
- `/status` 待处理拆成「当前」和「跨会话」两行。
- `/rq` 只关闭当前会话的卡（提问+权限）；其它会话用 `P1=/rq`。去掉「全部拒绝」；不再单独用 `/rp`。
- 设置页「跨会话通知」改名为「跨会话决策推送」，帮助文案与 `/status` 同步。

### Fixed

- 登出/换号时清掉 `pushedCardRpcIds`，避免推送去重标记残留。
- 只有一张跨会话提问/权限卡时，裸回复（文字或 `1`/`2`）发给当前会话，不再误答那张后台卡；后台卡必须 `P{n}=…`。
- `P1=/rq` 关闭对应编号的卡，不再当普通文本转发。
- 微信 `/rq` 关闭 plan 模式的 `exit_plan_mode` 卡片时，与 Web 点「Keep planning」一致，不再 abort。
- 普通提问卡 `/rq` 改为 Web 打 x 同源的 `ASK_CANCELLED`（`the user cancelled ask_user_question`），不再误报 `ASK_ABORTED`。
- `P{n}` 在提问卡和权限卡之间统一编号（先提问后权限）。跨会话 plan 卡回 `P1=文字` 不再被当前会话权限卡当成审批回复。

## [0.8.0] - 2026-09-04

### Added

- 设置页 WeChat 卡下方新增「已知限制」说明，告知用户微信 iLink 的 10 条/窗口上限（需在微信端主动发消息解锁 /next）和 24 小时互动窗口（超时后必须用户先发消息才能继续接收 bot 回复）。
- 微信渠道提示词可配置：设置页开关 + 可折叠正文编辑（默认收起）；微信 `/surface on|off|status`（别名 `/wxprompt`）切换开关。默认关闭。配置写入 `~/.dsh-wechat/config.json` 的 `surfacePromptEnabled` / `surfacePrompt`。
- 静默模式改为全局配置 `config.json` 的 `silent`（设置页 / `/silent` 共用），重新扫码后仍保留。

### Changed

- 适配 DSH **0.1.2-alpha.3**：审批/提问卡从已删除的 `apiProxy.events.mux` + `respond()` 改为 Host `approval/request` / `user-questions/request` waterfall 竞速（微信与 GUI 谁先答谁生效）。不再兼容 0.1.1-rc.2。
- Client 半部 `dsh.client.inject` 去掉已下架的 `@deepseek-ai/dsh-client-runtime`，改为 `dsh-client-ui-settings` + `dsh-client-ui-slots`。
- 用户消息 id 改由 `createUserMessage` 自行铸造（0.1.2 禁止调用方传入 `id`）；微信溯源改为记录铸造后的 id。
- 冷会话 `/history` 优先走 `sessionQuery.readSession()`（0.1.2 的 `listEvents` 不再带 `data`）。

### Fixed

- DSH 0.1.2：微信回答提问/权限卡后，Web UI 卡片一直不消失。瀑布竞速微信先返回时没有 abort 传给 GUI 的 `request.signal`，0.1.2 的 composer 卡只在该 signal abort 时才收起。现在给 `next()` 分叉一份 GUI signal，微信答完或取消后再 abort 这份（不碰 turn 的 `exec.signal`），Web 卡会随 Gateway `cancel` 帧收起。
- flush 剩余摘要（`✅ 已发送 N 条…`）和 `/status` 正文发送失败时不再写入 outbound 缓存。原先真实缓存发不出去时，这些控制回执会把自己再塞进队列，表现为「已发送 0 条」后缓存条数随 `/status` / `/next` 递增。管理命令仍会先自动 flush。
- `/status` 会话级投影截断不再切开 emoji 代理对；发送前会清洗孤立 surrogate。这类正文会让 iLink 返回 `ret=-1 invalid request`，flush 卡在队头「已发送 0 条」。flush 遇到无法投递的缓存会丢掉该条并继续发后面的。
- 微信渠道提示词在 DSH 0.1.2 后失效：`createUserMessage` 禁止调用方传入 id 后，`markWechatMessage` 写在 `followup` 返回之后，而 `agent.followup` 会同步发出 `agent/inbox/spliced`，splice 处理器把刚设的 `"wechat"` 覆盖成 `"gui"`，assemble 时永远读到空上下文。改为在 followup/steer **之前**记录铸造 id；`user/message` echo 命中微信 id 时重新标 wechat。
- 设置页「静默」在重新扫码后被取消勾选、保存也不生效：静默原先只写在会被 `relogin` 清空的 per-user `state.json` 上，无绑定用户时 Web 保存直接跳过。现改为写入 `config.json` 的全局 `silent`，无用户也可保存；重新扫码后的新用户继承该开关。
- 设置页在 0.1.2 上因缺失 `dsh-client-runtime` 无法挂载的问题。

## [0.7.2] - 2026-08-27

### Changed

- 设置页去掉「重连」按钮，并移除 `/wechat/api/reconnect`。重新扫码已经覆盖换号/重新登录；保存网关配置后仍会在内部重启长轮询。

### Fixed

- 退出登录 / 重新扫码不再继续锁定上一个微信用户：会清空内存里的 single-user peer、`state.json` 用户表和旧 bot 的 `sync-buf.json`。换微信扫码后，新号的入站不再被记成 `ignore inbound … (single-user peer is <旧号>)`。无 token 启动时同样释放旧绑定；保存网关配置触发的内部重连仍保留当前用户。

## [0.7.1] - 2026-08-27

### Fixed

- 修复微信真实连续发送上限响应被误判成功：`sendmessage` 返回 HTTP 200 + `{"ret":-2,"errmsg":"prepare failed"}` 时，现在会将窗口校准为 10 并把未投递消息写入唯一单用户 FIFO，不再静默丢失。其他非零 `ret` / `errcode` 也不再被当作发送成功。
- 单用户出站计数与待发队列持久化到 `state.json`：普通 DSH 更新、重启和重连后恢复，不再从 0 重新计数；下一条微信入站仍重置窗口并自动补发，登出、重新扫码或 `-14` 恢复彻底失败时清空。
- assistant 回复与 `send_wechat` 发送串行共享同一份 10 条预算；窗口已满时不再额外发送必然失败的缓存提示。

## [0.7.0] - 2026-08-27

### Changed

- 单用户：只服务第一个微信 peer，后续不同 `from_user_id` 入站记录日志并忽略。
- 取消应用层 context token 门闩：不再持久化 / 回灌 `lastContextToken`，也不再因「没有 context token」把出站 park 进 outbound cache。iLink 请求体里若入站带过 `context_token` 仍会附上，但发送只看 bot token。
- bot token **没有**（未登录 / 退出 / 重新扫码中）：出站丢弃并打 `drop outbound (bot token missing)`，不进缓存。
- bot token **`-14` 恢复中**：消息和审批/提问卡写入 outbound cache（`park outbound (-14 recovering)`）；`getUpdates` 恢复成功后自动静默补发（`flushing N parked item(s)`）。连续 notifyStart 失败达到重扫阈值则丢弃缓存（`re-scan required — discarding parked outbound`）。
- 退出登录 / 重新扫码：仍清空 outbound 队列，不把 GUI 窗口里的回复补发到微信。

### Added

- `/status` 在当前会话有未回答的提问卡 / 权限卡时增加 `• 待处理:` 行。
- `/history` 在聊天摘要之后完整重发当前会话仍 pending 的提问卡 / 权限卡（可直接回复）；无历史但有卡时也会重发。
- `/history` 单条摘要截断从 300 字提到 800 字，超出仍加 `…`，完整原文（≤ 800）原样输出。
- `/history` 最近的助手消息不再截断，完整原文原样输出（即使超过 800 字）；其它条目仍按 800 字 + `…` 截断。长助手消息会被 `splitText`（`textChunkLimit=4000`）自动拆到下一条微信。
- `/status` 加 emoji 颜色标记（iLink 文本消息不支持 `<font color>`，靠 emoji glyph 在微信端彩显）——
  - 静默模式 `on` (停止转发到微信) → 🔴，`off` → 🟢
  - 跨会话通知 `on` → 🟢，`off` → ⚪
  - Agent `running` → 🟢，`idle` → ⚪，`（未加载）` → 🔴
  - 繁忙投递 `steer` → 🟢，`queue` → ⚪
  - 权限 `danger-*` 行加 🔴
  - `• 待处理:` 行整行加 🔴（需要立即回复）

### Fixed

- HTTP 200 + `errcode: -14` 的 `sendmessage` 不再被当成发送成功。
- `logout` / `relogin` 清空 outbound 队列和静默缓冲，避免退出后在 GUI 聊的回复在重新扫码后被下一条微信 flush 出去。
- 重启 / 点「重连」后 `session/event` 与 mux 整条 feed 静默：`reconnect`/`logout`/`relogin` 只停 iLink 长轮询，不再 `stopMux`；`attachMux` 做成单例循环（HMR 不再双开）；`session/event` 兼容 `session.id` / `header.id`；inject 10s 未回调、mux 开流/断流都打日志。

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


