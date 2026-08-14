# dsh-wechat

将微信私聊消息桥接到 DeepSeek Harness (DSH) 的静态 Cordis 插件。

参考 [wechat-opencode](https://github.com/pan17/wechat-opencode)（MIT）开发：
微信侧（iLink bot 协议）直接移植；OpenCode Server 那一半整体替换为 DSH
进程内服务调用，因此本插件体积约为参考项目的 1/3。

## 功能

- **发送** — 微信文本/图片/文件/语音消息 → DSH agent（媒体自动下载解密到
  `~/.dsh-wechat/tempfile/`，本地路径作为附件注入）
- **接收** — agent 回复文本回微信；`send_wechat` 工具可主动推送文本/文件到微信
- **微信 slash 命令** — `/help`、`/status`、`/silent`、`/stop`、`/rp`、`/rq`
  由 bridge 直接处理
- **审批/提问卡（与 GUI 同卡同决策，完全原生）** — 插件订阅 DSH 官方的
  `apiProxy.events.mux` 帧流（`approval/requested`、`question/requested` 等，
  全量会话、打开即重放 pending），**微信弹与 GUI 完全一致的卡**（工具名 +
  reason + 允许一次/拒绝；提问含选项/多选/自定义）。微信回复通过
  `apiProxy.respond()` 注入原生 pending 表——**GUI 和微信都弹卡，谁先回复
  谁生效**（原生 settle 防双决），审计日志照常。任意会话的卡微信都能直接
  决策，无需切换会话；30 分钟软超时本地移除（可在 GUI 继续处理）。
  审批触发完全由 DSH 原生决定（沙箱升级审批 `approval.request` 等），
  插件不设任何自定义触发名单、无自动放行——微信只是 GUI 的镜像渲染端
- **静默模式** — `/silent on` 后每轮只发送最终文本回复
- **二维码登录** — 浏览器打开 `http://127.0.0.1:3080/wechat/qr` 扫码；
  登录态持久化到 `~/.dsh-wechat/auth/token.json`。iLink 的
  `qrcode_img_content` 是 HTML 页面而非图片，插件在宿主侧用
  qrcode-generator（MIT，vendored）把 URL 渲染成 SVG 二维码
  （`/wechat/api/qr-image`），设置页与扫码页共用
- **设置页 UI** — DSH 设置 → **WeChat** 页面：连接状态、二维码扫码、
  重新扫码 / 重连 / 退出登录按钮、连接配置表单（保存即生效，
  网关参数变更自动重连）；配置持久化到 `~/.dsh-wechat/config.json`
- **断点续传** — `sync-buf` 与微信会话映射持久化，重启 DSH 后自动恢复会话

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

## 安装（部署到 DSH profile）

前置：`F:\opencodeproject\dsh-wechat` 已构建（`npm run build`）。

1. 在 profile 的 `package.json` 添加依赖与 bundle（已配置）：

   ```jsonc
   // C:\Users\Administrator\.dsh\profiles\web\package.json
   "dependencies": {
     "dsh-wechat": "link:F:/opencodeproject/dsh-wechat"
   },
   "dsh": { "profile": { "bundles": [ /* ... */, "dsh-wechat" ] } }
   ```

2. 安装并验证组合配置：

   ```bash
   cd C:\Users\Administrator\.dsh\profiles\web
   pnpm install
   dsh --profile web --dump-config   # 应看到 "- id: dsh-wechat" 行
   ```

3. **重启 DSH**（必须），然后：
   - 浏览器打开 **设置 → WeChat**：扫码登录、查看状态、重连、改配置
   - 或直接打开 `http://127.0.0.1:3080/wechat/qr` 扫码

> 注意：`link:` 依赖指向 `F:\opencodeproject\dsh-wechat`，插件代码在该目录
> 修改后无需重新安装（junction 实时可见）；但**重启 DSH** 才能让改动生效。
> 若之后在 profile 里跑 `pnpm install` 后插件消失，重新执行 `pnpm install`
> 即可恢复（依赖声明在 package.json 中，不会被清理）。

## 设置页（DSH 设置 → WeChat）

客户端半部通过 `dsh.client` + `exports["./client"]` 声明（与 dsh-mcp-manager
同款交付），挂载到 `settings.section` slot（nav 顺序 40）：

- **状态卡** — 登录阶段（未登录/等待扫码/已扫码/已登录/失败）、Bot ID、
  监控运行状态、已绑定用户数
- **扫码** — 未登录时页面内直接显示二维码，扫码确认后自动进入已登录
- **操作按钮** — `重新扫码`（清除 token 重新登录）、`重连`（重启长轮询
  监控，token 失效时自动回到扫码）、`退出登录`
- **连接配置** — baseUrl / cdnBaseUrl / botType / cwd / agentPreset /
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
    cwd: 'F:\work'
    agentPreset: build
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 网关 |
| `cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体 CDN |
| `botType` | `"3"` | iLink bot 类型 |
| `storageDir` | `~/.dsh-wechat` | token/sync-buf/会话映射/临时文件 |
| `cwd` | `process.cwd()` | 新会话工作目录 |
| `agentPreset` | 无 | 新会话 agent preset |
| `textChunkLimit` | `4000` | 微信单条消息长度上限 |
| `cardTimeoutMs` | `1800000` | 提问/权限卡软超时（30 分钟） |

## 微信命令

| 命令 | 说明 |
|---|---|
| `/help`（`/h`、`/?`） | 帮助 |
| `/status` | 工作区、会话、agent 状态、模式、模型、静默、待处理权限 |
| `/workspace list`（`/ws`） | 工作区列表（含会话数，标记当前） |
| `/workspace status` | 当前工作区 |
| `/workspace switch <编号\|路径>` | 切换工作区（恢复该目录最近会话，无则新建） |
| `/workspace add <路径>` | 添加并切换到新工作区 |
| `/session list`（`/s`） | 最近 20 个会话（标题/工作区/时间/模式，标记当前） |
| `/session switch <编号>` | 切换到指定会话（自动切换工作区） |
| `/session new` | 新会话（当前工作区，用当前模式） |
| `/session status` | 当前会话信息 |
| `/agent list`（`/a`） | 可用 Agent 模式（preset）列表 |
| `/agent switch <名称\|编号>` | 切换模式：当前会话无内容时立即应用，否则应用于下一个新会话 |
| `/agent status` | 当前模式 |
| `/model list [提供商]` | 提供商列表 / 指定提供商下的模型 |
| `/model switch <提供商/模型>` | 切换模型（立即作用于当前会话 + 设为默认） |
| `/model status` | 当前会话模型与默认模型 |
| `/silent on\|off`（`/sl`） | 静默模式（跨重启持久化） |
| `/stop` | 中断当前任务（`agent.cancel`） |
| `/rp` | 拒绝所有待处理权限卡（微信端） |
| `/rq` | 拒绝所有待处理提问卡（微信端） |

其他 `/xxx` 命令作为文本转发给 agent。审批/提问卡与 GUI 双端同弹，
微信回复即注入原生决策；已在其他端处理的卡会提示。

映射关系：`/workspace` → `workspaceRegistry`；`/session` →
`sessionQuery` + 会话重绑定（agent resume）；`/agent` →
`agentPresets`（`recompose` 仅对无内容会话生效）；`/model` →
`agentDefaultModel` + `agent/request` 瀑布覆盖当前会话（与 DSH 官方
`installModelSelection` 同款协作模式）。

## 开发

```bash
npm install
npm run build    # tsc → dist/
npm test         # vitest（62 个用例：splitText/格式化/解析/帧处理/状态存储/命令解析）
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
- `/agent switch` 遵循 DSH 约束：只有未产生任何内容的会话才能当场
  `recompose`；已有内容的会话会提示模式应用于下一个新会话。
- iLink 通道是腾讯官方 bot 协议，接口可能随官方调整；跟随 wechat-opencode
  上游的 `src/weixin/` 修复即可。

## 许可

MIT。`src/weixin/`、`src/adapter/` 移植自
[wechat-opencode](https://github.com/pan17/wechat-opencode)（MIT，
原始来源 `@tencent-weixin/openclaw-weixin`），文件头保留出处注释。
