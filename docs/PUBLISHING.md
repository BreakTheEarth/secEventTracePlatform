# 发布到 GitHub

本仓库使用独立源码和全新 Git 历史。公开仓库及 Release 只接收源码，不接收本地体验或实际运营数据。

## 1. 本地验证

在项目根目录执行：

```bash
npm ci
npm test
npm run build
npm run check:release
npm run package:source
```

`check:release` 检查源码白名单、公开版本、配置模板、构建文件、公司标识及部分常见凭据格式，并核对 Git 跟踪文件范围。它不能代替提交前人工检查。

## 2. 检查提交范围

```bash
git status --short
git ls-files
```

允许提交源代码、测试、文档、依赖锁文件和 CI 配置。`.env.example` 是无凭据模板，可以提交。

`data/`、`.env`、`node_modules/`、`dist/`、`output/`、`release/`、数据库、私钥和运行日志均已忽略。不要使用 `git add -f` 绕过这些规则。

如果仓库已经有初始提交，直接使用现有 `main` 分支。尚未初始化时：

```bash
git init -b main
git add .
git commit -m "feat: add standalone security operations beta"
```

提交者身份由发布者自行设置；公开前检查 `git log --format=fuller`，不要使用包含内部信息的作者邮箱。

## 3. 建立公开仓库

安装并登录 GitHub CLI 后，把 `YOUR_ACCOUNT` 替换为自己有权发布的账号或组织：

```bash
gh auth status
gh repo create YOUR_ACCOUNT/trace-security-operations-beta \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "Self-hosted security event and campaign management"
```

如果目标仓库已存在，先核对远程地址后再添加 `origin`、推送 `main`，不要强制覆盖远程历史。推送后查看 GitHub Actions 的 Node.js 22/24 测试结果。

## 4. 发布 Beta Release

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
gh release create v0.1.0-beta.1 \
  release/trace-security-operations-beta-0.1.0-beta.1.tar.gz \
  release/trace-security-operations-beta-0.1.0-beta.1.tar.gz.sha256 \
  --verify-tag \
  --prerelease \
  --title "v0.1.0-beta.1" \
  --notes-file CHANGELOG.md
```

接收者解压源码后执行 `npm ci`、`npm run build`、`npm start`。源码包不含预构建依赖、业务数据或管理员配置。该包面向本 Beta 的独立部署。
