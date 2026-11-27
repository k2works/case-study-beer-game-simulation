#!/usr/bin/env bash
# コンテナのスモークテスト（B14）。ローカルの Docker だけを使う（AWS には接続しない）。
#
# 確かめること:
#   (a) migrate が、PostgreSQL にマイグレーションを適用して終了コード 0 で終わる（2 回目も 0。冪等）
#   (b) api が、PostgreSQL に接続し、/api/v1/ready に 200 で応答し、ゲームを作成できる（本番相当 APP_ENV=production）
#   (c) APP_ENV=production で秘密情報・DB の接続が無いと、終了コード 78 で起動に失敗する（秘密の値をログに出さない）
#   (d) APP_ENV=production DB_KIND=h2 は、終了コード 78 で起動に失敗する
#   (e) retention・verify が、終了コード 0 で終わる。不明なモードは 64
#   (f) 非 root（UID 10001）で実行する
#   (g) 起動時間: コンテナの開始から /ready が 200 になるまで（RUNS 回）
#
# 使い方: scripts/container-smoke.sh            （イメージをビルドして検査する）
#         RUNS=5 scripts/container-smoke.sh     （起動時間の計測の回数。既定 3）
#         SKIP_BUILD=1 IMAGE=... scripts/container-smoke.sh （ビルド済みのイメージを使う）
# 秘密の値（鍵・パスワード）は、実行のたびにこのスクリプトが作る使い捨てで、ファイルに残さない。
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-beer-game-scala:smoke}"
RUNS="${RUNS:-3}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-90}"
SUFFIX="smoke-$$"
NETWORK="bgs-$SUFFIX"
PG="bgs-pg-$SUFFIX"
DB_NAME="beergame"
DB_USER="beergame"
DB_PASSWORD="$(openssl rand -hex 16)"
CREDENTIAL_KEY="$(openssl rand -base64 32)"
FAILURES=0
CONTAINERS=()

now_ms() {
  local t
  t="$(date +%s%3N 2>/dev/null || true)"
  case "$t" in
    *N* | "") perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' ;;
    *) echo "$t" ;;
  esac
}

cleanup() {
  local c
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pass() { echo "  ok   : $1"; }
fail() {
  echo "  FAIL : $1" >&2
  FAILURES=$((FAILURES + 1))
}

prod_env() {
  printf '%s\n' \
    -e APP_ENV=production \
    -e "DB_URL=jdbc:postgresql://$PG:5432/$DB_NAME" -e "DB_USER=$DB_USER" -e "DB_PASSWORD=$DB_PASSWORD" \
    -e "BGS_CREDENTIAL_KEY=$CREDENTIAL_KEY"
}

LAST_LOG=""
run_once() {
  local code=0
  LAST_LOG="$(docker run --rm --network "$NETWORK" "$@" 2>&1)" || code=$?
  return "$code"
}

expect_exit() { # 説明 期待コード 実際のコード
  if [ "$3" -eq "$2" ]; then pass "$1（終了コード $3）"; else
    fail "$1（期待 $2、実際 $3）"
    echo "$LAST_LOG" | tail -5 >&2
  fi
}

expect_log() { # 説明 文字列
  if grep -q -- "$2" <<<"$LAST_LOG"; then pass "$1"; else
    fail "$1（ログに「$2」が無い）"
    echo "$LAST_LOG" | tail -5 >&2
  fi
}

echo "== イメージ =="
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  docker build -t "$IMAGE" .
fi
docker image inspect "$IMAGE" >/dev/null

echo "== PostgreSQL 18 を起動 =="
docker network create "$NETWORK" >/dev/null
docker run -d --name "$PG" --network "$NETWORK" \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  postgres:18-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    sleep 1
    docker exec "$PG" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
  fi
  sleep 1
done
docker exec "$PG" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null

mapfile -t PROD < <(prod_env)

echo "== (a) migrate =="
code=0
run_once "${PROD[@]}" "$IMAGE" migrate || code=$?
expect_exit "migrate がマイグレーションを適用して終わる" 0 "$code"
expect_log "migrate が完了を記録する" '"event":"migrate"'
code=0
run_once "${PROD[@]}" "$IMAGE" migrate || code=$?
expect_exit "migrate は 2 回目も成功する（冪等）" 0 "$code"

echo "== (c) 本番相当で秘密情報が無い =="
code=0
run_once -e APP_ENV=production "$IMAGE" api || code=$?
expect_exit "秘密情報・DB の接続が無いと api は起動に失敗する" 78 "$code"
expect_log "足りない設定の名前をログに出す" "BGS_CREDENTIAL_KEY"
code=0
run_once -e APP_ENV=production -e "DB_URL=jdbc:postgresql://$PG:5432/$DB_NAME" -e "DB_USER=$DB_USER" \
  -e "DB_PASSWORD=$DB_PASSWORD" "$IMAGE" api || code=$?
expect_exit "署名鍵だけが無くても失敗する" 78 "$code"
if grep -q -- "$DB_PASSWORD" <<<"$LAST_LOG"; then fail "ログにパスワードの値が出ている"; else pass "ログに秘密の値が出ない"; fi

echo "== (d) 本番相当で DB_KIND=h2 =="
code=0
run_once -e APP_ENV=production -e DB_KIND=h2 -e "BGS_CREDENTIAL_KEY=$CREDENTIAL_KEY" "$IMAGE" api || code=$?
expect_exit "production の H2 は起動に失敗する" 78 "$code"
expect_log "H2 の拒否をログに出す" "H2"

echo "== (e) retention・verify・不明なモード =="
code=0
run_once "${PROD[@]}" "$IMAGE" retention || code=$?
expect_exit "retention が掃引を 1 回行って終わる" 0 "$code"
expect_log "retention が結果を記録する" '"event":"retention.done"'
code=0
run_once "${PROD[@]}" "$IMAGE" verify || code=$?
expect_exit "verify が検査して終わる（不一致 0 件）" 0 "$code"
code=0
run_once "${PROD[@]}" "$IMAGE" bogus || code=$?
expect_exit "不明なモードは断る" 64 "$code"

echo "== (f) 非 root =="
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
if [ "$uid" = "10001" ]; then pass "UID $uid で実行する"; else fail "UID が $uid（10001 でない）"; fi

start_api() {
  local name="$1"
  docker run -d --name "$name" --network "$NETWORK" "${PROD[@]}" "$IMAGE" api >/dev/null
  CONTAINERS+=("$name")
}

# 確認用の curl は、常駐のコンテナに docker exec で送る（確認のたびにコンテナを起動すると、起動時間の計測が崩れる）
CURL="bgs-curl-$SUFFIX"
docker run -d --name "$CURL" --network "$NETWORK" --entrypoint sleep curlimages/curl:8.11.1 3600 >/dev/null
CONTAINERS+=("$CURL")

ready_status() { # コンテナ名 → HTTP ステータス（取れなければ 000）
  docker exec "$CURL" curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://$1:8080/api/v1/ready" 2>/dev/null || echo 000
}

echo "== (b) api（PostgreSQL に接続）と、ゲームの作成 =="
API="bgs-api-$SUFFIX"
start_api "$API"
ok=0
for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
  if [ "$(ready_status "$API")" = "200" ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then pass "api が /ready に 200 で応答する"; else
  fail "api が /ready に応答しない"
  docker logs "$API" 2>&1 | tail -10 >&2
fi
body='{"kind":"KIT","finalWeek":3,"demand":[4,4,4]}'
created="$(docker exec "$CURL" curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://$API:8080/api/v1/games" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-$$" -d "$body" || echo 000)"
if [ "$created" = "201" ]; then pass "PostgreSQL に、ゲームを作成できる（201）"; else fail "ゲームの作成が $created"; fi
docker rm -f "$API" >/dev/null 2>&1 || true

echo "== (g) 起動時間（コンテナの開始から /ready が 200 まで。$RUNS 回。マイグレーションの適用を除く）=="
TIMES=()
for i in $(seq 1 "$RUNS"); do
  name="bgs-t$i-$SUFFIX"
  t0="$(now_ms)"
  start_api "$name"
  for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
    if [ "$(ready_status "$name")" = "200" ]; then break; fi
    sleep 0.1
  done
  t1="$(now_ms)"
  TIMES+=($((t1 - t0)))
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "  run $i: $((t1 - t0)) ms"
done
echo "  起動時間（ms）: ${TIMES[*]}"

if [ "$FAILURES" -gt 0 ]; then
  echo "NG: $FAILURES 件の失敗" >&2
  exit 1
fi
echo "OK: コンテナのスモークテストが通った"
