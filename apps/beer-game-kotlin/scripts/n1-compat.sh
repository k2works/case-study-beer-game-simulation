#!/usr/bin/env bash
# N-1 互換の検査（B12。NF-O11、運用の障害パターン 16。設計: test-strategy.md「N-1 互換のジョブ（M22）」）。
#
# 直前のリリース（タグ）の**読み取り側**（EventCodec と、そのアップキャスト）が、**現在の書く版**が作るイベントを読めることを確かめる。
# 旧イメージが新しいイベントを読めないと、ロールバックが効かなくなる（読む版 → 書く版の 2 段階に反する変更を、リリース前に検出する）。
#
# 手順:
#   1. 現在の版の golden（全イベントの種類の JSON）を書き出す（GoldenFixtureSpec。環境変数 GOLDEN_EXPORT）
#   2. 直前のリリースを git worktree で取り出す
#   3. 読み取りの検査（N1CompatibilitySpec。EventCodec.decode の公開の入口だけを使う）を、そこへ複写し、現在の golden を渡して実行する
#
# 使い方: scripts/n1-compat.sh <直前のリリースのタグ、または git の参照（例: beer-game-kotlin-v0.1.0、HEAD~1）>
# 直前のリリースが無い間（最初のリリース前）は、呼ばない（CI のジョブが、タグの有無で分ける）。
set -euo pipefail

cd "$(dirname "$0")/.."

PREVIOUS="${1:?直前のリリースのタグ（または git の参照）を指定してください}"
APP_DIR="$(pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
APP_REL="${APP_DIR#"$REPO_ROOT"/}"
SPEC_DIR="adapter-persistence/src/test/kotlin/beergame/persistence"
WORK="$(mktemp -d)"

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WORK/previous" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== 現在の版の golden を書き出す =="
GOLDEN_EXPORT="$WORK/current-events.json" \
  ./gradlew --console=plain :adapter-persistence:cleanTest :adapter-persistence:test \
  --tests 'beergame.persistence.GoldenFixtureSpec'
test -s "$WORK/current-events.json" || { echo "golden を書き出せなかった" >&2; exit 1; }

echo "== 直前のリリース（${PREVIOUS}）を取り出す =="
git -C "$REPO_ROOT" worktree add --detach "$WORK/previous" "$PREVIOUS" >/dev/null
OLD_APP="$WORK/previous/$APP_REL"
mkdir -p "$OLD_APP/$SPEC_DIR"
cp "$SPEC_DIR/N1CompatibilitySpec.kt" "$OLD_APP/$SPEC_DIR/N1CompatibilitySpec.kt"

echo "== 直前のリリースの読み取り側で、現在の golden を読む =="
(
  cd "$OLD_APP"
  N1_GOLDEN_FILES="$WORK/current-events.json" \
    ./gradlew --console=plain :adapter-persistence:test --tests 'beergame.persistence.N1CompatibilitySpec'
)
echo "N-1 互換: ${PREVIOUS} の読み取り側は、現在の版が書くイベントをすべて読めた"
