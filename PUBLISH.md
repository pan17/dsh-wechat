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

### 1. 更新 CHANGELOG.md（必做）

在 `[Unreleased]` 下方写好本次版本的变更说明，格式遵循 [Keep a Changelog](https://keepachangelog.com/)：

```markdown
## [0.1.1] - 2026-08-16

### Added
- 新增功能...

### Changed
- 行为变化...

### Fixed
- Bug 修复...
```

> 这是 GitHub Release Notes 的数据源，**每次发版必做**。

### 2. 更新版本号

编辑 `package.json` 中的 `version` 字段：

```json
{
  "version": "0.1.1"
}
```

### 3. 提交代码并推送 Tag

注意，执行下列步骤前需要发送消息（已完成以上检查和修改）获取用户确认，然后才能执行。

```bash
git add -A
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

> **注意**：`git push` 的"同步"按钮**不会推送 tags**，必须单独执行 `git push origin --tags` 或 `git push origin v0.1.1`。

### 4. 自动构建与发布

推送 tag 后，GitHub Actions 会自动触发 `.github/workflows/release.yml`，依次执行：

1. **`publish-npm`** — 安装依赖 → 构建 → 测试 → 发布到 npm（使用 `NPM` secret 认证；`prepublishOnly` 已内置 build + test 双保险）
2. **`release`** — npm 发布成功后，自动创建带 Release Notes 的 GitHub Release

> **前置条件**：在仓库 Settings → Secrets and variables → Actions 中配置 `NPM` secret，值为 npm 的 Automation Token（`npm token create --type automation` 生成）。

---
