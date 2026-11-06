#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
repo="BreakTheEarth/secEventTracePlatform"
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
tag="v${version}"
archive="release/trace-security-operations-beta-${version}.zip"

command -v gh >/dev/null || { echo "请先安装 GitHub CLI（gh）。"; exit 1; }
gh auth status --hostname github.com >/dev/null 2>&1 || {
  echo "请先执行 gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow"; exit 1;
}
if [[ "$(gh api "repos/${repo}" --jq '.permissions.push')" != "true" ]]; then
  echo "当前 GitHub 账号没有 ${repo} 的写入权限。"
  echo "请使用 gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow 登录仓库所有者或协作者账号。"
  exit 1
fi
[[ "$(git branch --show-current)" == "main" ]] || { echo "请切换到 main 分支。"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "请先提交当前源码修改，再发布。"; exit 1; }
[[ "$(git remote get-url origin)" == "https://github.com/${repo}.git" ]] || {
  echo "origin 地址不符合预期，请核对远程仓库。"; exit 1;
}
git fetch origin main
git merge-base --is-ancestor origin/main HEAD || {
  echo "远程有尚未合并的提交，请先合并 origin/main；脚本不会强制覆盖。"; exit 1;
}
if git show-ref --verify --quiet "refs/tags/${tag}"; then
  [[ "$(git rev-list -n 1 "$tag")" == "$(git rev-parse HEAD)" ]] || {
    echo "${tag} 已指向其他提交，请核对版本；脚本不会移动标签。"; exit 1;
  }
fi
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo "该版本 Release 已存在，脚本不会覆盖。"
  gh release view "$tag" --repo "$repo" --json url --jq '.url'
  exit 1
fi

npm test
npm run build
npm run package:source
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin main
git show-ref --verify --quiet "refs/tags/${tag}" || git -c tag.gpgSign=false tag "$tag"
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin "$tag"
gh release create "$tag" "$archive" "${archive}.sha256" \
  --repo "$repo" --verify-tag --prerelease \
  --title "Trace ${tag}" --notes-file docs/RELEASE-NOTES.md
echo "源码与 Beta Release 已发布："
gh release view "$tag" --repo "$repo" --json url --jq '.url'
