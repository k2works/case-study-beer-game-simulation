# PostgreSQL 18。暗号化、PITR（自動バックアップ 7 日）、プライベートサブネット。接続は SSL 必須。
# マスターユーザーは「所有者」（マイグレーションの接続のユーザー）。用途別のロール
# （beergame_writer / reader / observer / deleter）は NOLOGIN で、マイグレーション V101 が作る。
# ログイン用のロールの分離は B3 では定義しない（設計書の未決事項。bolt_3_plan.md Step 2 の結果を参照）。
resource "random_password" "master" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "RDS: API とマイグレーションのタスクからのみ"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "from_tasks" {
  type                     = "ingress"
  security_group_id        = aws_security_group.db.id
  source_security_group_id = var.task_security_group_id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}

resource "aws_db_parameter_group" "this" {
  name   = var.name
  family = "postgres${var.engine_major}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_major
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.master_username
  password = random_password.master.result

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  # バックアップ（B14）: 自動バックアップ 7 日（時点復旧。削除したゲームのデータも、最大 7 日バックアップに残る。data-model.md）。
  # 時間帯は、研修のない時間（UTC 17:00 = 日本時間 02:00。日次の整合の検査 UTC 18:00 の前）。
  # インスタンスを消しても自動バックアップを残すのは、削除保護のあるとき（本番）だけ
  backup_retention_period    = 7
  backup_window              = var.backup_window
  copy_tags_to_snapshot      = true
  delete_automated_backups   = !var.deletion_protection
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = var.skip_final_snapshot
  final_snapshot_identifier  = var.skip_final_snapshot ? null : "${var.name}-final"
  auto_minor_version_upgrade = true
  apply_immediately          = false
}
