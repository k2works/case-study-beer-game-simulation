#!/usr/bin/env bash
# 画面の受け入れ（@ui。Cucumber-JS + Playwright）。Scala のバックエンドを専用ポート（API 3100、UI 5273）で起動して実行する。
# 人の開発サーバー（3000・5173）は止めない。B1〜B7 の範囲は AC2.3.1（ウォーキングスケルトン）・AC1.1.3（カスタム条件）・AC2.4.1（自動確定）（範囲を広げるときは引数でタグ式を渡す）。
# 使い方: ./scripts/ui-acceptance.sh ["タグ式。既定は @ui and (@AC2.3.1 or @AC1.1.3 or @AC2.4.1)"]
set -euo pipefail
cd "$(dirname "$0")/.."

# Cucumber-JS は Node 22・24・26 以上だけ対応。プロジェクトは Node 26（nvm）を使う。
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 26 >/dev/null
fi

tags="${1:-@ui and (@AC2.3.1 or @AC1.1.3 or @AC2.4.1)}"
log="${BGS_UI_LOG:-$(mktemp)}"

PORT=3100 sbt -batch "app/runMain bgs.app.Main" >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; pkill -f "bgs.app.Main" 2>/dev/null || true' EXIT

for _ in $(seq 1 90); do
  curl -sf http://127.0.0.1:3100/api/v1/ready >/dev/null && break
  sleep 2
done
curl -sf http://127.0.0.1:3100/api/v1/ready >/dev/null || { echo "NG: バックエンドが起動しない" >&2; tail -20 "$log" >&2; exit 1; }

(cd ../beer-game-web && API_PORT=3100 UI_PORT=5273 npx cucumber-js --tags "$tags")
