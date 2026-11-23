#!/usr/bin/env bash
# アプリのデプロイ（イメージのダイジェスト固定 + 静的ファイルの版）。インフラ（Terraform）は変えない。
#
# 必須の環境変数:
#   AWS_REGION ECS_CLUSTER ECS_SERVICE API_TASK_FAMILY MIGRATE_TASK_FAMILY
#   WEB_BUCKET DISTRIBUTION_ID TASK_SUBNETS（カンマ区切り） TASK_SG
#   IMAGE（<ECR の URL>@sha256:...）  RELEASE_ID（コミット SHA）
# 任意: WEB_DIR（既定 dist/ui）
#
# 順序: タスク定義の登録 → マイグレーション（失敗したら中止）→ ローリング更新 → 静的ファイルの公開 → 履歴の記録
# 注意: AWS に接続するため、パイプライン（OIDC）から実行する。まだ AWS で検証していない。
set -euo pipefail

: "${AWS_REGION:?}" "${ECS_CLUSTER:?}" "${ECS_SERVICE:?}" "${API_TASK_FAMILY:?}" "${MIGRATE_TASK_FAMILY:?}"
: "${WEB_BUCKET:?}" "${DISTRIBUTION_ID:?}" "${TASK_SUBNETS:?}" "${TASK_SG:?}" "${IMAGE:?}" "${RELEASE_ID:?}"
WEB_DIR="${WEB_DIR:-dist/ui}"

log() { echo "==> $*"; }

# 現在のタスク定義を元に、イメージだけを差し替えた新しい版を登録して、ARN を返す
register_with_image() {
  local family="$1" tmp
  tmp="$(mktemp)"
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json \
    | jq --arg image "$IMAGE" '
        del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)
        | .containerDefinitions[0].image = $image' > "$tmp"
  aws ecs register-task-definition --cli-input-json "file://$tmp" \
    --query taskDefinition.taskDefinitionArn --output text
}

log "タスク定義を登録（イメージ: $IMAGE）"
API_TD="$(register_with_image "$API_TASK_FAMILY")"
MIGRATE_TD="$(register_with_image "$MIGRATE_TASK_FAMILY")"

log "マイグレーションを 1 回限りのタスクとして実行"
TASK_ARN="$(aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE --task-definition "$MIGRATE_TD" \
  --network-configuration "awsvpcConfiguration={subnets=[$TASK_SUBNETS],securityGroups=[$TASK_SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$TASK_ARN"
EXIT_CODE="$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [ "$EXIT_CODE" != "0" ]; then
  echo "マイグレーションに失敗しました（exit code: $EXIT_CODE）。デプロイを中止します。ログ: /ecs/*/migrate" >&2
  exit 1
fi

log "API をローリング更新（失敗したら、サーキットブレーカーが直前の版へ戻す）"
aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --task-definition "$API_TD" >/dev/null
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"
ROLLOUT="$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --query "services[0].deployments[?status=='PRIMARY'].rolloutState | [0]" --output text)"
if [ "$ROLLOUT" != "COMPLETED" ]; then
  echo "ローリング更新が完了しませんでした（rolloutState: $ROLLOUT）。静的ファイルは公開しません。" >&2
  exit 1
fi

log "静的ファイルを releases/$RELEASE_ID に置き、current に反映"
aws s3 sync "$WEB_DIR" "s3://$WEB_BUCKET/releases/$RELEASE_ID/" --delete --only-show-errors
aws s3 sync "s3://$WEB_BUCKET/releases/$RELEASE_ID/" "s3://$WEB_BUCKET/current/" --delete --only-show-errors
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' >/dev/null

log "デプロイの履歴を記録（ロールバックの候補）"
jq -n --arg release "$RELEASE_ID" --arg image "$IMAGE" --arg api "$API_TD" --arg migrate "$MIGRATE_TD" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{release: $release, image: $image, apiTaskDefinition: $api, migrateTaskDefinition: $migrate, deployedAt: $at}' \
  | aws s3 cp - "s3://$WEB_BUCKET/deployments/$(date -u +%Y%m%dT%H%M%SZ)-$RELEASE_ID.json" --only-show-errors

log "完了: $RELEASE_ID"
