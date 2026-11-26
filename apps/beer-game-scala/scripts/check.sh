#!/usr/bin/env bash
# 全検査（ローカルと CI の `check` ジョブで同じコマンド）。1 つでも失敗したらマージしない。
#   1. 整形（Scalafmt）
#   2. 静的解析（scalac の -Werror、WartRemover は compile、Scalafix）
#   3. テスト
#   4. 規則そのものの確認（fixture の期待件数）
#   5. 層の依存
set -euo pipefail
cd "$(dirname "$0")/.."

sbt -batch scalafmtCheckAll scalafmtSbtCheck "scalafixAll --check" test
./scripts/check-rules.sh
./scripts/check-deps.sh
echo "OK: すべての検査が通った"
