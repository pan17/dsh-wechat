# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
