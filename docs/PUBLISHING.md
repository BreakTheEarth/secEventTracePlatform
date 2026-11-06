# 发布到 GitHub

目标仓库：<https://github.com/BreakTheEarth/secEventTracePlatform>。

- 仓库 `main` 分支保存源码、测试、文档和演示截图。
- 根目录 `README.md` 自动作为仓库首页介绍，底部显示 Star History 趋势图。
- Releases 保存带版本号的 ZIP 源码包与 SHA-256 校验文件，版本标记为 Pre-release。
- 数据库、业务附件、`.env`、依赖和运行日志不上传。

## 1. 登录有权限的账号

需要 Git、Node.js 22.13 或以上、npm 和 GitHub CLI（`gh`）。在终端执行：

```bash
gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow
```

在浏览器中使用仓库所有者或有写入权限的协作者账号授权。密码和验证码只在 GitHub 页面填写。

检查账号及权限：

```bash
gh auth status
gh api repos/BreakTheEarth/secEventTracePlatform --jq '.permissions.push'
```

最后一条应返回 `true`。账号与仓库所有者名称不同也可以发布，前提是被授予写入权限。

## 2. 准备源码与远程地址

在项目目录执行：

```bash
npm ci
npm test
npm run build
npm run check:release
git status --short
git remote -v
```

公开前人工核对修改范围，提交需要发布的源码。不要使用 `git add -f` 将忽略文件加入仓库。

`origin` 应为 `https://github.com/BreakTheEarth/secEventTracePlatform.git`。本地已经有该地址时不必再次添加。

若从零准备本地仓库，而 GitHub 已有 README，优先先克隆远程仓库，再复制公开源码进去提交；不要强制推送覆盖远程历史。当前准备好的 Beta 已合并远程初始 README 的历史。

## 3. 执行发布脚本

确认源码已经提交且当前为 `main` 分支后，执行：

```bash
bash scripts/publish-beta.sh
```

脚本依次检查账号权限、分支、提交状态和远程历史，运行测试与构建，生成 ZIP，再推送源码和版本标签，创建 Beta Release 并上传 ZIP 与校验文件。

脚本不会强制推送、移动已有版本标签或覆盖已发布的 Release。若远程有尚未合并的更新，会先停止并提示合并。

生成的附件：

```text
release/trace-security-operations-beta-0.1.0-beta.1.zip
release/trace-security-operations-beta-0.1.0-beta.1.zip.sha256
```

上传源码后，GitHub Actions 会在 Node.js 22 和 24 上执行测试与构建。脚本创建 Release 不代表远程 CI 已通过，需要在仓库 Actions 页确认。

## 4. 只生成 ZIP 或手动创建 Release

只打包、不推送：

```bash
npm run build
npm run package:source
```

ZIP 与程序源码使用同一份白名单，包含文档及演示截图，不含本地运行数据或 `dist/`。接收者解压后运行 `npm ci`、`npm run build`、`npm start`。

也可在 GitHub 仓库打开 **Releases → Draft a new release**，选择已推送的 `v0.1.0-beta.1` 标签，填写标题 `Trace v0.1.0-beta.1`，复制 `docs/RELEASE-NOTES.md` 的内容，上传 ZIP 与 `.zip.sha256`，勾选 **Set as a pre-release** 后发布。

## 5. 发布后检查

打开仓库首页，确认源码目录、README 中的 3 张截图和底部 Star History 图。Star History 是第三方服务生成的趋势图，数据展示可能有延迟。

打开 Releases，确认版本为 `v0.1.0-beta.1`，并且附件包含项目 ZIP 和 SHA-256 文件。GitHub 还会自动提供 `Source code (zip/tar.gz)`，这是平台生成的源码快照，与手动上传的版本 ZIP 可以同时存在。
