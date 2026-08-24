# 发布与部署指南

## 发布前检查

### 检查 README.md 是否需要同步

README 是用户文档，以下情况**需要更新**：
- **用户可见的命令变更**（新增参数、行为变化、命令格式变化）
- **功能增减**（新增特性或移除功能）
- **安装方式变化**（包名、安装命令变化）
- **配置选项变化**（新增/删除配置键）

以下情况**不需要更新**：
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

---

## 发布流程

### 0. 本地构建与测试（必做）

发版前先在本地跑一遍，确认 build 和 test 都通过再推 tag：

```bash
npm ci          # 安装依赖（lockfile 精确版本）
npm run build   # tsc → dist/ + client bundle
npm test        # vitest 全部用例
```

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
