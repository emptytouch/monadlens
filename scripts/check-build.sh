#!/bin/bash
# Netlify build.ignore 判定脚本
# 退出码 0 → 跳过构建；非 0 → 执行构建
#
# 规则：本次提交只包含文档/资源类文件（pptx/docx/md/html/README/.gitignore）时跳过构建；
#       只要出现代码、配置或依赖变更，就正常部署。

set -u

PREV="${CACHED_COMMIT_REF:-}"
CUR="${COMMIT_REF:-HEAD}"

# 首次部署（没有上次 commit）或无法比对 → 直接构建
if [ -z "$PREV" ]; then
  echo "首次部署，正常构建"
  exit 1
fi

changed=$(git diff --name-only "$PREV" "$CUR" 2>/dev/null || echo "ALL_CHANGES")
if [ "$changed" = "ALL_CHANGES" ]; then
  echo "无法比对提交范围，正常构建"
  exit 1
fi

# 遍历变更文件，出现任何非文档类变更则构建
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.pptx|*.docx|*.md|*.html|README.md|.gitignore)
      # 文档 / 资源 / 仓库元信息 → 允许跳过
      ;;
    *)
      echo "检测到需部署的变更: $f → 执行构建"
      exit 1
      ;;
  esac
done <<< "$changed"

echo "仅文档/资源类变更，跳过 Netlify 构建"
exit 0
