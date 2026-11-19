#!/usr/bin/env bash
# 本番用イメージの検証: ビルド → マイグレーション → 起動 → /ready → DB 停止で 503。
# 非 root、開発依存を含まない、tsx を使わない、ことも確認する。
# 使い方: npm run container:check（Docker が必要。AWS には触れない）
set -euo pipefail

IMAGE="${IMAGE:-beer-game2:check}"
NET="bg2-check-net"
DB="bg2-check-db"
API="bg2-check-api"
PORT="${PORT:-13000}"
DB_URL="postgres://beer_game2:local-only@${DB}:5432/beer_game2"

cleanup() { docker rm -f "$API" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

ok() { echo "✓ $1"; }
fail() { echo "✗ $1" >&2; exit 1; }

docker build -q -t "$IMAGE" . >/dev/null || fail "イメージのビルドに失敗"
ok "イメージをビルド"

[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" != "0" ] && ok "非 root で動く" || fail "root で動いている"
docker run --rm --entrypoint sh "$IMAGE" -c 'test ! -e node_modules/.bin/vitest && test ! -e node_modules/.bin/tsx' \
  && ok "開発依存（vitest、tsx）を含まない" || fail "開発依存が含まれている"
docker run --rm --entrypoint sh "$IMAGE" -c 'test -x node_modules/.bin/node-pg-migrate' \
  && ok "マイグレーションの実行ファイルがある" || fail "node-pg-migrate が無い"

docker run --rm --entrypoint sh "$IMAGE" -c 'test -s "$NODE_EXTRA_CA_CERTS" && grep -q "BEGIN CERTIFICATE" "$NODE_EXTRA_CA_CERTS"' \
  && ok "RDS の CA バンドルを信頼（証明書の検証を有効のまま接続できる）" || fail "RDS の CA バンドルが無い"

docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_DB=beer_game2 -e POSTGRES_USER=beer_game2 -e POSTGRES_PASSWORD=local-only \
  postgres:18-alpine >/dev/null
for _ in $(seq 1 40); do
  docker exec "$DB" pg_isready -U beer_game2 >/dev/null 2>&1 && break
  sleep 1
done

docker run --rm --network "$NET" -e DATABASE_URL="$DB_URL" "$IMAGE" \
  node_modules/.bin/node-pg-migrate -m migrations --migrations-table pgmigrations up >/dev/null \
  && ok "マイグレーションを 1 回限りのタスクとして適用" || fail "マイグレーションに失敗"

docker run -d --name "$API" --network "$NET" -p "${PORT}:3000" \
  -e NODE_ENV=production -e DATABASE_URL="$DB_URL" -e ALLOWED_ORIGIN="https://staging.example.test" \
  -e CREDENTIAL_HMAC_KEY="$(printf 'ab%.0s' $(seq 1 32))" -e IDEMPOTENCY_KEY="$(printf 'cd%.0s' $(seq 1 32))" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  curl -sf "localhost:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "localhost:${PORT}/ready")" = "200" ] \
  && ok "/ready が 200（本番相当の設定で起動）" || { docker logs "$API" >&2; fail "/ready が 200 でない"; }

docker stop "$DB" >/dev/null
sleep 2
[ "$(curl -s -o /dev/null -w '%{http_code}' "localhost:${PORT}/ready")" = "503" ] \
  && ok "DB 停止で /ready が 503（プロセスは落ちない）" || fail "DB 停止で 503 にならない"

docker run --rm -e NODE_ENV=production "$IMAGE" >/dev/null 2>&1 \
  && fail "鍵が無いのに本番で起動できた" || ok "本番で鍵が無ければ起動に失敗"

echo; echo "コンテナの検証: OK"
