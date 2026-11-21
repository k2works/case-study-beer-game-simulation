#!/usr/bin/env bash
# コンテナのスモークテスト（設計: architecture-infrastructure。検証のみ。AWS 無関係）。
# 前提: docker build -t beer-game-rust:smoke apps/beer-game-rust 済み。使い方: scripts/container-smoke.sh [イメージ名]
# 確認: /ready と /health が 200、HEALTHCHECK が healthy、migrate が終了コード 0、秘密無しは 78、未実装モードは 64、
#       非 root、SIGTERM で終了コード 0（完了を待って終了）。
set -u
IMAGE="${1:-beer-game-rust:smoke}"
NET="beergame-smoke-$$"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   : $1"; else echo "FAIL : $1（期待 $3、実際 $2）"; fail=1; fi; }
cleanup() { docker rm -f "$NET-app" "$NET-db" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$NET-db" --network "$NET" -e POSTGRES_PASSWORD=pw postgres:18.6 >/dev/null
for _ in $(seq 1 40); do docker exec "$NET-db" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
DB="postgres://postgres:pw@$NET-db:5432/postgres"
KEY="0123456789abcdef0123456789abcdef0123"

# 設定の誤り（秘密無し）は 78、未実装のモードは 64
docker run --rm --network "$NET" "$IMAGE" >/dev/null 2>&1; check "DATABASE_URL 無しは終了コード 78" "$?" 78
docker run --rm "$IMAGE" nosuchmode >/dev/null 2>&1; check "未実装のモードは終了コード 64" "$?" 64
# migrate は適用して終了コード 0
docker run --rm --network "$NET" -e DATABASE_URL="$DB" -e CREDENTIAL_KEY="$KEY" "$IMAGE" migrate >/dev/null 2>&1; check "migrate は終了コード 0" "$?" 0

docker run -d --name "$NET-app" --network "$NET" -e DATABASE_URL="$DB" -e CREDENTIAL_KEY="$KEY" "$IMAGE" >/dev/null
health=""
for _ in $(seq 1 30); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$NET-app" 2>/dev/null)"
  [ "$health" = "healthy" ] && break
  sleep 2
done
check "HEALTHCHECK が healthy" "$health" healthy
check "非 root（nonroot）で動く" "$(docker exec "$NET-app" /beergame-app healthcheck >/dev/null 2>&1; echo $?)" 0
check "実行ユーザー" "$(docker inspect -f '{{.Config.User}}' "$NET-app")" nonroot
# 同じネットワークの別のコンテナ（DB のコンテナの bash）から、状態コードを取る（ホストからコンテナへは直接つなげない環境がある）
http_status() {
  docker exec "$NET-db" bash -c "exec 3<>/dev/tcp/$NET-app/8080; printf 'GET $1 HTTP/1.0\r\nHost: x\r\n\r\n' >&3; head -1 <&3 | cut -d' ' -f2"
}
check "/api/v1/ready が 200" "$(http_status /api/v1/ready)" 200
check "/api/v1/health が 200" "$(http_status /api/v1/health)" 200
# SIGTERM（docker stop）で、完了を待って終了コード 0
docker stop -t 30 "$NET-app" >/dev/null 2>&1
check "SIGTERM で終了コード 0" "$(docker inspect -f '{{.State.ExitCode}}' "$NET-app")" 0
[ "$fail" = 0 ] && echo "スモークテスト: 成功" || echo "スモークテスト: 失敗"
exit "$fail"
