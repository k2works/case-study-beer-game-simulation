#!/usr/bin/env bash
# 受け入れ（共有の日本語 Gherkin の許可リスト）。`sbt test` には載せず、専用のジョブで実行する（ST7）。
# Undefined・Pending があれば失敗する（cucumber の既定）。
set -euo pipefail
cd "$(dirname "$0")/.."

sbt -batch "acceptance/Test/runMain bgs.acceptance.AcceptanceRunner"
