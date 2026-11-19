#!/usr/bin/env bash
# コンテナのスモークテスト（Bolt 3 Step 1）。ローカルの Docker だけを使う（AWS には接続しない）。
#
# 確かめること:
#   (a) api が、PostgreSQL（postgres:18-alpine）に接続し、/api/v1/ready に 200 で応答する（本番相当の設定 APP_ENV=production）
#   (b) migrate が、マイグレーションを適用して終了コード 0 で終わる
#   (c) APP_ENV=production で秘密情報が無いと、終了コード 78 で起動に失敗する
#   (d) APP_ENV=production DB_KIND=h2 は、終了コード 78 で起動に失敗する
#   (e) rebuild-projections・verify-projections（B12）が、ゲームの無い PostgreSQL に対して終了コード 0 で終わり、形が不正なゲーム ID は 64 で断る
#       （retention は B11 で実装した。コンテナでの実行の確認は、PostgreSQL と削除用のロールが要るので、このスクリプトの範囲外）
#   (f) イメージは、非 root で実行し、H2 のドライバを含まない（APP_ENV=local DB_KIND=h2 も起動できない）
#   (g) 起動時間: コンテナの開始から /ready が 200 になるまで（RUNS 回。マイグレーションの適用を除く）
#
# 使い方: scripts/container-smoke.sh            （イメージをビルドして検査する）
#         RUNS=7 scripts/container-smoke.sh     （起動時間の計測の回数。既定 3）
#         SKIP_BUILD=1 IMAGE=... scripts/container-smoke.sh （ビルド済みのイメージを使う）
# 秘密の値（鍵・パスワード）は、実行のたびにこのスクリプトが作る使い捨てで、ファイルに残さない。
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-beer-game-kotlin:smoke}"
RUNS="${RUNS:-3}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-90}"
SUFFIX="smoke-$$"
NETWORK="bgk-$SUFFIX"
PG="bgk-pg-$SUFFIX"
DB_NAME="beergame"
DB_USER="beergame"
DB_PASSWORD="$(openssl rand -hex 16)"
ORIGINS="https://smoke.example.test"
FAILURES=0
CONTAINERS=()

key() { openssl rand -base64 32; }
CREDENTIAL_KEY="$(key)"
IDEMPOTENCY_KEY="$(key)"
RESPONSE_KEY="$(key)"

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

# 本番相当の環境変数（秘密を含む）。
prod_env() {
  printf '%s\n' \
    -e APP_ENV=production -e DB_KIND=postgres \
    -e "DB_URL=jdbc:postgresql://$PG:5432/$DB_NAME" -e "DB_USER=$DB_USER" -e "DB_PASSWORD=$DB_PASSWORD" \
    -e "CREDENTIAL_KEY=$CREDENTIAL_KEY" -e "IDEMPOTENCY_KEY=$IDEMPOTENCY_KEY" -e "RESPONSE_KEY=$RESPONSE_KEY" \
    -e "ALLOWED_ORIGINS=$ORIGINS"
}

# docker run の終了コードを返す（--rm、ログは $LAST_LOG に残す）。
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
  # 初期化中の一時サーバーでなく、本起動後の接続を待つ（TCP で確認）
  if docker exec "$PG" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    sleep 1
    docker exec "$PG" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
  fi
  sleep 1
done
docker exec "$PG" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null

echo "== (b) migrate =="
mapfile -t PROD < <(prod_env)
code=0
run_once "${PROD[@]}" "$IMAGE" migrate || code=$?
expect_exit "migrate がマイグレーションを適用して終わる" 0 "$code"
expect_log "migrate がマイグレーションの適用を記録する" "マイグレーションを適用しました"

echo "== (c) 本番相当で秘密情報が無い =="
code=0
run_once -e APP_ENV=production -e DB_KIND=postgres \
  -e "DB_URL=jdbc:postgresql://$PG:5432/$DB_NAME" -e "DB_USER=$DB_USER" -e "DB_PASSWORD=$DB_PASSWORD" \
  -e "ALLOWED_ORIGINS=$ORIGINS" "$IMAGE" api || code=$?
expect_exit "秘密情報が無いと api は起動に失敗する" 78 "$code"
expect_log "足りない設定の名前をログに出す" "CREDENTIAL_KEY"
if grep -q -- "$DB_PASSWORD" <<<"$LAST_LOG"; then fail "ログにパスワードの値が出ている"; else pass "ログに秘密の値が出ない"; fi

echo "== (d) 本番相当で DB_KIND=h2 =="
code=0
run_once -e APP_ENV=production -e DB_KIND=h2 \
  -e "CREDENTIAL_KEY=$CREDENTIAL_KEY" -e "IDEMPOTENCY_KEY=$IDEMPOTENCY_KEY" -e "RESPONSE_KEY=$RESPONSE_KEY" \
  -e "ALLOWED_ORIGINS=$ORIGINS" "$IMAGE" api || code=$?
expect_exit "production の H2 は起動に失敗する" 78 "$code"
expect_log "H2 の拒否をログに出す" "H2"

echo "== (e) 投影の再構築と整合の検査（ゲームが無い DB） =="
code=0
run_once "${PROD[@]}" "$IMAGE" rebuild-projections || code=$?
expect_exit "rebuild-projections はゲームが無くても 0 で終わる" 0 "$code"
expect_log "rebuild-projections が結果を記録する" "再構築 0 ゲーム"
code=0
run_once "${PROD[@]}" "$IMAGE" verify-projections || code=$?
expect_exit "verify-projections は不一致 0 で 0 で終わる" 0 "$code"
expect_log "verify-projections が結果を記録する" "不一致 0"
code=0
run_once "${PROD[@]}" "$IMAGE" rebuild-projections not-a-uuid || code=$?
expect_exit "rebuild-projections は形が不正なゲーム ID を 64 で断る" 64 "$code"

echo "== (f) イメージの内容 =="
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
if [ "$uid" != "0" ]; then pass "非 root で実行する（uid=${uid}）"; else fail "root で実行している"; fi
h2jars="$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/lib | grep -i "^h2" || true')"
if [ -z "$h2jars" ]; then pass "H2 のドライバを含まない"; else fail "H2 のドライバを含む: $h2jars"; fi
code=0
run_once -e APP_ENV=local -e DB_KIND=h2 "$IMAGE" api || code=$?
if [ "$code" -ne 0 ]; then pass "local の H2 も起動できない（ドライバが無い。終了コード ${code}）"; else fail "H2 で起動してしまった"; fi

echo "== (a)(g) api が /ready に応答し、起動時間を測る =="
TIMES=()
for i in $(seq 1 "$RUNS"); do
  name="bgk-api-$SUFFIX-$i"
  CONTAINERS+=("$name")
  start="$(now_ms)"
  docker run -d --name "$name" --network "$NETWORK" -p 127.0.0.1::8080 "${PROD[@]}" "$IMAGE" api >/dev/null
  port="$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')"
  status=""
  deadline=$(($(now_ms) + READY_TIMEOUT_SECONDS * 1000))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$port/api/v1/ready" 2>/dev/null || true)"
    [ "$status" = "200" ] && break
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then break; fi
    sleep 0.05
  done
  end="$(now_ms)"
  if [ "$status" = "200" ]; then
    TIMES+=("$((end - start))")
    pass "api が /api/v1/ready に 200 で応答（$((end - start)) ms）"
  else
    fail "api が /ready に応答しない（status=${status}）"
    docker logs "$name" 2>&1 | tail -15 >&2
  fi
  if [ "$i" -eq 1 ] && [ "$status" = "200" ]; then
    health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/health" || true)"
    [ "$health" = "200" ] && pass "/api/v1/health が 200" || fail "/api/v1/health が $health"
    # HEALTHCHECK が healthy になること（start-period の後に確認）
    for _ in $(seq 1 60); do
      hs="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
      [ "$hs" = "healthy" ] && break
      sleep 1
    done
    [ "$hs" = "healthy" ] && pass "HEALTHCHECK が healthy" || fail "HEALTHCHECK が $hs"
    # SIGTERM で正常に終了する（終了コード 0）
    docker stop -t 20 "$name" >/dev/null
    stopcode="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
    # JVM は、SIGTERM でシャットダウンフックを実行した後、終了コード 143（128+15）で終わる。強制終了（137）は失敗。
    case "$stopcode" in
      0 | 143) pass "SIGTERM で猶予内に終了（終了コード ${stopcode}）" ;;
      *) fail "SIGTERM の終了コードが ${stopcode}（猶予内の終了でない）" ;;
    esac
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
done
echo "起動時間（ms。コンテナの開始から /ready=200 まで。docker run -d の呼び出しを含む）: ${TIMES[*]:-なし}"

if [ "$FAILURES" -ne 0 ]; then
  echo "スモークテスト: $FAILURES 件の失敗" >&2
  exit 1
fi
echo "スモークテスト: すべて成功"
