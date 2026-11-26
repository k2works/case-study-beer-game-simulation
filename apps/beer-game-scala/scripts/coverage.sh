#!/usr/bin/env bash
# 行カバレッジのゲート（team の「行 80%」。案 C）。scoverage は文と分岐しか出さないので、
# XML の文の行番号から行率を算出する（tools/line-coverage）。しきい値を割ると失敗する。
# 使い方: ./scripts/coverage.sh [全体のしきい値（%）。既定 80] [プロジェクト=しきい値…]（例: domain=95）
set -euo pipefail
cd "$(dirname "$0")/.."

threshold="${1:-80}"
sbt -batch clean coverage test coverageAggregate >/dev/null
xml="target/scala-3.7.4/scoverage-report/scoverage.xml"
[ -f "$xml" ] || { echo "NG: $xml が無い" >&2; exit 1; }
sbt -batch "coverageTool/run $PWD/$xml $threshold ${*:2}"
