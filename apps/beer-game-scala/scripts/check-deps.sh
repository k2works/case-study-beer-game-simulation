#!/usr/bin/env bash
# 層の依存の検査（sbt の dependsOn に加え、外部ライブラリの持ち込みを止める）。
#  - domain の libraryDependencies（Test を除く）は cats-core だけ
#  - application は http4s・circe・doobie-postgres・doobie-hikari を持たない
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "NG: $1" >&2; exit 1; }

deps() {
  sbt -batch "show $1/libraryDependencies" 2>&1 | grep -E "^\[info\] \* |List\(" | tr ',' '\n' \
    | grep -oE "[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+(:[a-z]+)?" || true
}

domain_main=$(deps domain | grep -v -E ":(test|plugin)$" | grep -v "scala3-library" || true)
[ "$domain_main" = "org.typelevel:cats-core:2.13.0" ] \
  || fail "domain の依存は cats-core だけのはず（実際: ${domain_main:-なし}）"
echo "OK: domain は cats-core だけに依存する"

app_deps=$(deps application | grep -E "http4s|circe|doobie-postgres|doobie-hikari" || true)
[ -z "$app_deps" ] || fail "application が持ってはならない依存: $app_deps"
echo "OK: application は http4s・circe・doobie-postgres・doobie-hikari を持たない"
