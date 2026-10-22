# 发布与部署指南

## 发布前检查

### 检查 README.md / docs/DEVELOPMENT.md 是否需要同步

`README.md` 是**用户文档**（介绍、功能、安装、命令、开发、许可、免责），`docs/DEVELOPMENT.md` 是**维护者文档**（架构、设置页实现、配置参考、命令接入细节、已知边界、宿主版本兼容）。

README 以下情况**需要更新**：
- **用户可见的命令变更**（新增参数、行为变化、命令格式变化）
- **功能增减**（新增特性或移除功能）
- **安装方式变化**（包名、安装命令变化）

DEVELOPMENT 以下情况**需要更新**：
- **配置选项变化**（新增/删除配置键，或默认值变化）
- **实现细节变化**（架构、接入方式、边界与取舍）

以下情况**都不需要更新**：
- 内部逻辑优化但用户行为不变
- 仅修改注释、变量名、代码结构
- 纯 bug 修复（行为修正到预期状态）

### 检查 CHANGELOG.md 是否需要同步

CHANGELOG.md 是 GitHub Release Notes 的数据源，以下情况**需要更新**：
- **每次发版前**：在 `[Unreleased]` 下方写好本次版本的变更说明
- **用户可见的变更**：新增功能、行为变化、Bug 修复
- **格式**：遵循 [Keep a Changelog](https://keepachangelog.com/) 规范，分 `Added` / `Changed` / `Fixed` / `Removed` 等分类

以下情况**不需要更新**：
- 内部重构（不影响用户）
- 文档/注释调整

### 检查 DSH 版本约束

宿主版本要求写在 `package.json` 的**两处**，两者机制不同、**必须同时更新且值逐字相同**：

| 字段 | 谁在读 | 写错的后果 |
|---|---|---|
| `engines.dsh` | **只有**插件市场 `dshmarket`（宿主代码零处读它） | 市场展示的兼容性错误；不拦安装 |
| `peerDependencies["@deepseek-ai/dsh"]` | **宿主 `evaluatePluginCompatibility`，强制** | **整个 bundle 被跳过**，插件在桌面端消失 |

当前值（两处一致）：

```json
"engines": { "dsh": ">=0.2.1-0 <0.3.0-0" },
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.1-0 <0.3.0-0" },
"peerDependenciesMeta": { "@deepseek-ai/dsh": { "optional": true } }
```

改这个范围时必须遵守四条，每条都有实测依据：

1. **必须带上界。** 只写 `>=0.2.1-0` 会把 `0.3.0`、`1.0.0` 判为兼容（这正是旧值的缺陷）。
2. **上界必须是 `<0.3.0-0`，不能写 `<0.3.0`。** 宿主与市场都以 `{ includePrerelease: true }` 求值，`<0.3.0` 会放行 `0.3.0-rc.1`。
3. **peer 必须同时标 `peerDependenciesMeta.optional`。** 不加会**安装失败**：peer 被当成真实依赖解析，`@deepseek-ai/dsh` 是带 82 条 dependencies 的元包，会拉进 530 个包并撞上未发布包 `@deepseek-ai/dsh-type-meta` 的 npm 404。宿主门禁**不读** `peerDependenciesMeta`，所以标 `optional` 不影响强制力。
4. **不要改用前发布元组枚举。** 唯一消费者在 `includePrerelease` 语义下求值，单段 arm 已覆盖全部 0.2.x 前发布版；枚举永远补不全（每出现一个新的 0.2.x 元组都要再加一段）。

改完直接跑测试即可验证——`tests/host-line.test.ts` 已把准入/拒绝矩阵、两处声明的一致性、`optional` 标记、以及 `<0.3.0` 会漏 `0.3.0-rc.1` 这些全部钉死，写错会立刻变红。

---

## 发布流程

### 0. 本地构建与测试（必做）

发版前先在本地跑一遍，确认 build 和 test 都通过再推 tag：

```bash
npm ci          # 安装依赖（lockfile 精确版本）
npm run build   # tsc → dist/ + client bundle
npm test        # vitest 全部用例
```

> 若本次改过 `package.json` 的 `dependencies` / `devDependencies` / `engines` / `peerDependencies`，先同步 lockfile 再跑上面三步：
>
> ```bash
> npm install --package-lock-only   # 只更新 package-lock.json，不动 node_modules
> ```
>
> CI（`.github/workflows/ci.yml`）与发布工作流用的都是 `npm ci`，它要求 lockfile 与 `package.json` 严格一致——**不同步会直接失败**，而不是回退到解析依赖。

发布前可本地验证产物：

```bash
npm pack --dry-run   # 查看将发布的文件清单（dist/、README、LICENSE、cordis.patch.yml 等）
```

### 1. 写 CHANGELOG 并打版本（一条命令）

先在 `CHANGELOG.md` 的 `## [Unreleased]` 下方写好本次变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/)：

```markdown
### Added
- 新增功能...

### Changed
- 行为变化...

### Fixed
- Bug 修复...
```

> 这是 GitHub Release Notes 的**唯一**数据源，**每次发版必做**。`[Unreleased]` 为空时脚本会拒绝执行，因为那会发出一个没有内容的 Release。

然后执行：

```bash
npm run release -- patch --dry-run   # 只打印将要做什么，不改任何文件
npm run release -- patch             # 真正执行；patch / minor / major，或直接写 0.13.4
```

> **`--` 不能省。** `npm run <script> <参数>` 里的 `--flag` 会被 npm 当成**它自己的**配置项吞掉，不会传给脚本。`npm run release patch --dry-run` 曾经因此**真的执行了发布**（改版本、提交、打 tag），只是打印不同。脚本现在额外读取 `npm_config_dry_run` / `npm_config_push`，两种写法都安全，但请统一用带 `--` 的形式——第三个 flag 未必有这样的兜底。

脚本按顺序完成第 2、3 步，并在动手前逐条校验：

| 校验 | 不通过时 |
|---|---|
| 参数合法（`x.y.z` 或 `patch`/`minor`/`major`） | 拒绝 |
| 新版本 ≠ 当前版本 | 拒绝 |
| 工作区干净、当前分支是 `main` | 拒绝（发布提交必须是它唯一的改动） |
| 本地与远端都没有该 tag | 拒绝 |
| npm 上该版本为 404 | 拒绝（已发布的版本只能换号，不能重打 tag） |
| `[Unreleased]` 下至少有一条 `- ` 条目 | 拒绝（否则 Release Notes 为空） |

通过后它执行 `npm version <版本> --no-git-tag-version`（**同时**改 `package.json` 与 `package-lock.json`——版本号在 lockfile 里出现两次，手改 package.json 正是两者漂移的来源）、把 `[Unreleased]` 的条目归入新的 `## [版本] - 日期` 标题下、然后 `git commit -m "release: vX.Y.Z"` 与 `git tag vX.Y.Z`。

**脚本默认不推送**，停在打印 `git push origin main --tags` 这一步，等你确认。

### 2. 推送 Tag

注意，执行这一步前需要发送消息（已完成以上检查和修改）获取用户确认，然后才能执行。

```bash
git push origin main --tags
```

> **注意**：`git push` 的"同步"按钮**不会推送 tags**，必须单独执行 `git push origin --tags` 或 `git push origin vX.Y.Z`。

> 也可以一次性做完：`npm run release -- patch --push`。

### 3. 自动验证与发布

推送 tag 后，GitHub Actions 自动触发 `.github/workflows/release.yml`，依赖链是 `verify → release → publish-npm`：

1. **`verify`** — 在**该 tag 指向的提交上**自己跑 `npm ci` / `npm run build` / `npm test`，并校验 tag 与 `package.json` 的 `version` 一致。不一致就在这里失败，此时**还没有**创建任何 Release 或 npm 版本，删掉 tag 重打即可，无副作用。
2. **`release`** — 从 CHANGELOG 抽取该版本段落，创建 GitHub Release。抽不到该版本段落会失败。
3. **`publish-npm`** — `npm ci` → `npm publish`（`prepublishOnly` 已内置 build + test 双保险，工作流不再重复 build）。

> **为什么不再轮询 CI**：早期版本有个 `ci-green` job，用 `gh api` 轮询该提交的 CI 结论最多 5 分钟。它有两个无法修复的缺陷：`ci.yml` 只在 `push: branches: [main]` 触发，**单独推 tag 时根本没有 CI 可等**（必然超时）；而 `main` 与 tag 同时推时，CI 与轮询同时启动，一次 7m35s 的慢跑就会耗尽预算、拦下整个发布，只能手工重跑。现在 `verify` 在 tag 提交上原地验证，没有需要等待的对象。

> **`publish-npm` 等的是 `release`，不是 `verify`**。这是有意的：Release 创建失败（CHANGELOG 缺段落、API 抖动）时 npm 必须**不发**，否则两个产物会漂移。

> **前置条件**：在仓库 Settings → Secrets and variables → Actions 中配置 `DSH_WECHAT` secret，值为 npm 的 Automation Token（`npm token create --type automation` 生成）。名字必须与 `release.yml` 里 `NODE_AUTH_TOKEN: ${{ secrets.DSH_WECHAT }}` 一致，否则发布这一步会认证失败。

> **发布后核对**：npm 提示「Your package is being processed」后通常要等 1–3 分钟才可查。用 `npm view dsh-wechat version` 确认 `latest` 已指向新版本——`publish-npm` 显示成功只代表上传完成，registry 生效有延迟。

### 失败时怎么办

| 失败点 | 后果 | 处理 |
|---|---|---|
| `verify` 红（测试或 tag/版本不一致） | 无 Release、无 npm 版本 | 修好、删 tag 重打（`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`，再 `git tag vX.Y.Z && git push origin vX.Y.Z`） |
| `release` 红（CHANGELOG 缺该版本段落） | 无 npm 版本 | 补 CHANGELOG 后重打 tag |
| `publish-npm` 红 | Release 已存在、npm 没有 | `gh run rerun <run-id>` 重跑即可，**不需要**重打 tag |

> 重打 tag 的前提是 npm 上**还没有**这个版本，先 `npm view dsh-wechat@X.Y.Z version` 确认 404。

---
