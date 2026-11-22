#!/usr/bin/env bash
# 查官方开源仓（zai-org/ZCode）有没有比我们新的版本。
# 用法：bash scripts/acp-dev/check-upstream.sh
# 输出：UPSTREAM_SAME <版本>  或  UPSTREAM_NEW <官方最新> (我们基于 <版本>)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
UP=https://github.com/zai-org/ZCode.git
latest=$(git ls-remote --tags "$UP" 'v*' | grep -v '\^{}' | sed 's#.*refs/tags/##' | sort -V | tail -1)
ours=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo unknown)
if [ "$latest" = "$ours" ]; then
  echo "UPSTREAM_SAME $ours"
else
  echo "UPSTREAM_NEW $latest (我们基于 $ours)"
fi
