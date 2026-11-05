# dsh-wechat 开发文档

面向维护者：架构、配置参考、实现细节与已知边界。用户向的简介、安装与命令表见 [README](../README.md)。

## 架构

```
微信 (iLink) ── long-poll getupdates ──► dsh-wechat (Cordis host plugin)
    ▲                                      │
    │ ◄── sendText/sendMedia ──────────────┤
    │                                      ▼
    │                          DSH 进程内服务（零 @deepseek-ai 运行时依赖）
    │        agents.create/resume ── agent.followup（消息入）
    │        session/event ── assistant/message、turn/end（消息出）
    │        approval/request · user-questions/request waterfall ── 审批/提问卡（镜像 GUI，谁先答谁生效）
    │        tools.register ── send_wechat 工具
```

> 设计说明：微信端是 GUI 的**第二客户端**，功能不多也不少。

以静态 Cordis 插件交付，零运行时 `@deepseek-ai` 依赖，直接调用 DSH 进程内服务。

## 设置页实现

客户端半部通过 `dsh.client` + `exports["./client"]` 声明（与 dsh-mcp-manager 同款交付），挂载到 `settings.section` slot（nav 顺序 40）：

- **状态区** — 登录阶段（未登录/等待扫码/已扫码，待确认/已登录/登录失败）、Bot ID、监控运行状态、已绑定用户数；未登录时直接显示二维码，扫码确认后自动进入已登录；同一区放 `重新扫码`（清除 token 重新登录）与 `退出登录`
- **可折叠分组** — 设置按用途分成 6 组，**默认全部收起**，收起时右侧显示由当前配置实时算出的摘要（例如「打字合并：已关闭 · 每条消息各自一轮」），展开才编辑：

  | 分组 | 包含 |
  |---|---|
  | 连接与默认行为 | `cwd` / `cardTimeoutMs` / `sendWechatRateLimitPerMinute` / `allowedUsers` |
  | 消息推送 | `工作步骤展示`（极简 / 简洁 / 标准）/ `跨会话决策推送` / `跨会话任务完成提醒` + `完整显示任务完成回复`（完成提醒关闭时置灰）/ `状态详细程度` |
  | 打字合并 | `打字合并` 总开关 + `mergeSilenceMs` / `mergeMaxMsgs` / `mergeForcedReleaseMs` / `合并后缀 .. 与 !!`（总开关关闭时参数置灰，但值仍随保存提交，不会丢配置） |
  | 图片与文件 | `图片/文件与文字合并发送` 总开关 + `mediaHoldMs`（等待上限，总开关关闭时置灰）+ `以 @引用 方式交给 AI`（独立开关，一直可点，因为交付措辞对所有附件生效） |
  | 微信渠道提示词 | `surfacePromptEnabled` + 提示词正文 |
  | 安全边界 | `allowRemotePermissionEscalation` / `allowAnyFilePath` / `maxOutgoingFileBytes` |

  展开状态记在浏览器 localStorage（`dsh-wechat/settings-open`），不进 `config.json`；存储不可用时退化为「能展开但不记忆」，不会报错。
- **保存** — 底部 `保存配置` 一次提交全部字段；有改动未保存时按钮旁显示 `● 有未保存的修改`。`baseUrl` / `cdnBaseUrl` / `botType` / `textChunkLimit` / `finalOnlyIdleMs` / `finalOnlyCeilingMs` 仍可写 `~/.dsh-wechat/config.json` 或插件行 `config:`，设置页保存不会覆盖它们；`finalOnlyIdleMs` / `finalOnlyCeilingMs` 是极简模式的静默期与硬顶。网关参数变更会自动重启长轮询；存储于 `~/.dsh-wechat/config.json` 与 `state.json`
- **指令帮助** — 卡片标题行的 **指令帮助** 按钮展开一份说明书：顶部一句说明 → 搜索框 + 全部展开/收起 → 6 个按用途分的组（常用 / 会话与项目 / 模型与权限 / 输出节奏 / 引用与回看 / 待处理卡片）→ 23 条指令，每条一句简短说明 + 行尾 **?**。**?** 悬浮出前 2 条示例并提示「共 N 条示例，展开查看全部」；点整行（或直接点 ?）展开该指令的**全部**示例，每条示例可点击复制。展开状态记在 `dsh-wechat/help-open`，不进 `config.json`。同一份文案也渲染成微信 `/help`（见下一节），DSH 原生命令仍只在微信 `/help` 末尾按当前 profile 列出。文案要求**简单但不口语**：说清做什么，不写语气词与比喻
- **已知限制** — 页面底部的告警盒，同样可折叠（默认收起），列出 iLink 的 10 条窗口、24 小时互动窗口，以及「出站语音气泡不可渲染」（见「已知边界」里的语音条目）

与宿主通信走插件自己的 HTTP API（`/wechat/api/status|help|config|relogin|logout`），客户端零 `@deepseek-ai` 依赖。

### 帮助文案的单一来源（`src/help-catalog.ts`）

`src/help-catalog.ts` 是**所有用户可见帮助文案的唯一来源**，同一套字符串同时喂给两个消费方：

- **设置页「指令帮助」** —— 经 `/wechat/api/help` 的 `catalog` 字段送到浏览器，渲染成 6 个分组、23 条命令、每条命令的**全部**示例（行尾 `?` 悬浮出前 2 条，展开看全部，示例可点击复制）；
- **微信 `/help`** —— 由 `bridge/slash.ts` 渲染，两级：
  - `/help` → **一览**（54 行 / 1899 字）：代码块里每条命令一行 `/命令 (简写)  说明`，多子命令的命令下一行列出全部子命令（`/s list`、`/s list current`、`/s switch`…，有简写的一律用简写；`list current` / `switch current` 是独立形式，必须单独列出）；
  - `/help <命令名或简写>` → **该条的例子块**：`# /命令 — 说明` + `也可以写成：…` + 代码块里每条示例一行 `示例  说明`。`/help s` 与 `/help session` 输出完全相同。

**一套措辞，简单但不口语**：`summary` / `note` 是两端共用的唯一文案，所以它们必须同时满足两种场景——面板里要好懂，微信等宽表格里不能是絮絮叨叨的散文。写作要求：说清「做什么」，不写语气词与比喻（写「立即发送暂存的结论」，不写「别憋了，现在就把暂存的结论发给我」），`summary` ≤ 40 字、`note` ≤ 30 字。历史上这两端曾各用一套字段（面板白话 + 微信 `terse`），后来合并——维护两份同义文案只会漂移。

**为什么用代码块**：微信气泡不会横向滚动，长行只能折行，而折行会落在反引号中间，把一条可复制的命令劈成两半（`…（编号看 /` + `s list）`）。代码块是客户端那个**可横向滑动**的等宽框，所以表格整体放进 ``` 里，并按显示宽度对齐（中文算 2 列，见 `charWidth` / `padTo`）。

改文案只需改这一个文件。约束由 `tests/help-catalog.test.ts` + `tests/help-topic.test.ts` 强制：

1. **与 `/help` 同步** — catalog 的命令集合必须等于一览里 `/xxx` 行的集合，漏写/多写都红；
2. **示例要全** — 每个 `subcommands` 关键字至少有一条示例用到它，且**每条命令的每个 `subcommands` 都必须出现在一览里**（`/session` 因此必须写满 list / list current / switch / switch current / pin / unpin / new / status），这是「例子不完整」的结构性防线；`subcommands` 是**拼写关键字**，所以 `list current`、`switch current` 这类两段形式单独占一项，不会被 `list` 吞掉；
3. **示例必须可执行** — `kind: "command"` 的每行都要过 `isBypassSlashCommand`（`/rq` `/rp` 用各自 parser、`P1=/rq` 用 `parsePnCardReply`），否则用户复制出去的命令会被当成聊天转给 agent；
4. **示例必须进得了 `/help <命令>`** — 每条 `examples[].line` 与它的 `note` 都要逐字出现在该条的例子块里（面板看到什么，微信就看到什么）；
5. **别名只放简写** — `s` / `ws` / `p` / `sl` / `fo` / `f` / `mg` / `md` / `h` / `?` 可以进 `aliases`；`permission` / `busy` / `watch` / `notice` / `wxprompt` 这类「换个说法」**不进**（parser 照常接受，但 `/notify (watch, notice)` 会被读成三条命令）。测试直接断言别名必须比命令名短、且不是另一条命令的全名；
6. **文案纪律** — `summary` ≤ 40 字、`note` ≤ 30 字、不含 `waterfall`/`runtime context`/`mention`/`base64` 等术语、示例行不含 `<…>` 占位符；
7. **一条消息装得下** — 一览 ≤ 2000 字 / ≤ 56 行、单个例子块 ≤ 550 字（微信单条 4000 字上限，拆分会让帮助变两段）。行数上限随 `/fork` 从 55 抬到 56；合并 `/steps` 后实测 1899 字 / 54 行，真正卡住体积的仍是 2000 字那条；`/history` 因此不印子命令行——`list` 是默认形式、`show` 写在 `usage` 与示例里，而那一行（约 55 字）会把 1899 字顶过 2000 字上限；
8. **表格真的在代码块里** — 每个渲染结果的 ``` 围栏必须成对且非空，保证折行问题不会悄悄回来。

`..` / `!!` 是消息后缀而非命令，用 `kind: "text"` 标注；测试限定只有 `/merge`（两个后缀）与 `/next`（任意消息都会冲刷缓存）可以出现 text 示例。

Markdown 由微信客户端渲染，`formatForWeChat()` 的过滤器会剥掉部分语法，所以测试还会断言**一览与每个例子块过完过滤器后一字不变** —— 否则用户看到的是被吃掉的标记。

`/help` 后面的一切都是**命令名**，所以解析不到的一律仍是帮助请求：`/help fuck`、`/help nope`、乃至整句 `/help me write a test` 都回「⚠️ 没有 /xxx 这条命令」+ 完整一览，**不转发**。理由：`/help` 是「查帮助」这个动词，以它开头的行不是聊天；把它转发出去，用户就会看到「未知命令 /help」——他明明在求助。`man` 对不存在的页也是报错 + 自己的用法，不是把词忽略掉。bare 命令（`/s`、`/steps`、`/merge`…）的语义**完全不变**，展开例子只有 `/help <命令>` 一个入口。

**「未知命令」只留给真的未知命令**：一览里印着的名字永远不能回「未知命令 /model」——那等于告诉用户帮助在骗他。所以每个管理命令的裸形式都有确定行为（`/s` `/ws` `/p` `/model` `/perm` 报状态，与 `/reasoning` `/enter` `/notify` `/surface` 一致），参数写错则回该条的 `usage` 行（`commandUsageHint`），`/help <任意文字>` 回「没有这条命令」+ 一览，三者都不再落到未知命令分支。`detectUnknownSlashCommand` 现在跳过所有 `LOCAL_COMMAND_NAMES` 里的名字，只管真未知的（`/nope`），文案与转发行为不变。


## 配置参考

优先级：内置默认 ← 插件行 `config:` ← `~/.dsh-wechat/config.json`（设置页写入，覆盖前两者）。插件行可带 `config:`：

```yaml
# 例：追加到 profile 的 cordis.patch.yml
- id: dsh-wechat
  config:
    cwd: 'C:\projects\my-project'
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 网关 |
| `cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体 CDN |
| `botType` | `"3"` | iLink bot 类型 |
| `storageDir` | `~/.dsh-wechat` | token/sync-buf/会话映射/临时文件 |
| `cwd` | `process.cwd()` | 新会话工作目录 |
| `textChunkLimit` | `4000` | 微信单条消息长度上限 |
| `cardTimeoutMs` | `1800000` | 提问/权限卡软超时（30 分钟） |
| `crossSessionNotify` | `false` | 跨会话决策推送总闸（任意会话的权限/提问卡整卡推送，微信直接回复） |
| `notifyTaskEvents` | `false` | 跨会话任务完成/报错提醒（独立于决策推送，默认关） |
| `notifyTaskFullReply` | `false` | 跨会话**完成提醒**里的内容量：`false`（默认）= 该会话这一轮回答的最后 80 字摘要（`> ` 引用块，尾部截断加 `…`）；`true` = 整段回答全文，不再截断也不再逐行引用（出站 markdown 过滤会把行首 `>` 当标记吃掉）。**只决定展示多少，不决定发不发**——`notifyTaskEvents` 关闭时本键不产生任何提醒。全文走 `maskCredentials`（只掩 API key / JWT / `Bearer ***` 这类确定凭证），因为 `maskSecrets` 的通用 hex/base64 规则会把回答里的每个 commit SHA 都换成 `***`；摘要仍走 `maskSecrets`。设置页「完整显示任务完成回复」同款；`/status` 在提醒开启时多一行 `• 完成提醒内容: 全文｜摘要`，`/notify status` 也会显示 |
| `workSteps` | `"standard"` | 工作步骤展示总闸：`"minimal"` 整条任务只发一条结论、`"concise"` 每轮只发最终回复、`"standard"` 过程与回复都发。旧 `silent` / `finalOnly` 在加载时迁移，旧命令不再提供 |
| `finalOnlyIdleMs` | `45000` | 极简模式静默期：任一活动事件（助手正文、轮次结束、`agent/status` 空闲/运行）都会把它重新推后 |
| `finalOnlyCeilingMs` | `600000` | 极简模式硬顶：从第一次暂存起算，到时无论是否仍在续跑都强制交付一次（10 分钟） |
| `sendWechatRateLimitPerMinute` | `10` | `send_wechat` 工具每分钟推送上限（滑动 60 秒窗口；`0` = 不限）。超限时工具**明确返回失败**并告知模型，而不是继续刷用户 |
| `allowedUsers` | `[]` | 入站白名单（微信 user id 数组）。**空 = 现有行为**：首个入站者成为绑定对端；非空 = 只有名单内的 id 会被处理，其余在去重/预算/建会话/命令分发之前拦下并记日志，绝不回复。**升级播种**：`config.json` 里从未写过该键、且 `state.json` 已有绑定用户时，启动会把该用户写入这里并持久化（微信里提示一次，`/status` 显示你的 id）；显式存过 `[]` 则永不覆盖 |
| `allowRemotePermissionEscalation` | `false` | 是否允许微信 `/perm default` 放宽**全局**默认权限。关闭时：解析出的沙箱为 `danger-full-access` 或审批为 `never` 的预设被拒绝并提示到 DSH 设置页操作；不放宽的写入仍允许；会话级 `/perm switch` 不受影响 |
| `allowAnyFilePath` | `false` | 是否允许 `send_wechat` 发送任意路径的文件。关闭时只允许**调用会话**工作目录或已注册工作区内的文件（`fs.realpath` 归一后比较，`..`/符号链接逃不出去） |
| `maxOutgoingFileBytes` | `20971520` | `send_wechat` 发送文件的字节上限（20 MiB）。超限在 `stat` 阶段即拒绝，不会读进内存；缓存队列里的文件在冲刷时也会重新校验 |
| `mergeEnabled` | `false` | **打字合并总闸（默认关闭）**：开启后连续几条微信消息合并成一轮。`/merge on\|off` 与设置页同款；关闭时每条消息各自一轮 |
| `mergeSilenceMs` | `3000` | 合并静默窗口（毫秒）：窗口内到达的消息继续追加；`0` = 关闭窗口（等同关闭合并）。乱序更旧的消息不会延长窗口 |
| `mergeMaxMsgs` | `10` | 单批消息条数硬上限：达到即立刻合并发出（防御性上限，永不超过） |
| `mergeSuffixTokens` | `true` | 是否识别正文末尾的 `..`（继续追加）与 `!!`（立刻提交）；开启时后缀会从正文中去掉 |
| `mergeForcedReleaseMs` | `180000` | 强制放行上限（毫秒，3 分钟）：无论窗口、`..` 暂挂、还是上一批仍在投递，到点一定发出——「宁可两句话一轮，也不让通道卡死」 |
| `mediaMergeEnabled` | `false` | **图片/文件合并总闸（默认关闭）**：开启后，**不带文字说明**的图片/文件/视频先暂存，等你随后那条文字一起作为**一轮**发出（文字在前、附件在后）。同一条消息自带文字说明时立即发送，不等；语音不参与。`/media on\|off` 与设置页同款 |
| `mediaHoldMs` | `180000` | 暂存附件等待随后那条文字的上限（毫秒，3 分钟）。超时就把已暂存的附件单独发出；**实际等待取它和 `mergeForcedReleaseMs` 中更短的那个**，所以合并窗口的活性上限同样罩住它（两者默认都是 180000，即默认情况下它就是「一轮最多能被挂多久」） |
| `mediaAtRefEnabled` | `false` | 附件交付**措辞**：`false`（默认）= 「文件已保存到: 路径」纯文本，任何宿主上都能正常阅读；`true` = 按宿主 `@路径` 语法交付（`@"…"` 表示含空格），与 GUI 拖文件同一条链路，消息里是一个**可点开的引用**——但它依赖宿主挂载了文件引用插件，没挂载时只会显示成一行裸 `@C:/…`，所以默认关闭。两者都只给指针，**文件内容永不内联**（0.12 的内联行为已在 0.13.0 删除，这个开关救不回来）。`/media at\|path` 与设置页同款 |
| `surfacePromptEnabled` | `false` | 微信渠道提示词总闸（微信消息驱动时注入，GUI 消息时仍隐藏） |
| `surfacePrompt` | 见默认中文 | 注入正文（设置页编辑；含 `{{` 会被打散以免打断 DSH interpolate） |
| `statusMode` | `"brief"` | `/status` 末尾「会话级状态」显示多少：`brief` 只出 `[模式]` 与 `[后台任务]`；`full` 出 `[模式]`/`[用量与统计]`/`[会话]`/`[其它]` 四段全量，再加 `[后台任务]`。**只影响这一段**，上面的工作区/会话/模型/权限/各开关行两种模式完全一致。`/status brief\|full` 与设置页「状态详细程度」同款；非法值（手改 `config.json` 写 `"verbose"`）在加载时丢弃并回落 `brief` |

## 命令接入方式

### 与 DSH 原生命令同步

微信消息进入后，bridge **先**向 DSH 的 `ctx.commands` 注册中心查询当前会话已注册的命令（这是 DSH 内置的人类 slash 命令注册服务，由 `@deepseek-ai/dsh-commands` 提供；`/plan`、`/goal`、`/compact` 等命令都由各自的 bundle 在那里注册）。命中即直接交给原生 handler 执行，并把结果回执渲染到微信——和 GUI 走同一条命令管线。

未注册的命令回落到本仓库硬写的本地命令表（`/steps`、`/next`、`/rq`、`/workspace`、`/session` 等）。**能认出来是本地命令、但这一行没解析成功时，只回用法，绝不转发**。四种情况都算「认出来了」：

- 子命令写错：`/s lsit`、`/ws swtich 2`
- 参数不对：`/model foo`、`/reasoning high`（少了 `switch`）
- 少打空格：`/workspacelist` → 回「是 /ws list 少了空格吗？」
- 名字本身打错：`/stauts` → `/status`、`/sessoin list` → `/session`、`/models` → `/model`（只有输入 ≥5 字符、候选 ≥4 字符、编辑距离 ≤2、且最近候选唯一时才纠错；`/plan`、`/goal`、`/foo` 这类短名一律不动）

`commandUsageHint()` 负责这句话：**没看懂「…」+ 用法 + 两个例子 + `/help <命令>`**，然后 `return`。`/help` 不印的长拼写（`/permission`、`/busy`、`/watch`、`/wxprompt`）按最短拼写（`/perm`、`/enter`、`/notify`、`/surface`）回。真正没人认领的名字（`/nope`）才按「未知命令」提示并作为文本转发——因为未注册的原生命令（`/plan` 在没有装对应 bundle 的 profile 里）可能只是一句想让模型读懂的话。DSH 的 `ctx.commands` 服务在某些极简装配下可能不挂载（缺失时会打一次 warn），这种情形行为完全等同之前的版本。

这条边界的理由是上下文成本：一条打错的命令转发出去，agent 会对一句用户根本没打算说的话作答，错误命令进了 transcript，后面每一轮都得绕开它。开头带斜杠不是手滑——用户在对着命令说话，那就由命令来回答（`/help`、`/at` 一直如此）。

打错的命令同样会**绕过待处理的提问/权限卡**（`isBypassSlashCommand` 已包含 `isMistypedLocalCommand`）：它是一次命令尝试，不是卡片的自由文本答案。否则一个笔误会同时毁掉命令和卡片。

### 强制透传（`/raw`）

上面那一整套拦截——原生注册中心、本地命令表、`/help`、用法提示、未知命令提示、卡片吞并——全部由 `/raw on` 一次性让开：

- `/raw on`：之后每条消息**原样**转给 agent，斜杠前缀保留，网关一句话都不回。`handleMessage` 在 `tryNativeCommand` 之前检查 `passthroughActive()`，命中就 `enqueueInbound` 后直接 `return`，后面的所有分支都不可达。`bypassCard` 也读它，所以待处理卡片不会把透传消息当成自己的答案（卡片保持 pending，不被拒绝）。
- `/raw once`：只透传下一条，然后自动关闭。覆盖「就把这一行 `/xxx` 交给模型」的常见场景，用完不会留下一个「机器人不再响应命令」的模式。
- `/raw off`、`/raw`（查状态）：**透传期间仍然有效**。开关如果在聊天里关不掉就是陷阱，所以 `parseRawCommand` 在任何拦截之前执行。
- **不持久化**：`passthrough` 不在 `EDITABLE_KEYS` 里，重启插件必然回到「命令优先」。运维重启时无法知道机器人当前是不是聋的，所以这个状态不允许穿越重启。
- `/status` 在开启时多一行 `• 强制透传: on（命令不再拦截）`（warning 色），armed 的 once 显示 `once（下一条）`。

`tests/passthrough.test.ts` 逐条钉住「十种原本会被拦截的行，透传后都变成零回复 + 一次原样转发」，以及 once 的自动回位和「重启后关闭」。

所以：**DSH 加任何新的 `/xxx` 命令 bundle，微信端无需改动即可识别**——只要它是按 DSH 命令注册契约挂上去的。例如装有 `dsh-plan-mode` 时微信发 `/plan off` 收到原生回执 "Plan mode off."；装有 `dsh-command-goal` 时 `/goal <目标>` 收到原生 "Goal created ..."；装有 `dsh-command-compact` 时 `/compact` 收到 "Compacted N history items (~M tokens)."——与 GUI 同款回执，由原生 handler 自己算、自己发。

`/help` 在末尾加一段 `── DSH 原生命令（当前 profile 已注册）──`，列出当前 profile 实际注册的所有原生命令；本地命令表里已有的名字自动去重，不会重复出现。这一段保持纯文本 `• /name  [hint] — desc` 格式（由宿主描述符生成，不是 catalog 文案），`/help <命令>` 的例子块里不出现它。

### 本地命令的语义细节

其他 `/xxx`：父命令命中但没解析成功的一律只回用法（不转发），没人认领的名字才作为文本转发给 agent；审批/提问卡双端同弹，已在其他端处理的卡会提示。`/raw on` 期间上述规则全部暂停，见上文「强制透传」。

在微信里回答卡片后会收到回执：`✅ 已允许权限卡 P{n}（工具名）。`、`⛔ 已拒绝权限卡 P{n}（工具名）。`、`✅ 已回复提问卡 P{n}。`——`P{n}` 就是卡片上印的编号，一次 `P1=1 P2=2` 会各回一条。回执是对你自己刚做的动作的确认，**不受** `/notify` 两个开关与工作步骤展示影响。来自其他会话的卡片在正文里标 `❗来自其他会话`。

所有命令均直接映射 DSH 原生服务（`workspaceRegistry` / `sessionQuery` / `agentPresets` / `agentDefaultModel` / `permissionPresets`），默认值与 GUI 设置页同源同步。

各命令的完整参数与边界：

| 命令 | 实现要点 |
|---|---|
| `/status` | 工作区、会话、Agent、待处理(当前)/待处理(跨会话)、当前会话 Preset、模型、上下文、权限、新会话默认 Preset、工作步骤、繁忙投递、跨会话决策推送、跨会话任务完成提醒；末尾「会话级状态」按 `statusMode`（默认 `brief`）显示——`brief` 只出 `[模式]`（plan / goal / subagent / todos）与 `[后台任务]`，`full` 另加 `[用量与统计]`（tokenUsage / contextPressure / contextBreakdown / sessionStats / subagentTiming）、`[会话]`（title / sessionListMetadata / permissions / imageLimits）、`[其它]`（未识别 key 自动归类），DSH 加新 plugin 自动出现。`[后台任务]` 读宿主 `ctx.jobs`（`job_list` 那套），**只统计当前绑定会话名下的后台任务**（`list(sessionId)` 的 owner fence + `owner === sessionId` 二次过滤，别的会话与无主任务都不算），输出总数与运行中明细（`running`/`stopping` 都算运行中，最多列 5 条，其余合成「另有 N 个运行中」）；**一个任务都没有时整段不出现**（不留 `共 0 个` 占位），有任务但都不在跑时只出一行 `⚪ 共 N 个`；服务缺失、未绑定会话或读取抛错时同样整段省略，`/status` 永不因此失败。`/status brief\|full` 切换并持久化到 `config.json` |
| `/workspace (ws)` | `list` 默认显示 20 个、按添加顺序（新加的排最前），`all` 或显式数量看更多；显示各工作区会话数，不含已归档；switch/add 回复会写明恢复的会话名字和完整 id，跳过已归档，并附一行 `• 预设: … · 模型: … · 思考等级: …`（见 `/session` 的说明）；该目录无可见会话时提示发送消息将创建（没有会话可描述，该行省略） |
| `/session (s)` | `list` 默认最近 20 个，`all` 或显式数量看更多，标记当前，不显示 GUI 已归档会话；**置顶会话排在列表最前并标 `📌`**，`pin`/`unpin` 省略编号时作用于当前会话，带编号时按 `/s list` 的行号解析；`list current` 只看当前工作目录——cwd 按宿主 `fs.promises.realpath` 规则归一（尾斜杠/`..`/大小写差异都能匹配），推荐用 `switch current <编号>` 按同一列表切换；紧接着直接 `switch <编号>` 也会复用最近一次列表编号；普通无列表上下文时 `switch <编号>` 对应全量列表；`new` 复用当前工作区空白会话，与 GUI「新建会话」同款，无空白才新建。**`switch` / `new` 的回复固定多一行 `• 预设: X · 模型: provider/model · 思考等级: Y`**：切换/新建改变的正是这三项，直接答在回复里，省掉再发 `/status`（或 `/preset status` + `/model status` + `/reasoning status`）。预设取该会话的 live 值（与 `/status`「当前会话 Preset」同源，`agent-preset/selected` 事件优先），无记录时回落部署默认（新建会话必然落到这里）；模型走 `/status` 同一条优先级链（本会话 override > `modelSelection` projection > 最近请求记录 > Agent 创建参数 > 部署默认）；思考等级取该模型适配器自己的名称（`high` 显示为 `/reasoning list` 里的中文名），未设置时写「默认」而不是留空。三段各自独立降级——预设名缺失、宿主没有 `llm` 服务、等级名查不到，都不会让整行消失或让回复失败 |
| `/fork` | 见下方「`/fork` 按轮次分叉」 |
| `/preset (p)` | `switch <名称\|编号>` 切**当前会话**（走宿主 `agentPresets.select`，会话第一条消息前才允许，已开始的会话明确拒绝并提示 `/s new`）；`default [名称\|编号]` 改**新会话默认**（写 DSH 设置、与 GUI 同步，裸形式只读）；`status` 分两行报「新会话默认」与「当前会话」 |
| `/model` | 切换立即作用于当前会话 + 设为默认；与 GUI 模型选择器同源，走宿主 `sessionController.selectModel`，GUI 里也会立刻显示新模型；当前推理等级若新模型支持则一并保留，否则清空 |
| `/perm` | `switch` 实时切当前会话；`default` 写 DSH 设置，新会话生效 |
| `/reasoning` | 查看当前/默认与模型支持的等级；`switch <等级>` 实时 + 写默认，与 `/model` 一样走 `sessionController.selectModel`，GUI 同步；`default` 恢复模型默认 |
| `/enter`（`/busy`） | 读写 DSH 设置 `ui-conversation.busyEnter`，与 GUI「繁忙时 Enter 键行为」同源同步；空闲会话始终新开一轮 |
| `/steps [极简\|简洁\|标准]` | 工作步骤展示。`极简`：跨轮次暂存，整条任务停下后只发一条最终结论；`简洁`：每轮只发最后一条助手正文；`标准`：思考与工具合并为「执行过程」，正文独立发送。不带参数或 `status` 显示当前档位与暂存条数。⚠️ `/f` 是 `/flush` 的别名，**不是** `/steps` 的 |
| `/merge`（`/mg`） | `status` 显示窗口/上限/强制放行/当前暂存条数；达到条数上限、`!!`、或强制放行上限时一定发出；乱序的旧消息**不会**延长窗口；`off` 先把暂存的消息作为一轮发出去再关闭 |
| `/media`（`/md`） | `on\|off` 控制附件暂存；`at\|path` 只切换措辞；`off` 先把暂存的附件作为一轮发出再关闭 |
| `/flush`（`/f`） | 立即取回极简模式暂存的最终结论，不必等静默期；没有暂存内容时提示为空 |
| `/surface`（`/wxprompt`） | 微信渠道提示词注入开关（默认关）；正文在设置页编辑，不在微信改 |
| `/notify`（`/watch`） | 跨会话决策推送总闸，默认关闭；`/notify tasks on\|off` 单独开关跨会话任务完成/报错提醒 |
| `/history` | 见下方「`/history` 按轮次回看」：默认最近 5 轮，末轮全文、其余简写，`show <编号>` 看全文；当前可回答的提问/权限卡会完整重发（决策推送开启时含其它会话） |
| `/at` | 见下方「`/at` 引用」 |
| `/skill` | 见下方「`/skill` 查看技能」 |
| `/stop` | 中断当前任务 |
| `/next` | 继续发送因微信限制被缓存的消息 |
| `/rq` | 关闭当前会话的待处理卡（提问+权限）；其它会话用 `P1=/rq` |

### `/fork` 按轮次分叉

```
/fork                      # 同 /fork list
/fork list [all|数量]       # 每轮一行，默认最近 20 行，并显示「共 N 轮」「显示 20/37」
/fork show <编号>           # 第 N 轮的完整提问与完整回复
/fork switch <编号>         # 从第 N 轮末尾分叉，并把微信绑定切到新会话
```

**它是 GUI 聊天页「轮次尾巴 → 分叉」按钮的微信入口，不是仿制品。** 三个点逐字对齐宿主实现，`tests/fork-command.test.ts` 把每一条都钉住：

1. **同一个服务**。GUI 的 `forkAt(seq)` 调 `ctx.sessions.fork({sessionId, atSeq, increaseTitle: true})` → Remote `session.fork` → 宿主 `ctx.sessionController.fork(request)`；bridge 直调同一个 `ctx.get("sessionController").fork({ sessionId, atSeq })`（和 `/model` 直调 `selectModel` 是同一套做法）。子会话因此是**一等会话**：自己的 Agent、`parentSession` header、同一工作区成员资格，`/s list` 与 GUI 侧边栏都看得到。
2. **同一个切点**。GUI 传的是 `turn-tail` 节点的 `data.seq`，也就是该轮 `turn/end` 事件的 seq；`/fork switch N` 传的正是这个值，所以切出来的历史完全一样。**不是** `latestCompletedPrefixBoundary`——那个是省略 `atSeq` 时宿主自己的兜底，会把切点推到下一个 `turn/start` 之前，不是用户点的那一轮。
3. **同一套轮次折叠**（`ops.readSessionTurns`）。`turn/start` 锚定一轮（`data.turn` 递增才新建）；该轮**第一条**人类 `user/message` 是提问，同轮后续的 steering 不覆盖；每条 `assistant/message` 覆盖草稿，`turn/end` 提交为该轮回复；注入类 user 消息（`plugin` / `goal` / `session-reference`）不进轮次。这就是宿主 `dsh-session-turn-outline` 的 `turnOutline` 折叠规则，只是这里保留**全文**、额外记下 `turn/end` 的 seq（投影只给 50/120 字预览，既满足不了 `show` 的「完整」，也拿不到 GUI 的切点），并分别记下提问与回复的事件时间（`promptTime` / `replyTime`）。

**编号是列表行号（1…N），与 `/s list` 一致**；窗口只影响显示，不影响解析（`/fork show 25` 在只显示 20 行时照样能到第 25 轮）。`list` 的窗口语法直接复用 `/s list` 的 `parseListLimit()`，所以 `all` / 数字 / `all 5` 行为逐字相同；详情因此单独占 `show`——`list 5` 永远是「看 5 行」，不会和「看第 5 轮」混淆。

**标题递增**：fork 种子会复制 `session/title` 事件，不处理就会出现两个同名会话。所以分叉成功后按宿主客户端自己的 `increasedForkTitle()`（`标题` → `标题 (1)`、`标题(2)` → `标题(3)`，全角括号同理）改名一次；改名失败不影响分叉。

**两个刻意的取舍**：

- **只允许从「已结束」的轮次分叉**（`turn/end` 存在），进行中的轮次在列表里标 `（进行中）` 并拒绝 `switch`——没有切点就没有分叉。
- **比 GUI 宽一点**：GUI 的分叉按钮在「该轮没有助手文字」或「收尾助手之后还有工具事件」时是**灰的**（`branchUnavailable`，纯粹是按钮挂在助手气泡上的 UI 约束），微信这边照常允许。宿主接受任意存在的 seq，而从一轮被中断的地方重来正是这个功能最有用的场景之一。这是**唯一**一处与 GUI 的行为差异，且方向是「更宽松」。

分叉成功后自动把微信绑定切到子会话（等价于 GUI 分叉后自动打开它），原会话仍在 `/s list` 里可切回；`lastSessionListByUser` 快照随之作废（子会话插到了列表最前）。失败（`session/not-found`、`session/fork-unavailable`、`session/migration-required`、宿主缺失 `fork`）一律**不改绑定**，按宿主错误码回中文原因。

`tests/fork-command.test.ts`（38 条）覆盖：解析与窗口语法、五种非法形式、`isBypassSlashCommand` 与 `LOCAL_COMMAND_NAMES` 接线、别名碰撞守卫、折叠的八种形状（含 steering、注入消息、纯图片、非递增 `turn/start`、无 seq、中断轮次）、冷会话回退 `readSession`、两种渲染、以及桥接的「传的 `atSeq` 恰好等于该轮 `turn/end`」「失败不改绑定」「打错只回用法、零转发」。

### `/history` 按轮次回看

```
/history                      # 同 /history list
/history list [all|数量]       # 每轮一行，默认最近 5 轮，末轮全文
/history show <编号>           # 第 N 轮的完整提问与完整回复
```

**它是 `/fork` 的只读版本，共用同一份数据。** 轮次来自 `ops.readSessionTurns()`——和 `/fork` 逐字同一个折叠，所以 `/history show 3` 与 `/fork show 3` 打印的是同一轮，两个命令的编号也永远一致（不会各自漂移）。区别只在渲染与用途：`/history` 不提供 `switch`，分叉仍是 `/fork switch`。

**每轮只留「提问 + 该轮最终回复」。** 过程中间的助手消息（工具调用前后的碎句）不进列表——那不是这一轮说了什么，而是它怎么说的。旧版 `/history` 是消息流水（一条助手消息一行），一有工具调用就被撑成十几行，所以这里改成按轮次折叠。

**末轮全文、其余简写**：窗口永远以最新一轮结尾，所以列表最后一轮（`index === total`）整块打印完整提问与完整回复，前面的行按 30/50 字加 `…`。这与旧版「最近一条助手回复不截断」是同一个意图，只是把提问也一起给全。`show` 同样不截断，超长输出走 `splitText`（4000 字/条）+ `/next` 队列。

**提问和回复各带各的时间。** `SessionTurn` 记两个时钟：`promptTime` 取那条人类 `user/message` 的事件时间，`replyTime` 取 `turn/end`。以前只有一个 `time`（而且被 `turn/end` 覆盖），所以「👤 你 · 50 分钟前」印的其实是**回复**的时刻——一轮跑了 19 分钟，用户那句话就被写成 19 分钟之后（实测差值 19 分钟）。简写行两边都带（`👤 50 分钟前 · 提问… → 🤖 31 分钟前 · 回复…`），时间放在文字**前面**：预览以 `…` 结尾，后面再挂时间会读成句子的一部分。没有时间的一侧（进行中的轮次没有 `replyTime`）直接省略，**不**打印「未知时间」——那是把「不知道」当成信息印出来。

**块与块之间必须是空行，不能是单个换行。** 微信一旦把这条消息当 markdown 渲染（回复里出现一个 `**加粗**`、一个表格或一个行内代码就够），单个换行就是**软换行**，渲染成**空格**：`🤖 助手` 黏在回复上、`看全文: …` 黏在回复最后一行（桌面微信实测；同一段回复里的空行却正常分段，这正是软换行的定义）。空行在两种渲染下都是段落分隔，所以 `/history list`、`/fork list`、`/fork show` 的每个块之间统一用 `BLOCK_SEPARATOR`（`\n\n`），代价是每块多一行，换来的是「回复里有没有 markdown」都不影响版式。`tests/history-truncation.test.ts` 用「`🤖 助手` / `看全文` 前面绝不能是单个换行」把这条钉住。

**注入消息没有展示入口了。** 压缩检查点、插件上下文、goal 续跑都是 user 角色，旧版用 `/history all` 才能看到它们；现在它们连 `all` 都看不到——`all` 是 `list` 的窗口关键字（全部轮次），与 `/fork list all` 同义。这与 GUI 侧边栏（`turnOutline` 只列 `source.kind === "user"`）一致：它们不是你说过的话。

**两处破坏性变化**：`/history all` 不再是「含系统消息」；裸数量 `/history 10` 不再接受（写 `/history list 10`）。两者都按「打错的本地命令」回用法提示，不转发给 agent。20 条上限也一并取消——窗口由 `list <数量>` / `list all` 显式指定，与 `/s list`、`/fork list` 同一个 `parseListLimit()`。

`/help` 一览不给 `/history` 印子命令行：那一行约 55 字，会把一览从实测 1899 字顶过 2000 字上限。`list` 是默认形式，`show` 写在 `usage`、四条示例里，而且**每次 `/history` 列表末尾都印着 `看全文: /history show N`**——提示在需要的那一刻到达。

`tests/history-command.test.ts`（解析）、`tests/history-truncation.test.ts`（渲染与桥接）、`tests/history-provenance.test.ts`（注入消息不进提问、冷会话读 `readSession` 而非压缩后的 surface）三份测试钉住以上全部行为。

### `/at` 引用

`/at s <编号|关键词>` 引用会话（宿主展开成 `## Referenced sessions` 快照），`/at f <路径>` 引用文件或目录（模型据此 `read`）。微信没有输入框，所以是「先登记、下一条消息自动带上、发一次即清空」；可叠加（会话 ≤3、文件 ≤8），`/at` 查看、`/at rm <编号>`、`/at clear`。

实现要点：

- **引用块跟在正文之后**（`总结一下这个会话 @Alpha`）：宿主 `dsh-session-title` 用消息的**开头**生成会话标题，前置的 base64 mention 会变成新会话的标题。
- 会话引用由宿主展开成 `## Referenced sessions` 快照（与 GUI 的 `@会话` 同一条链路）；文件引用是 `@路径` 文本，由 `dsh-file-reference-local` 的提示词让模型用 `read` 去看。
- 引用块**以换行开头**（`MENTION_BLOCK_BREAK`）：GUI 把一条消息的所有 text 块用**空串**拼起来再解析 mention，而 `@文件` 规则要求 `@` 前面是空白（客户端 `(?<!\S)`、宿主 `(?:^|\s)`）。引用块自身带上换行，空白边界就不再取决于正文最后一个字符。
- 可预见的失败全部挡在 `/at` 阶段（宿主的引用失败是**整轮终止**）：引用自己、超过 3 个会话、宿主未挂载 `dsh-session-reference`、路径含引号/控制字符，都在登记时拒绝并说明原因。

### `/skill` 查看技能

`/skill` 只做两件**只读**的事，因为它要回答的问题只有「有什么」和「这个是什么」：

| 写法 | 行为 |
|---|---|
| `/skill`、`/skill list` | 列出当前会话的技能：编号 + 一句话说明（最多 25 条，超出只报数量） |
| `/skill 2`、`/skill office` | 显示该技能的完整描述、适用场景、来源路径 |

**执行技能不归它管**，也不需要归它管：直接把 `/技能名` 发出去即可。宿主 `@deepseek-ai/dsh-tool-skill` 在 `agent/pre-step` 扫描用户消息里的 `/名称` 手势，自己查出技能并注入 `<skill_content>`——与 GUI 里在输入框打 `/技能名` **完全同一条链路**。所以 bridge 这一层没有任何标签拼装、转义、正文处理或暂存状态。

这个边界是刻意的，不是省事：

- **格式只有一个来源**。`<skill_content>` 的字节由宿主的 `renderSkillContent()` 决定，它会随版本变（资源提示文案、标签结构都改过）。bridge 自己拼一份就多了一份要跟着升级的副本，而副本过期**不会报错**——只会让模型收到一种 GUI 里不存在的形状。
- **校验留在宿主**。技能是否还存在、是否 `userInvocable`、名称是否合法，宿主注入前都会判一遍。
- **没有跨轮状态**。`/skill` 不暂存、不过期、不需要 `/skill off`，也不存在「忘了取消导致很久以后某一轮被悄悄改变」的问题。

由此产生一个真实边界：**技能名与 bridge 自己的命令重名时**（例如某技能叫 `help`），直接打 `/help` 会被当成命令执行，而不是手势。逃生口是 `/raw once`——它只放行下一条，`/名称` 原样交给 agent，宿主的扫描照常生效，用完自动回到「命令优先」。列表里提示的就是这个写法，而不是 `/raw on`：后者会一直留在「不再响应命令」的状态里，为一个偶尔撞名的技能付这个代价不值。

其余实现要点：

- **目录读宿主，不跨轮缓存**：优先 `ctx.sessionSkillCatalog.list({sessionId})`（GUI 的 `/` 补全用的就是它，按会话的 cwd **和** preset 决定可见层，且不会为列技能而唤醒冷会话）；服务缺失时退回 `ctx.skills.list({cwd, scope: agent})`。技能是文件，用户随时可能新增或改掉一个，缓存一份过期编号表正是 `/skill 3` 指错技能的原因。读取带 10 秒超时，卡住的 provider 不会让命令彻底没有回复。
- **编号 = 上一次列表打印出来的行号**：按 1 起解析，越界直接报范围而不是回绕。名称先精确匹配（`/skill office` 必须选中 `office`，不能是 `office-docx`），再唯一前缀匹配；前缀命中多个**不猜**，把候选列出来让用户挑。
- **两种 invocation 形状都读**：`ctx.skills.list` 把策略嵌在 `invocation` 下，`ctx.sessionSkillCatalog.list` 给的是扁平的 `modelInvocable`（它本来就只返回用户可调用的技能）。只认一种就会把只给模型用的技能列进编号表。
- **带任务的行只回用法**：`/skill 1 帮我做这个事` 既不是编号也不是技能名，解析失败 → 用法提示，**不转发**。静默丢掉后半句是最坏的选择（用户会以为那句话被送出去了），整句转给模型也一样糟。规则与 `/at`、`/history` 一致，也让它绕过待处理的卡片。
- **聊天里不贴正文，也不拼执行命令**：详情页只给描述、适用场景、来源路径。正文是给模型的操作说明（可能几千字），贴进气泡既没人读，也会淹没用户真正要说的话；而「发 /<技能名> 你的任务」这种拼句看着贴心，实际会误导——技能名在别的技能里常是子技能名，拼出来的命令未必是用户想执行的那条。正文是给模型的操作说明（可能几千字），贴进气泡既没人读，也会淹没用户真正要说的话。

`tests/skill-list.test.ts`（29 条）逐条钉住：解析、编号/名称解析、越界与歧义、列表渲染（含 25 条上限与单行折叠）、`/raw` 与同名冲突的提示、两种 invocation 形状，以及「`/skill` 之后零转发、零暂存」。

## dispose 与宿主退出

DSH 桌面端把「插件 dispose 完成」当成优雅退出的唯一信号：宿主的 `createProcessShutdown` 在 dispose 成功后**清掉自己的强制退出定时器**，只设 `process.exitCode = 0`，然后完全依赖 Node 事件循环自然排空；10 秒还没排空就 SIGTERM，更新器据此判定「非干净退出」并拒绝安装（[#18](https://github.com/pan17/dsh-wechat/issues/18)）。所以本插件有两条硬约束：

> 1. **清理函数必须挂到 `ctx.effect`。** 这个宿主的 cordis **不把函数式插件的返回值当 disposer**：`apply()` 里 `return () => bridge.stop()` 会被丢掉，宿主那边照样报「teardown 完成」，而长轮询一直在跑。`stop()` 因此做成幂等（`disposePromise`），`ctx.effect` 与返回值两条路都注册，老宿主也不会拆两次。
> 2. **`stop()` 返回之后，插件不能留下任何被引用（ref'd）的 `Timeout`/`setInterval`/socket。**

第 1 条是 #18 的真正根因，也是排查时最容易看错的一条：只测 `bridge.stop()` 是永远测不出来的——真实宿主里它压根没被调用过。实测（真实桌面宿主 + 假网关）：返回值方案 dispose 永不执行、进程只能等宿主强杀；挂到 `ctx.effect` 后 dispose 35 ms 完成、进程在 shutdown 请求后 216 ms 消失。

落地规则：

- **后台/簿记类定时器一律 `unref()`**：跨会话提醒的 30 秒去重、`apiPost` 的请求超时、打字指示器的 keepalive 与 2 分钟兜底、扫码登录的轮询间隔、打字合并与极简模式的窗口。它们只影响「什么时候做事」，永远不该成为「进程为什么还不退出」的答案。
- **会长期运行的循环必须可取消**：长轮询（`monitorAbort`）与扫码登录（`loginAbort`）各有一个 `AbortController`，`stop()` / 登出 / 重新扫码都会中止。登录循环最长 5 分钟，之前它完全不可中止。
- **定时器句柄不要存快照**：会被刷新（clearTimeout + 重新 setTimeout）的定时器要放在可变盒子里（`{ current: Timeout }`），否则 `typingActive` 这类表里存的是第一个句柄，清理时清掉的是早已失效的那个，新句柄会一直挂着。`tests/typing-indicator.test.ts` 用 `vi.getTimerCount()` 钉住了这一点。
- **dispose 时的尽力而为要有界**：`stopIlink` 触发的「正在输入」CANCEL 是发后不管的请求，`stop()` 给它 1 秒有界等待（`TYPING_DISPOSE_BUDGET_MS`），随后 abort 仍挂着的打字请求。没人回复的网关不能让退出拖满 10 秒。
- **下次再遇到「进程不退出」**：设 `DSH_WECHAT_TEARDOWN_DEBUG=1` 重启，插件会在启动 / dispose 三个时点把 libuv 句柄快照写进 `<storageDir>/teardown.log`（`Timeout` 带毫秒数，直接指认是谁）。真实宿主里，`teardown.log` 里没有 `dispose:enter` 就等于「dispose 根本没被调用」。

`tests/teardown-handles.test.ts`（含「宿主忽略返回值」的契约用例）与 `tests/typing-indicator.test.ts` 的 TTL 用例守着这条约束。

## 已知边界

- `/s list`、`/workspace list` 与 `/fork list` 默认各显示 20 行，行末会提示「显示 20/N，看更多: … all（或 … <数量>）」（`/fork list` 是「看更早的」，因为它的窗口取的是**最近** 20 轮）；`all` 不设上限。会话、工作区或轮次很多时，回复会按 `textChunkLimit`（4000 字）拆成多条消息，超出微信 10 条/窗口额度的部分进入 `/next` FIFO 缓存（上限 100 条），需在微信端主动发消息或发 `/next` 继续发送。`/fork show` 的正文**不截断**（要的就是完整内容），超长同样走这条分段 + `/next` 链路。
- `/s list` 的编号与显示窗口无关：`/s switch <编号>` 仍按**完整**列表校验，所以 `/s list` 之后 `/s switch 25` 能切到未显示的第 25 条（列表行号 1-20 与它一一对应，靠「看更多」提示按需展开）。
- 会话置顶走宿主注册表（`workspaceRegistry.pinnedSessionIds` / `pinSession` / `unpinSession`），与 GUI 侧边栏共享同一份**持久**集合，任一端置顶或取消，另一端立即一致；`/s pin` / `/s unpin` 只写这一处，不额外落本地状态。置顶区内部仍按最近活动时间降序（对应 GUI 的「最近更新」视图——置顶时间不参与排序），所以置顶只改变分区归属，不冻结行内顺序；无置顶时行序与以前完全一致。归档与置顶互斥：已归档会话无法置顶（GUI 归档时会顺带清掉该会话的置顶），`/s list` 也不显示归档会话，因此只有「当前绑定会话」这条路径可能撞上该限制。宿主未挂载 `workspaceRegistry` 或版本早于该功能时，置顶命令提示「未提供置顶服务」并降级为无置顶显示，不会报错。
- `list current` 的目录匹配走宿主的 canonical path 规则（`fs.promises.realpath`，与 `@deepseek-ai/dsh-workspace` 的 `realpathNormalize` 同源）：折叠尾斜杠、`.`/`..`、混合分隔符、符号链接，Windows 上也折叠大小写——与 GUI 侧边栏的工作区分组完全一致。目录已删除/无法解析时退化为 `path.resolve` 归一。`/s new` 复用空白会话、`/workspace list` 的「◀ 当前」标记、以及跨会话任务提醒的收件人解析都用同一套比较。
- 出站文本按官方微信渠道（[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)）的 `StreamingMarkdownFilter` 处理，而不是一律剥掉 Markdown：`**粗体**`、链接、H1–H4 标题、代码块（```）、行内代码、引用（`>`）、分隔线（`---`）与表格都原样发送；只去掉微信不渲染的部分——图片（`![alt](url)` 整段移除）、H5/H6 标题标记，以及包裹中文的单个 `*`/`_`/`***`/`___` 强调标记（内容保留）。
- 微信「执行过程」是单条普通文本消息，没有桌面端的折叠交互。内容采用桌面端收起条目的规则：思考首行、中文工具标题与路径/描述，成功输出隐藏、失败仅一行错误、任务清单显示完成计数与变更；长分组标明省略数量，可在 DSH 查看完整记录。过程仅覆盖当前绑定会话，简洁/极简时隐藏；**极简模式下直接丢弃**（否则每轮仍会推一条过程消息，正是该模式要消除的洪水）；已推送过程与正文共享发送额度，超限走 `/next`。未推送的过程分组不跨进程重启保存。
- 极简模式（`workSteps = "minimal"`）按**任务**而非轮次收敛：暂存的是「这条任务最终那一段正文」，因此**中间轮次的正文与「执行过程」都不会到达微信**，交付时若跨了多轮会在首行标注 `✅ 已完成（共 N 轮）`。它不改变 agent 的行为，只改变推送时机；等待期间随时可发 `/flush` 取回，发下一条需求也会先交付上一件事的结论。硬顶存在的原因是「宁可晚一点，也不能永远沉默」。暂存只在内存里，插件 dispose 会冲刷交付、登出/换绑会丢弃。`workSteps` 由旧的两个布尔开关在加载时迁移；旧命令已移除，统一使用 `/steps`。
- 秘密脱敏（`maskSecrets`）作用范围刻意只限**错误文本与摘录**：`32+ hex` 与 `40+ base64` 两条规则会误伤 commit SHA、长 id 与长路径，所以绝不用于 agent 的正常回复正文。这是有意的取舍，`tests/redact.test.ts` 用两条断言把这个误伤边界固定下来，而不是假装它不存在。
- `（i/n）` 分段按**码点**计预算、前缀长度计入预算，代码围栏与 GFM 表格原子不可切；唯一允许超长的例外是「最小合法形式本身就超过预算」的构造（围栏分隔符、或表头+分隔行+首行），此时宁可超长也不产出残缺的 Markdown。
- `allowedUsers` 为空时是**现有行为**（首个给你发消息的人成为绑定对端），不是「拒绝所有人」——这样老部署升级后不会突然失联；要收紧就填名单，未列出的 id 会在去重/建会话/命令分发之前被拦下并记日志，绝不会得到回复。⚠️ **升级播种会改变这一状态**：`config.json` 里从未配置过该键、而 `state.json` 已有绑定用户时，启动会把该绑定用户写进名单（并在微信里提示一次）——这正是为了堵住「升级后第一个陌生人接管 bot」，但也意味着升级后**其他人**发消息会被忽略；要放开就在设置页清空该字段（显式存过 `[]` 后不会被再次播种）。
- 打字合并（`mergeEnabled`）**默认关闭**：每条微信消息各自一轮，与旧版行为一致。开启后（`/merge on` 或设置页）窗口内的多条会合并成一轮，代价是每条消息多等一个静默窗口；它对语义的影响是「一轮里可能包含多条用户消息」，需要每条消息单独成轮时保持关闭或发 `/merge off`。图片/文件类消息是否参与由「图片/文件合并」（`mediaMergeEnabled`）单独决定：该开关关闭时，媒体到达会先把已输入的文字作为一轮冲刷出去，再自己作为一轮，因此一次「文字 + 图片」仍产生两轮；`..` 暂挂的批次仍受条数上限与 3 分钟强制放行约束，不会无限期等下去。
- 图片/文件合并（`mediaMergeEnabled`）同样**默认关闭**。开启后只暂存**不带文字说明**的图片/文件/视频：同一条消息里既有图又有字时立即发送（它已经说明了意图，再等只会加延迟），语音（无转写）永远不参与。暂存**不写 `state.json`**，插件重启即丢（与打字合并缓冲、`/at` 暂存同一理由：一次「等一下」的意图不该跨越重启复活）；登出 / 重新扫码 / 换绑直接丢弃，且因为**下载推迟到真正投递时**，丢弃既不会留下临时文件，也不会为没人接收的附件花一次 CDN 请求。附件的等待上限取 `mediaHoldMs` 与 `mergeForcedReleaseMs` 中**更短**的那个（两者默认都是 3 分钟，所以默认就等于「一轮最多能被挂多久」）；slash 命令（`/status`、`/at` 等）不会冲刷暂存附件，唯一例外是 `/media off` 与设置页关掉该开关——那是「别再等我了」，不是「把图扔了」，所以会先发出再关闭。
- 附件交付措辞（`mediaAtRefEnabled`）只决定**措辞**，不决定内容：两种方式都先存到 `~/.dsh-wechat/tempfile/`，再把**指针**交给模型。`路径`（默认）是「文件已保存到: 路径」的单行纯文本，不再附加「你可以使用这个路径…」的说明（那是引用提示词已经在说的事），任何宿主上都能正常阅读；`@引用`（需 `/media at` 开启）按宿主 `dsh-file-reference` 的 grammar 生成（Windows 反斜杠转 `/`，含空格写成 `@"…"`），由 `dsh-file-reference-local` 的 `FILE_REFERENCE_PROMPT` 要求模型自己 `read`，在 GUI 里是一个可点开的 chip，与拖文件完全一致（微信端 `/at f` 也走同一套拼写层）——代价是它依赖该插件被挂载，没挂载时气泡里只会是一行裸 `@C:/…`，这正是默认关闭的理由。**两种方式都不会把文件内容放进消息**：那既是「一个文件不该在聊天里出现两遍」的产品判断，也是一条硬边界——0.12 会把文本文件内容整段内联（且没有上限，一个 4 MB 的 `.log` 能直接撑爆上下文），0.13.0 删掉了那段代码，只剩这个措辞开关。路径含引号或控制字符时退回普通路径写法（不会产出会被截断成散文的 mention）。
- 记忆表有界：跨会话完成卡的正文预览（每会话一条，上限 64 个会话）、`/s list` 的最近活动时间（上限 512 个会话）、`/model` 覆盖（上限 128 个会话）、微信消息来源标记（上限 512 条 / 10 分钟 TTL）都是**缓存**——被淘汰只会让该行退回默认显示（创建时间、部署默认模型、按会话 id 显示标题），不会丢失队列里的任何消息。出站队列的内存边界仍是硬上限 400 条（`MAX_OUTBOUND_QUEUE_HARD`），重启后**完整**恢复（此前只恢复最后 100 条，第 101–400 条会被静默丢弃）。
- 打字合并的缓冲区**不因 slash 命令而提前释放**：`/status`、`/next` 等命令照常立即执行，缓冲的文本仍由静默窗口 / 条数上限 / 强制放行三者之一释放（因此不会丢，只是可能晚几秒）。插件 dispose 会先把缓冲区投递再注销交互；登出 / 重新扫码 / 换绑则**丢弃**（身份变了，别人说的话不该发给下一个绑定者）。
- `/at` 是**暂存式**：命令本身不改写当前消息，引用落在**下一条**投递给 agent 的消息上（打字合并开启时落在合并后的那一批），投递成功即清空；agent 创建/恢复失败时**不清空**，重发正文即可。暂存只在内存里（不写 `state.json`）：插件重启后失效——一条引用是「这一次」的意图，重启后大概率已不是同一件事，复活它只会把无关上下文塞进新的一轮。`/at` 命令本身不冲刷打字合并缓冲区（与 `/status` 等一致）。会话引用依赖宿主挂载 `dsh-session-reference`，未挂载时明确拒绝（否则 mention 会被当成普通文本转发，模型只看到一个 base64 串）；文件引用只是 `@路径` 文本，不需要任何服务即可生效，**不受工作区限制**：`@文件` 是交给模型的指针，不是 bridge 自己去读内容，宿主 `FILE_REFERENCE_PROMPT` 明确写了「绝对路径指代宿主机上的文件或目录」，能不能打开由 agent 自己的沙箱策略决定——这与 `send_wechat`（bridge 亲自读字节发出去）是两条不同的边界。路径两端的不可见格式字符（从资源管理器/浏览器复制路径常带 U+202A 等）会自动剥掉，中文输入法打出的弯引号 `“…”` 也接受。⚠️ 会话引用在**发送时**由宿主读取：若被引用的会话在这 10 分钟内被删除，宿主会以 `SESSION_REFERENCE_READ_FAILED` 终止该轮——这是宿主语义，微信端只能在 `/at` 阶段挡住「引用自己 / 超过 3 个 / 服务缺失」这三类可预见的失败。
- `~/.dsh-wechat` 与其下文件（`auth/token.json`、`state.json`、`config.json`、`sync-buf.json`、`audit.jsonl`）以 `0700` / `0600` 创建。⚠️ **Windows 上 Node 忽略 mode 参数**（`chmod` 只能切只读位），实际保护来自 `%USERPROFILE%` 继承的 ACL（仅本人、`SYSTEM`、`Administrators` 可读）——这是依赖继承 ACL，不是本插件自己设的权限。审计文件按 1 MiB 轮转为 `audit.jsonl.1`（只保留一份历史），轮转会记一行日志。
- 审批/提问卡挂在 Host 的 `approval/request` 与 `user-questions/request` waterfall 上，与 GUI 竞速；无微信 peer 时立即 `next()`，软超时只撤微信卡、不替用户决策。微信先答时会 abort 传给 GUI 的 `request.signal`（不碰 turn 的 `exec.signal`），Web composer 卡随 Gateway `cancel` 帧收起。DSH 重启后未决卡片随 turn 消失（上游已知限制）。
- 微信回答卡片后的回执**每条占一次微信发送额度**（10 条/窗口）。一次 `P1=1 P2=2` 会发 2 条回执；额度用尽时回执与其他出站消息一样进入 `/next` FIFO 缓存，不会被丢弃。`P{n}` 是整批处理开始时快照的编号（卡片在结算时即被摘除，现算取不到编号、回执会退化成不带编号的文案）。跨会话卡的 `❗来自其他会话` 只是正文提示标记，不影响编号或回复语法。
- `send_wechat` 工具对所有 agent 可见；任何会话的 agent 都能调用——绑定会话发送到绑定用户，未绑定会话回退到首个已知微信用户（单用户部署默认行为）。单用户模式下，工具推送与 assistant 回复共享唯一一份微信 10 条/窗口限流预算：超限或发送失败自动进入 `/next` FIFO 缓存队列。计数和队列持久化到 `state.json`，普通 DSH 更新或重启后继续沿用；下一条微信入站会重置窗口并自动补发。微信真实限流响应（HTTP 200 + `ret: -2` / `prepare failed`）也会被识别并缓存，不再误判成功。
- **出站语音（`voice_item` / `type=3`）在 iLink bot 通道不可渲染**：`sendMediaMessage` 的 VOICE 分支能上传成功、服务端返回 `ret: 0`、审计也记成 `sent`，但微信客户端把整条消息丢弃——没有气泡、没有占位、也没有红色感叹号。issue #17 用 8 组 `voice_item` 字段组合（含把微信自己发出的语音字节原样回发、`message_type: USER`）逐一验证过，结论是 bot 消息在客户端侧没有 type=3 的渲染器，语音在这条通道上是**入站专用**（入站语音转文字）。所以 `mediaTypeForFile()` 只映射图片与视频，**不要**把 `.silk` 或音频扩展名加进 VOICE 分支：那不会报错，只会静默丢消息；要发音频就走 `FILE`，mp3 在微信里点开能正常播放。
- `/preset switch` 是**会话级**的：它走宿主自己的 `agentPresets.select`（与 GUI 的预设选择器同一条调用），既重绑当前 Agent 的组成，也追加持久化事件 `agent-preset/selected`，所以重启/恢复后仍是新预设，`/s list` 与 `/status` 立刻显示新值。DSH 只允许在会话的第一条消息之前改预设，因此已开始的会话会被**明确拒绝**并提示 `/s new`，而不是把它悄悄记成「下个会话生效」。判定用的就是宿主自己的谓词：`sessionProjections.stateOf(session, "turnBoundary")`（`openTurnStartSeq !== null || lastTurn > 0`），旧宿主没有 `stateOf` 时回落到事件日志里是否有 `turn/start` / `user/message` / `assistant/message`。
- `/preset default` 是**部署级**的：写入 DSH 设置文档——按设置服务公布的命名空间写 `agent-preset-registry.selectedDefault`（保留旧版 `agent-presets.default` 回退），GUI 设置页与微信双端读写同一事实源，只影响此后新建的会话；裸 `/preset default` 只读不回写。写入被拒绝时明确提示「默认 Preset 切换失败，默认 Preset 未更改」，不再误报成功。**一次聊天消息不会改变全局默认以外的任何东西**：`switch` 绝不写设置文档，`default` 绝不改当前会话。
- `/preset status` 分两行报两个事实（新会话默认 / 当前会话），不再把部署默认当成当前会话的值；`/preset list` 同理分别标 `◀ 新会话默认` 与 `◀ 当前会话`。
- 入站重投按微信用户 + 服务端 `message_id`（缺失时用有效 `seq`）去重，缓存保留 30 分钟、最多 4096 条，作用于当前插件实例；重连保留缓存，退出登录/重新扫码清空。无有效身份的消息放行，相同文本但不同身份的消息正常处理。去重缓存不跨进程重启持久化，也不协调同时配置的多个插件实例。
- 同一用户的会话检查与创建串行执行，避免首次收消息或工作区无绑定时并发创建多个会话。停止/重连会取消正在进行的长轮询，丢弃旧轮询迟到的消息；重连等待旧轮询退出后启动新轮询。
- iLink 通道是腾讯官方 bot 协议，接口可能随官方调整；跟随 wechat-opencode 上游的 `src/weixin/` 修复即可。
- 微信「执行过程」与「极简模式」的推送语义见上；跨会话完成卡预览取**尾部** 80 字（结论在最后），长回复按 `（i/n）` 有序分段。

## 开发与测试

```bash
npm install
npm run build    # tsc → dist/
npm test         # vitest（splitText/出站 Markdown 过滤/解析/帧处理/waterfall 竞速/状态存储/命令解析/超时恢复/状态颜色/历史截断/渠道提示词/工作步骤/打字合并/图片与文件合并/脱敏/限流与白名单/权限提权闸门/send_wechat 文件边界/白名单播种/审计与文件权限/出站串行槽/有界缓存/dispose 语义与残留句柄/驱动宿主版本区间/DSH >=0.2.1-0 适配）
```

改动代码后需**重启 DSH** 才能让改动生效（插件由 host 进程加载；`dist/client.js` 只影响设置页，同样需要重启）。

⚠️ **CI 跑在 Linux（`ubuntu-latest`）上，所以 Windows 上「全绿」不等于 CI 绿。** 已经踩过一次：一条断言把 Windows 形状的字面量 `C:\home\.dsh` 同时当输入和期望前缀，而实现会先对该根目录做 `path.resolve`——在 POSIX 上那是**相对路径**，会解析到 cwd 之下，于是 `built.startsWith("C:\home\.dsh/sessions")` 恒为 false，本地 Windows 必绿、CI 必红。

改动测试（尤其涉及路径/权限/文件系统的用例）后，请在 Linux 上再跑一遍完整 CI 步骤：

```bash
bash scripts/ci-local.sh    # Linux / macOS / Windows 的 WSL 里都可用
```

它把检出复制到本机临时目录再 `npm ci && tsc --noEmit && vitest run`（与 CI 完全一致），因此不会用 Linux 版的 esbuild/rollup 覆盖你工作副本里的 `node_modules`。

## 宿主版本兼容

当前版本针对 **DeepSeek Harness `>=0.2.1-0 <0.3.0-0`** 的宿主 API；仓库本身不依赖任何 `@deepseek-ai/dsh-*` 运行时包（`peerDependencies` 里的 `@deepseek-ai/dsh` 是**宿主契约声明**，不是依赖，并已标 `optional` 以免安装时把整个 harness 拖进 profile）。宿主版本要求写了两处、值完全一致：

- `engines.dsh` —— **声明性**。宿主 `evaluatePluginCompatibility` 只校验 `peerDependencies`，**没有任何代码读 `engines`**；真正读它的是插件市场 `dshmarket`（顶层 `engines.dsh` 优先于嵌套 `dsh.engines.dsh`），且固定以 `{ includePrerelease: true }` 求值。
- `peerDependencies["@deepseek-ai/dsh"]` —— **强制**。不匹配时宿主会**跳过整个 `dsh-wechat` bundle**（`profile.ts` 抛错 → `skippedBundles`，并在每次启动时向 stderr 写一行 `skipping profile bundle`），插件在桌面端表现为消失。
  - 该 peer 必须同时标 `peerDependenciesMeta.optional`。实测（`pnpm pack` 后 tarball 安装）：不加 `optional` 会**安装失败**（`exit=1`）——peer 被当成真实依赖解析，`@deepseek-ai/dsh` 元包带 82 条 dependencies，会拉进 530 个包并撞上未发布包 `@deepseek-ai/dsh-type-meta` 的 npm 404；即使能解析，lockfile 也会从 28 行膨胀到 8199 行。加 `optional` 后 `exit=0`、lockfile 28 行。宿主门禁**不读** `peerDependenciesMeta`，所以强制力不受影响。

范围只有一段 arm，因为前发布元组枚举并无必要：唯一消费者在 `includePrerelease` 语义下求值，一条 `>=0.2.1-0 <0.3.0-0` 已放行全部 0.2.x 前发布版；而枚举永远补不全（每来一个新的 0.2.x 元组都得再加一条）。上界必须写成 `<0.3.0-0` 而非 `<0.3.0`——后者在 `includePrerelease` 下会放行 `0.3.0-rc.1`。`tests/host-line.test.ts` 用真实 `semver` 把这张准入/拒绝矩阵与两处声明的一致性钉死。

> **与生态另一种写法的对比**：`@anysearch/anysearch-dsh` 不写 `engines.dsh`，而是对**具体子包**声明 `peerDependencies`（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web` 等）且大多用 `"*"`，其 `docs/dsh-compatibility.md` 明确说这是「默认放行新 DSH 版本、矩阵只记录已验证版本而非安装白名单」。两者取舍不同：`"*"` 换来「新宿主版本无需改 manifest」，代价是**放弃版本防护**（`*` 连 `99.0.0` 都放行）；本仓选择精确区间，代价是 DSH 大版本升级时要主动更新声明。注意 anysearch 那套用 `"*"` 无法照搬到一个元包 peer 上——`@deepseek-ai/dsh` 是聚合包，解析它就会拉整棵依赖树。

### 0.2.2 的模型路由边界

0.2.2 收紧了模型选择的所有权，两个位置插件都不能再插手：

- **`preStep`（任何瀑布之前）**要求 Agent 已有路由：`agent.model.current()` 只读已记录的 `model/selection` 或 `AgentOptions`，**不回看日志里的请求头**；缺失时直接抛 `has no provider/model`，这一轮连提示词都组装不到。
- **`agent/request` 返回值**会被校验：`provider`/`model`/`reasoningEffort` 与 `preStep` 固定的选择不一致就抛错终止整轮（文案明确要求改用 `agent.model.select()`）。该事件在类型里已标 `@deprecated`。

因此本插件的约定是：

- **不在 `agent/request` 里改路由。** 宿主自持选择（`sessionController.selectModel` 存在）时，`agentSetup` 只把选择写进 `system-prompt/assemble` 的 `{{model}}` 变量；路由由宿主按同一条 `modelSelection` 投影决定。没有 `sessionController` 的老宿主仍走原来的内存覆盖（`applyModelOverride`），该分支在新宿主上是空操作。
- **建会话时补路由。** `AgentStore.ensure` 调 `agents.create` 只传 `sessionId`/`meta`/`setup`，不带 `AgentOptions.provider/model`，微信新建的空会话因此没有任何选择。`agentSetup` 在 `agent.model` 存在且 `current()` 为空时补写一条 `model/selection`，取值顺序是「已有取值不动 → 会话最后一次请求头 → 部署默认」，与 GUI 新建会话写入的是同一条 durable 记录（模型选择器同步可见）。恢复路径走同一个 `setup`，所以 0.2.1 时代建的空会话重启后会自动补上，不必重开。


## 发布

见 [PUBLISH.md](../PUBLISH.md)。
