# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
