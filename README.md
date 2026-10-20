# dsh-wechat

[![npm](https://img.shields.io/npm/v/dsh-wechat?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-wechat)
[![npm downloads](https://img.shields.io/npm/dm/dsh-wechat?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-wechat)
[![License](https://img.shields.io/github/license/pan17/dsh-wechat?style=flat-square)](https://github.com/pan17/dsh-wechat)

把微信变成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 的第二客户端：在微信里和你的 agent 聊天，收发文字、图片、文件和语音，用 slash 命令管理会话、工作区、模型与权限，审批卡和提问卡在微信与桌面端同步弹出。

<img src="./resources/send.jpg" alt="发送" width="32%" /> <img src="./resources/receive.jpg" alt="接收" width="32%" /> <img src="./resources/settings.png" alt="设置页" width="32%" />

## 功能

微信与 DSH 双向同步：文字、图片、文件、语音直接发给 agent，回复与执行过程推回微信，审批卡和提问卡两端同弹、谁先答谁生效；`/at` 可引用其它会话或文件，把几条消息或「截图 + 问题」合成一轮，静默模式与结论模式控制推送频率；会话、工作区、Preset、模型、权限都能在微信里用 slash 命令管理，与 GUI 同源；另有秘密脱敏、文件范围限制、入站白名单与审计日志等边界，以及内嵌在 DSH 设置里的扫码登录与配置页。

## 安装

要求 DSH `>=0.2.1-0 <0.3.0-0`。

**方式一：设置页**（推荐）— 打开 **设置 → 插件 → 添加插件**，填 `dsh-wechat`，点安装，然后重启 DSH。国内网络慢时把安装源切到**中国大陆镜像源**。

**方式二：命令行**（桌面版）

```bash
dsh plugin --profile desktop add dsh-wechat
dsh plugin --profile desktop list --depth 0    # 查看已装版本
```

安装后打开 **设置 → WeChat** 扫码登录（也可直接访问 `http://127.0.0.1:3080/wechat/qr`）。

## 微信命令

| 命令 | 说明 |
|---|---|
| `/help`（`/h`、`/?`） | 帮助，含当前 profile 已注册的 DSH 原生命令 |
| `/status` | 工作区、会话、模型、上下文、权限、各开关状态 |
| `/workspace`（`/ws`） | `list` / `status` / `switch <编号\|路径>` / `add <路径>` |
| `/session`（`/s`） | `list` / `switch` / `pin` / `unpin` / `new` / `status` |
| `/preset`（`/p`） | `list` / `switch <名称\|编号>` / `status` — 默认 Preset，与 GUI 同步 |
| `/model` | `list` / `switch <提供商/模型>` / `status` |
| `/perm` | `status` / `list` / `switch <名称\|编号>` / `default [名称\|编号]` |
| `/reasoning` | 查看或切换推理等级 |
| `/enter`（`/busy`） | 繁忙时 `queue` 排队还是 `steer` 插话 |
| `/silent`（`/sl`） | 静默模式：每轮只发最终回复 |
| `/final on\|off\|status`（`/fo`） | 结论模式：整条任务只发一条结论 |
| `/merge`（`/mg`） | 打字合并开关与状态 |
| `/media`（`/md`） | 图片/文件合并开关；`at\|path` 切换附件交付措辞 |
| `/at` | 引用其它会话（`s`）或文件/目录（`f`），附加到下一条消息 |
| `/notify`（`/watch`） | 跨会话决策推送；`tasks on\|off` 单独控制任务提醒 |
| `/history` | 查看最近历史，`all` 含系统消息 |
| `/flush`（`/f`） | 立即取回结论模式暂存的结论 |
| `/surface`（`/wxprompt`） | 微信渠道提示词注入开关 |
| `/stop` | 中断当前任务 |
| `/next` | 继续发送被微信限流缓存的消息 |
| `/rq` | 关闭当前会话的待处理卡 |

其它 `/xxx` 作为文本转发给 agent。DSH 原生 slash 命令（`/plan`、`/goal`、`/compact` 等）由 bridge 直接交给原生 handler，微信端无需改动即可识别。

## 开发

```bash
npm install
npm run build    # tsc → dist/
npm test         # vitest
```

改动代码后需**重启 DSH** 才会生效。架构、配置参考、命令接入细节、已知边界与宿主版本兼容见 **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**。

## 许可

MIT。`src/weixin/`、`src/adapter/` 移植自 [wechat-opencode](https://github.com/pan17/wechat-opencode)（MIT，原始来源 `@tencent-weixin/openclaw-weixin`），文件头保留出处注释。

## 免责声明

本项目与 DeepSeek Harness、腾讯微信官方**互不隶属**，非官方项目，纯属个人学习用途。使用本项目即表示你自行承担由此产生的一切后果。
