#!/usr/bin/env bash
# 復元の訓練（AC6.2.5）: RDS を時点復旧で新しいインスタンスへ復元し、使えるようになるまでの時間を測る。
# 本番のインスタンスには触れない（新しいインスタンスを作り、既定では訓練の後に削除する）。
#
# 必須の環境変数: AWS_REGION SOURCE_DB_INSTANCE（復元元の識別子）
# 任意: RESTORE_TIME（ISO 8601。省略すると、復元できる最新の時点）
#       DB_SUBNET_GROUP VPC_SECURITY_GROUP_IDS（カンマ区切り。省略すると、復元元と同じ）
#       KEEP（1 なら、訓練の後に復元したインスタンスを残す）
# 出力: 復元の開始・完了の時刻と、所要の秒数（訓練の記録に転記する）
# 注意: AWS に接続し、費用が発生する。まだ AWS で検証していない。
set -euo pipefail

: "${AWS_REGION:?}" "${SOURCE_DB_INSTANCE:?}"
RESTORE_TIME="${RESTORE_TIME:-}"
KEEP="${KEEP:-0}"
TARGET="${SOURCE_DB_INSTANCE}-drill-$(date -u +%Y%m%d%H%M)"

log() { echo "==> $*"; }

source_json="$(aws rds describe-db-instances --db-instance-identifier "$SOURCE_DB_INSTANCE" \
  --query 'DBInstances[0]' --output json)"
SUBNET_GROUP="${DB_SUBNET_GROUP:-$(jq -r .DBSubnetGroup.DBSubnetGroupName <<<"$source_json")}"
SECURITY_GROUPS="${VPC_SECURITY_GROUP_IDS:-$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(",")' <<<"$source_json")}"

if [ -n "$RESTORE_TIME" ]; then
  time_args=(--restore-time "$RESTORE_TIME")
else
  time_args=(--use-latest-restorable-time)
fi

started="$(date -u +%s)"
log "復元を開始: $SOURCE_DB_INSTANCE → $TARGET（$([ -n "$RESTORE_TIME" ] && echo "$RESTORE_TIME" || echo 最新の時点)）"
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SOURCE_DB_INSTANCE" \
  --target-db-instance-identifier "$TARGET" \
  "${time_args[@]}" \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "${SECURITY_GROUPS//,/ }" \
  --no-multi-az --no-publicly-accessible --deletion-protection false >/dev/null

aws rds wait db-instance-available --db-instance-identifier "$TARGET"
finished="$(date -u +%s)"
elapsed=$((finished - started))
endpoint="$(aws rds describe-db-instances --db-instance-identifier "$TARGET" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"

log "復元が完了: ${elapsed} 秒（エンドポイント: $endpoint）"
echo "drill_target=$TARGET"
echo "drill_started_at=$(date -u -r "$started" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ)"
echo "drill_elapsed_seconds=$elapsed"
echo "次の確認（人が行う）: 復元先で保持の定期タスクを実行し、削除済みのゲームが残らないこと、最後の確定済みの週が残っていること（RPO）を確かめる"

if [ "$KEEP" != "1" ]; then
  log "訓練のインスタンスを削除"
  aws rds delete-db-instance --db-instance-identifier "$TARGET" \
    --skip-final-snapshot --delete-automated-backups >/dev/null
fi
