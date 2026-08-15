# dsh-wechat

[![npm](https://img.shields.io/npm/v/dsh-wechat?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-wechat)
[![npm downloads](https://img.shields.io/npm/dm/dsh-wechat?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-wechat)
[![License](https://img.shields.io/github/license/pan17/dsh-wechat?style=flat-square)](https://github.com/pan17/dsh-wechat)

让微信成为 DeepSeek Harness (DSH) 的第二客户端：通过腾讯 iLink bot 协议把
微信私聊桥接到 DSH agent——文本/图片/文件/语音消息双向收发、微信内 slash
命令管理会话/工作区/Preset/模型/权限、审批与提问卡与 GUI 双端同卡同决策、
DSH 设置页内扫码登录与连接配置。以静态 Cordis 插件交付，零运行时
`@deepseek-ai` 依赖，直接调用 DSH 进程内服务。

<img src="./resources/发送.jpg" alt="发送" width="32%" /> <img src="./resources/接收.jpg" alt="接收" width="32%" /> <img src="./resources/设置页.png" alt="设置页" width="32%" />

## 功能

- **发送** — 微信文本/图片/文件/语音消息 → DSH agent（媒体自动下载解密到
  `~/.dsh-wechat/tempfile/`，本地路径作为附件注入）
- **接收** — agent 回复文本回微信；`send_wechat` 工具可主动推送文本/文件到微信
- **微信 slash 命令** — `/workspace`、`/session`、`/preset`、`/model`、
  `/perm`、`/silent`、`/next`、`/status`、`/stop`、`/rp`、`/rq` 等
  由 bridge 直接处理（见下方命令表）
- **审批/提问卡（双端同卡）** — 微信与 GUI 弹一致的原生审批/提问卡，
  谁先回复谁生效（原生防双决）
- **微信渠道提示词（动态注入）** — 微信消息进入会话时，agent 的系统提示
  自动注入"你正在通过微信(WeChat)与用户聊天"（runtime context，微信会话
  才知道要调整回复格式）；从 GUI 发消息时该提示词自动消失——按消息来源
  动态切换，新旧会话（GUI/微信创建）一视同仁
- **静默模式** — `/silent on` 后每轮只发送最终回复
- **二维码登录** — `http://127.0.0.1:3080/wechat/qr` 扫码登录，设置页内嵌
- **设置页 UI** — DSH 设置 → **WeChat**：扫码、状态、重连、退出登录、
  连接配置（保存即生效，存储于 `~/.dsh-wechat/config.json`）
- **断点续传** — `sync-buf` 与微信会话映射持久化，重启 DSH 后自动恢复会话

## 安装（部署到 DSH profile）

DSH 自带插件管理命令 `dsh plugin`（在 profile 目录转发 pnpm，并自动把
声明了 `dsh.bundle` 的依赖加入 bundle 层）：

```bash
# 安装（自动添加依赖 + 注册 bundle 层）
dsh plugin --profile <profile> add dsh-wechat

# 验证组合配置
dsh --profile <profile> --dump-config   # 应看到 "- id: dsh-wechat" 行

# 重启 DSH（必须），然后：
#   - 浏览器打开 设置 → WeChat：扫码登录、查看状态、重连、改配置
#   - 或直接打开 http://127.0.0.1:3080/wechat/qr 扫码
```

其他管理命令（同样自动维护 bundle 层）：

```bash
dsh plugin --profile <profile> update dsh-wechat   # 升级
dsh plugin --profile <profile> remove dsh-wechat   # 卸载（从 bundles 移除）
```

> 插件从 npm 官方源安装（`dsh plugin add` 即 `pnpm add dsh-wechat`）。
> 修改代码后需**重启 DSH** 才能让改动生效。

## 微信命令

| 命令 | 说明 |
|---|---|
| `/help`（`/h`、`/?`） | 帮助 |
| `/status` | 当前状态：工作区、会话、Agent、Preset、模型、上下文、权限、静默 |
| `/workspace (ws) — list \| status \| switch <编号\|路径> \| add <路径>` | 工作区管理（list 显示各工作区会话数，不含已归档；switch 恢复该目录最近会话，无则新建） |
| `/session (s) — list [current] \| switch <编号> \| new \| status` | 会话管理（list 最近 20 个，标记当前，不显示 GUI 已归档会话；`current` 只看当前工作目录；`new` 复用当前工作区空白会话，与 GUI「新建会话」同款，无空白才新建） |
| `/preset (p) — list \| switch <名称\|编号> \| status` | Preset 管理（默认写入 DSH 设置，与 GUI 同步；当前会话无内容时立即应用） |
| `/model — list [提供商] \| switch <提供商/模型> \| status` | 模型管理（切换立即作用于当前会话 + 设为默认） |
| `/perm — status \| list \| switch <名称\|编号> \| default [名称\|编号]` | 权限管理（switch 实时切当前会话；default 写 DSH 设置，新会话生效） |
| `/reasoning — [list \| default \| <等级>]` | 推理等级：查看当前/默认与模型支持的等级；`<等级>` 切换（实时 + 写默认）；`default` 恢复模型默认 |
| `/silent on\|off`（`/sl`） | 静默模式：开启后 agent 每轮的中间过程输出（工具调用、思考等）不再逐条推送，只在轮次结束时发送最终回复，避免刷屏；跨重启持久化 |
| `/stop` | 中断当前任务 |
| `/next` | 继续发送因微信限制被缓存的消息 |
| `/rp` / `/rq` | 拒绝所有待处理权限卡 / 提问卡（微信端） |

其他 `/xxx` 命令作为文本转发给 agent；审批/提问卡双端同弹，已在其他端
处理的卡会提示。

所有命令均直接映射 DSH 原生服务（`workspaceRegistry` / `sessionQuery` /
`agentPresets` / `agentDefaultModel` / `permissionPresets`），默认值与 GUI
设置页同源同步。

## 架构

```
微信 (iLink) ── long-poll getupdates ──► dsh-wechat (Cordis host plugin)
    ▲                                      │
    │ ◄── sendText/sendMedia ──────────────┤
    │                                      ▼
    │                          DSH 进程内服务（零 @deepseek-ai 运行时依赖）
    │        agents.create/resume ── agent.followup（消息入）
    │        session/event ── assistant/message、turn/end（消息出）
    │        apiProxy.events.mux 帧流 ── approval/question 卡（镜像 GUI）
    │        apiProxy.respond() ── 微信决策注入原生 pending 表
    │        tools.register ── send_wechat 工具
```

| 参考项目 wechat-opencode | 本插件 |
|---|---|
| `src/weixin/`（iLink 协议） | 原样移植 |
| `src/server/`（OpenCode Server HTTP/SSE，240KB+） | 删除，改用 DSH 服务 |
| `bridge.ts` 会话映射 | `src/bridge/bridge.ts` + `src/dsh/sessions.ts` |
| workspace/session/agent/model 等 18+ 命令 | 移植并映射到 DSH 服务 |
| question 卡片 | `apiProxy.events.mux` 帧 → 微信卡 → `respond()` 注入 |
| permission 卡片（OpenCode 规则引擎） | 无自定义触发；原生 `approval.request` → 帧流双端同卡 |
| 终端二维码 | `webServer` 路由 `/wechat/qr` |

> 设计说明：微信端是 GUI 的**第二客户端**，功能不多也不少。审批/提问的
> 决策点始终在 apiproxy 的原生 pending 表（审计、`ApprovalPolicy` 策略、
> GUI 卡全部原生），插件只做两件事——订阅 `events.mux` 帧流把同样的卡
> 渲染到微信，以及把微信回复通过 `respond()` 注入（与浏览器客户端同一
> 协议）。审批**触发**也完全原生：不设自定义敏感工具名单、无自动放行
> 模式，沙箱升级等原生触发产生什么卡，微信就镜像什么卡。
> "谁先回复谁生效"由原生 settle 防双决保证；`respond` 返回 `not-pending`
> 时微信提示"已在其他端处理"。微信卡 30 分钟软超时是唯一工程差异
> （GUI 卡无超时、可继续处理）。

## 设置页（DSH 设置 → WeChat）

客户端半部通过 `dsh.client` + `exports["./client"]` 声明（与 dsh-mcp-manager
同款交付），挂载到 `settings.section` slot（nav 顺序 40）：

- **状态卡** — 登录阶段（未登录/等待扫码/已扫码/已登录/失败）、Bot ID、
  监控运行状态、已绑定用户数
- **扫码** — 未登录时页面内直接显示二维码，扫码确认后自动进入已登录
- **操作按钮** — `重新扫码`（清除 token 重新登录）、`重连`（重启长轮询
  监控，token 失效时自动回到扫码）、`退出登录`
- **连接配置** — baseUrl / cdnBaseUrl / botType / cwd /
  textChunkLimit / cardTimeoutMs；保存即生效，
  网关参数变更自动重连；存储于 `~/.dsh-wechat/config.json`

与宿主通信走插件自己的 HTTP API（`/wechat/api/status|config|relogin|
reconnect|logout`），客户端零 `@deepseek-ai` 依赖。

## 配置

优先级：内置默认 ← 插件行 `config:` ← `~/.dsh-wechat/config.json`
（设置页写入，覆盖前两者）。插件行可带 `config:`：

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

> 新会话的 agent preset 由 DSH 设置文档（`agent-presets` namespace，GUI
> 设置页或微信 `/preset switch` 修改）决定，插件不再提供 `agentPreset`
> 配置键。

## 开发

```bash
npm install
npm run build    # tsc → dist/
npm test         # vitest（64 个用例：splitText/格式化/解析/帧处理/状态存储/命令解析）
```

## 与参考项目的差异与已知边界

- 审批/提问**双端同卡**：微信通过 `apiProxy.events.mux` 帧流渲染与 GUI
  相同的卡，决策经 `apiProxy.respond()` 注入原生 pending 表（浏览器
  客户端同款协议）——不是自建第二套审批，触发也完全原生（无自定义
  敏感工具名单、无自动放行模式）。
- 微信卡 30 分钟软超时本地移除（不发 respond），GUI 卡无超时、可继续
  处理——这是唯一工程差异。
- 帧流 `events.mux`/`respond` 是 ApiProxy 正式契约；若 DSH 版本调整帧
  结构，按契约适配即可。
- `send_wechat` 工具对所有 agent 可见；非微信绑定会话调用会返回错误提示。
- `/preset switch` 遵循 DSH 约束：只有未产生任何内容的会话才能当场
  `recompose`；已有内容的会话会提示 Preset 应用于下一个新会话。默认
  Preset 本身写入 DSH 设置文档（`agent-presets` namespace），GUI 设置
  页与微信双端读写同一事实源。
- iLink 通道是腾讯官方 bot 协议，接口可能随官方调整；跟随 wechat-opencode
  上游的 `src/weixin/` 修复即可。

## 许可

MIT。`src/weixin/`、`src/adapter/` 移植自
[wechat-opencode](https://github.com/pan17/wechat-opencode)（MIT，
原始来源 `@tencent-weixin/openclaw-weixin`），文件头保留出处注释。

## 免责声明

本项目与 DeepSeek Harness、腾讯微信官方**互不隶属**，非官方项目，
纯属个人学习用途。使用本项目即表示你自行承担由此产生的一切后果。
