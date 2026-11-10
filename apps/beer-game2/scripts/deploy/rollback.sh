#!/usr/bin/env bash
# ロールバック: 直前（または指定）のイメージのダイジェストと、静的ファイルの版へ戻す。
# マイグレーションは戻さない（スキーマは、拡張 → 互換 → 縮小の順で、旧アプリと互換にしてある）。
#
# 必須の環境変数: AWS_REGION ECS_CLUSTER ECS_SERVICE WEB_BUCKET DISTRIBUTION_ID
# 任意: TARGET_RELEASE（戻す先のコミット SHA。省略すると、現在と違う直近の成功した版）
# 注意: AWS に接続するため、パイプライン（OIDC）から実行する。まだ AWS で検証していない。
set -euo pipefail

: "${AWS_REGION:?}" "${ECS_CLUSTER:?}" "${ECS_SERVICE:?}" "${WEB_BUCKET:?}" "${DISTRIBUTION_ID:?}"
TARGET_RELEASE="${TARGET_RELEASE:-}"

log() { echo "==> $*"; }

CURRENT_TD="$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --query 'services[0].taskDefinition' --output text)"
log "現在のタスク定義: $CURRENT_TD"

# 履歴（新しい順）から戻す先を選ぶ
KEYS="$(aws s3api list-objects-v2 --bucket "$WEB_BUCKET" --prefix deployments/ \
  --query 'reverse(sort_by(Contents, &Key))[].Key' --output text | tr '\t' '\n')"

TARGET_JSON=""
for key in $KEYS; do
  entry="$(aws s3 cp "s3://$WEB_BUCKET/$key" - --only-show-errors)"
  release="$(jq -r .release <<<"$entry")"
  td="$(jq -r .apiTaskDefinition <<<"$entry")"
  if [ -n "$TARGET_RELEASE" ]; then
    [ "$release" = "$TARGET_RELEASE" ] && { TARGET_JSON="$entry"; break; }
  elif [ "$td" != "$CURRENT_TD" ]; then
    TARGET_JSON="$entry"; break
  fi
done

if [ -z "$TARGET_JSON" ]; then
  echo "戻す先の履歴が見つかりません。" >&2
  exit 1
fi

RELEASE="$(jq -r .release <<<"$TARGET_JSON")"
API_TD="$(jq -r .apiTaskDefinition <<<"$TARGET_JSON")"
IMAGE="$(jq -r .image <<<"$TARGET_JSON")"
log "戻す先: $RELEASE（$IMAGE）"

aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --task-definition "$API_TD" >/dev/null
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"

log "静的ファイルを releases/$RELEASE へ戻す"
aws s3 sync "s3://$WEB_BUCKET/releases/$RELEASE/" "s3://$WEB_BUCKET/current/" --delete --only-show-errors
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' >/dev/null

log "完了: $RELEASE に戻しました"
