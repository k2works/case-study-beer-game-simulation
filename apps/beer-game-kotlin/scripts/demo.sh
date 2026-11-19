#!/usr/bin/env bash
# デモ環境（Heroku）の運用タスク。手順は docs/operation/beer-game-kotlin/demo.md。
# 使い方: scripts/demo.sh <setup|deploy|build|push|release|status|restart|stop|start>
#   setup    アプリの作成と Config Vars の設定（冪等。2 回目以降は、作成を飛ばして Config Vars を合わせるだけ）
#   deploy   build → push → release を、ガードつきで順に行う（手元からの配備。CI が使えないとき）
#   build    イメージを作る（--target demo。Docker v2 の manifest。ラベルに HEAD の SHA）
#   push     イメージを Heroku の Container Registry へ送る（ラベルが HEAD でなければ止める）
#   release  送ったイメージを release し、dyno の種類と DEMO_REVISION を合わせる
#   status   dyno・Config Vars・動いているコミット
#   restart / stop / start  再起動（データは初期状態に戻る）・停止・再開
# 環境変数: DEMO_APP（既定 beer-game-kotlin-demo）、DEMO_SKIP_GUARD=1（ガードを飛ばす。使ったら理由を記録する）
set -euo pipefail

APP="${DEMO_APP:-beer-game-kotlin-demo}"
BRANCH="${DEMO_BRANCH:-develop}"
WORKFLOW="beer-game-kotlin.yml"
APP_DIR="apps/beer-game-kotlin"
IMAGE="registry.heroku.com/${APP}/web"
JAVA_OPTIONS="-Xmx300m -XX:+UseSerialGC -Xss512k -XX:ReservedCodeCacheSize=64m -XX:MaxMetaspaceSize=192m"

cd "$(git rev-parse --show-toplevel)"

die() { echo "エラー: $*" >&2; exit 1; }

guard() {
  [ "${DEMO_SKIP_GUARD:-}" = "1" ] && { echo "警告: ガードを飛ばします（DEMO_SKIP_GUARD=1）。理由を記録してください。" >&2; return 0; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "作業ツリーに変更があります。コミットしてください。"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "${BRANCH} から配備してください。"
  git fetch -q origin "$BRANCH"
  git merge-base --is-ancestor HEAD "origin/${BRANCH}" || die "HEAD が origin/${BRANCH} にありません。push して CI を待ってください。"
  local last conclusion
  last="$(git log -1 --format=%H -- "$APP_DIR" .github/workflows/${WORKFLOW})"
  conclusion="$(gh run list --workflow "$WORKFLOW" --commit "$last" --json conclusion --jq '[.[]|select(.conclusion=="success")]|length')"
  [ "${conclusion:-0}" -ge 1 ] || die "アプリの最後の変更（${last:0:7}）の CI が緑ではありません。gh run list で確かめてください。"
}

setup() {
  if heroku apps:info -a "$APP" >/dev/null 2>&1; then
    echo "アプリ ${APP} は作成済みです。Config Vars を合わせます。"
  else
    heroku create "$APP" --stack container --region us
  fi
  # H2 は APP_ENV=local のときだけ許される（ADR-014）。host は 0.0.0.0、画面は WEB_ROOT から配信する（Dockerfile の demo ステージ）
  heroku config:set -a "$APP" JAVA_TOOL_OPTIONS="$JAVA_OPTIONS" APP_ENV=local DB_KIND=h2 HOST=0.0.0.0 >/dev/null
  heroku labs:enable log-runtime-metrics -a "$APP" >/dev/null || true
  echo "セットアップ済み: $(web_url)"
}

# Heroku の URL は、アプリ名に識別子が付く（例: beer-game-kotlin-demo-xxxx.herokuapp.com）ので、アプリの情報から取る。
web_url() { heroku apps:info -a "$APP" 2>/dev/null | awk '/Web URL/ {print $3}'; }

build() {
  guard
  docker buildx build --target demo --provenance=false --sbom=false \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
    --output "type=image,name=${IMAGE},oci-mediatypes=false" "$APP_DIR"
}

push() {
  local label head
  label="$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)"
  head="$(git rev-parse HEAD)"
  [ "${DEMO_SKIP_GUARD:-}" = "1" ] || [ "$label" = "$head" ] || die "手元のイメージは HEAD から作ったものではありません。build を先に行ってください。"
  docker push "$IMAGE" || die "push に失敗しました。heroku container:login をしましたか。"
}

release() {
  heroku container:release web -a "$APP"
  heroku ps:type web=eco -a "$APP"
  heroku config:set -a "$APP" DEMO_REVISION="$(git rev-parse HEAD)" >/dev/null
}

status() {
  heroku ps -a "$APP"
  heroku config -a "$APP"
  echo "URL: $(web_url)"
}

case "${1:-}" in
  setup) setup ;;
  build) build ;;
  push) push ;;
  release) release ;;
  deploy) build; push; release ;;
  status) status ;;
  restart) heroku restart -a "$APP" ;;
  stop) heroku ps:scale web=0 -a "$APP" ;;
  start) heroku ps:scale web=1 -a "$APP" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
