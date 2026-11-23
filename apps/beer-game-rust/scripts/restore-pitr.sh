#!/usr/bin/env bash
# RDS の時点復旧（PITR）またはスナップショットから、新しいインスタンスへ復元する手順（B15。AC6.2.5、NF-R4）。
# **約束の範囲**: RPO 0（確定済みの週）と RTO 15 分は Multi-AZ のフェイルオーバーに対する約束。PITR は、破損・誤操作向けの手順で、
# RPO は数分（復元できる最新時刻が遅れる）、RTO は実測してから約束する（運用手順書 restore.md）。
#
# 既定は**ドライラン**: 実行するコマンドを表示するだけで、AWS には何もしない（AWS の認証も要らない）。
# --execute を付けたときだけ、復元（新しいインスタンスの作成）と、その完了待ちを行う。
# 切り替え（名前の付け替え、api の停止と再開）と、復元後の確認（retention・verify-projections）は、
# **人の判断が要る**ので、このスクリプトは実行せず、手順として表示するだけにする。
#
# 使い方:
#   scripts/restore-pitr.sh --instance <元のインスタンス> --new-instance <復元先の名前> (--target-time <UTC の時刻> | --latest | --snapshot <ID>) [--execute]
# 例（ドライラン）:
#   scripts/restore-pitr.sh --instance beer-game-rust-production --new-instance beer-game-rust-production-restore \
#     --target-time 2026-12-01T10:00:00Z
#
# 設計: docs/design/beer-game-rust/operation.md、運用手順書 docs/operation/beer-game-rust/restore.md。
# 状態: AWS では実行していない（未確認）。ドライランの出力だけを、app の tests/production_definition.rs が検査する。
set -euo pipefail

usage() {
  sed -n '2,15p' "$0" >&2
  exit 2
}

INSTANCE=""
NEW_INSTANCE=""
TARGET_TIME=""
SNAPSHOT=""
LATEST="false"
EXECUTE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --new-instance) NEW_INSTANCE="${2:-}"; shift 2 ;;
    --target-time) TARGET_TIME="${2:-}"; shift 2 ;;
    --snapshot) SNAPSHOT="${2:-}"; shift 2 ;;
    --latest) LATEST="true"; shift ;;
    --execute) EXECUTE="true"; shift ;;
    -h | --help) usage ;;
    *) echo "不明な引数: $1" >&2; usage ;;
  esac
done

[ -n "$INSTANCE" ] || { echo "--instance が要ります" >&2; usage; }
[ -n "$NEW_INSTANCE" ] || { echo "--new-instance が要ります" >&2; usage; }
[ "$NEW_INSTANCE" != "$INSTANCE" ] || { echo "復元先は、元のインスタンスと別の名前にします（元を残して比べるため）" >&2; exit 2; }

modes=0
[ -z "$TARGET_TIME" ] || modes=$((modes + 1))
[ -z "$SNAPSHOT" ] || modes=$((modes + 1))
[ "$LATEST" = "false" ] || modes=$((modes + 1))
[ "$modes" -eq 1 ] || { echo "--target-time、--latest、--snapshot のどれか 1 つだけを指定します" >&2; usage; }

if [ -n "$TARGET_TIME" ]; then
  [[ "$TARGET_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || { echo "--target-time は UTC の ISO 8601（例: 2026-12-01T10:00:00Z）" >&2; exit 2; }
fi

# 復元先は、元と同じ設定（サブネットグループ、セキュリティグループ、パラメータグループ、クラス、Multi-AZ）にする。
# ドライランでは AWS に問い合わせないので、プレースホルダーで表示する。--execute では、元のインスタンスから読み取る。
SUBNET_GROUP="<元と同じ>"
SECURITY_GROUPS="<元と同じ>"
PARAMETER_GROUP="<元と同じ>"
INSTANCE_CLASS="<元と同じ>"

if [ "$EXECUTE" = "true" ]; then
  read -r SUBNET_GROUP SECURITY_GROUPS PARAMETER_GROUP INSTANCE_CLASS < <(
    aws rds describe-db-instances --db-instance-identifier "$INSTANCE" --query \
      'DBInstances[0].[DBSubnetGroup.DBSubnetGroupName, join(`,`, VpcSecurityGroups[].VpcSecurityGroupId), DBParameterGroups[0].DBParameterGroupName, DBInstanceClass]' \
      --output text
  )
fi

if [ -n "$SNAPSHOT" ]; then
  RESTORE=(aws rds restore-db-instance-from-db-snapshot
    --db-snapshot-identifier "$SNAPSHOT")
elif [ "$LATEST" = "true" ]; then
  RESTORE=(aws rds restore-db-instance-to-point-in-time
    --source-db-instance-identifier "$INSTANCE" --use-latest-restorable-time)
else
  RESTORE=(aws rds restore-db-instance-to-point-in-time
    --source-db-instance-identifier "$INSTANCE" --restore-time "$TARGET_TIME")
fi
RESTORE+=(--db-instance-identifier "$NEW_INSTANCE"
  --db-subnet-group-name "$SUBNET_GROUP"
  --vpc-security-group-ids "$SECURITY_GROUPS"
  --db-parameter-group-name "$PARAMETER_GROUP"
  --db-instance-class "$INSTANCE_CLASS"
  --no-publicly-accessible --copy-tags-to-snapshot)

echo "== 1. 新しいインスタンスへ復元する（元の $INSTANCE は残す）"
echo "${RESTORE[*]}"
echo "aws rds wait db-instance-available --db-instance-identifier $NEW_INSTANCE"

if [ "$EXECUTE" = "true" ]; then
  START="$(date +%s)"
  "${RESTORE[@]}" >/dev/null
  aws rds wait db-instance-available --db-instance-identifier "$NEW_INSTANCE"
  echo "復元が完了しました（所要 $(($(date +%s) - START)) 秒）。この時間を、復元の訓練の記録（RTO の実測）に書く"
else
  echo "（ドライラン: 実行していません。実行するときは --execute）"
fi

cat <<EOF

== 2. 切り替える（人が判断する。このスクリプトは実行しない）
  a. api の台数を 0 にして、書き込みを止める（研修中なら、運営者を通じて進行役へ連絡する）
     aws ecs update-service --cluster <ECS_CLUSTER> --service api --desired-count 0
     定期の起動も止める: Scheduler の retention・verify-projections を DISABLED にする（Terraform の scheduled_tasks_enabled = false）
  b. 名前を付け替える（エンドポイントは、インスタンスの名前に従うので、アプリの接続先を変えずに済む）
     aws rds modify-db-instance --db-instance-identifier $INSTANCE --new-db-instance-identifier ${INSTANCE}-old --apply-immediately
     aws rds modify-db-instance --db-instance-identifier $NEW_INSTANCE --new-db-instance-identifier $INSTANCE --apply-immediately
     （付け替えると Terraform の状態と食い違う。後で terraform import / state の整理が要る）
  c. api の台数を戻す（最小の台数）。/api/v1/ready が 200 になるまで待つ

== 3. 復元後の確認（必須。復元で、削除済みのゲームが再び現れないようにする）
  a. 保持削除を 1 回実行する（期限切れのゲームを再び削除する）: タスク定義 <retention_task_family> を run-task（モード retention）
  b. 投影の整合を検査する: タスク定義 <verify_projections_task_family> を run-task（モード verify-projections）。不一致なら rebuild-projections
  c. 進行中だったゲームを確認し、運営者へ連絡する（復元の時点より後の操作は失われる）
  d. 元の ${INSTANCE}-old は、確認が済むまで残す。削除は、人が判断する
EOF
