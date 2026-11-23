// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 本番の定義の検査（B15。AC6.2.*、NF-O11、NF-S9、NF-R3・R4）。ワークフロー・Terraform・復元スクリプト・運用手順書を読んで、
//! 期待と突き合わせる。**ここは「定義がある」ことの検査で、AWS 上で動くことの確認ではない**（適用していない）。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

/// リポジトリのルート（`crates/app` から見て 4 つ上）。
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn read(relative: &str) -> Result<String, String> {
    std::fs::read_to_string(root().join(relative)).map_err(|e| format!("{relative}: {e}"))
}

fn workflow(name: &str) -> Result<(String, Value), String> {
    let text = read(&format!(".github/workflows/beer-game-rust-{name}.yml"))?;
    let value = serde_saphyr::from_str::<Value>(&text).map_err(|e| format!("{name}: {e}"))?;
    Ok((text, value))
}

/// `on` は YAML では真偽値に読まれることがあるため、両方で引く。
fn triggers(value: &Value) -> Vec<String> {
    value
        .get("on")
        .or_else(|| value.get("true"))
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

fn environment_of(value: &Value) -> Option<String> {
    value
        .pointer("/jobs")
        .and_then(Value::as_object)?
        .values()
        .find_map(|job| job.get("environment").and_then(Value::as_str))
        .map(str::to_owned)
}

// ---- ワークフロー ----

#[test]
fn ac6_2_1__ステージングのデプロイは_main_の_CI_の成功後に_変数が_true_のときだけ自動で動く()
-> Result<(), String> {
    let (text, value) = workflow("deploy-staging")?;
    let on = triggers(&value);
    assert!(
        on.contains(&"workflow_run".to_owned()) && on.contains(&"workflow_dispatch".to_owned()),
        "{on:?}"
    );
    assert_eq!(
        value.pointer("/on/workflow_run/workflows"),
        Some(&serde_json::json!(["beer-game-rust"]))
    );
    assert!(text.contains("vars.BEER_GAME_RUST_AUTO_DEPLOY == 'true'"));
    assert_eq!(environment_of(&value).as_deref(), Some("staging"));
    Ok(())
}

#[test]
fn ac6_2_2__本番のデプロイは_手動の起動だけで_環境の承認を経る() -> Result<(), String> {
    let (text, value) = workflow("deploy-production")?;
    assert_eq!(triggers(&value), vec!["workflow_dispatch".to_owned()]);
    assert_eq!(environment_of(&value).as_deref(), Some("production"));
    assert!(!text.contains("workflow_run"), "本番は自動にしない");
    Ok(())
}

#[test]
fn ac6_2_2__本番のデプロイは_マイグレーションの前に復元点のスナップショットを取り_古いものを消す()
-> Result<(), String> {
    let (text, _) = workflow("deploy-production")?;
    assert!(text.contains("create-db-snapshot") && text.contains("-pre-"));
    assert!(
        text.contains("delete-db-snapshot"),
        "7 日より古い復元点を消す（NF-S16）"
    );
    let snapshot = text
        .find("create-db-snapshot")
        .ok_or("スナップショットが無い")?;
    let migrate = text
        .find("マイグレーション（migrate タスク）")
        .ok_or("migrate が無い")?;
    assert!(
        snapshot < migrate,
        "スナップショットは、マイグレーションの前"
    );
    Ok(())
}

#[test]
fn nf_o11__デプロイは_4_つのタスク定義を同じイメージへそろえる() -> Result<(), String> {
    for name in ["deploy-staging", "deploy-production"] {
        let (text, _) = workflow(name)?;
        for family in [
            "API_TASK_FAMILY",
            "MIGRATE_TASK_FAMILY",
            "RETENTION_TASK_FAMILY",
            "VERIFY_TASK_FAMILY",
        ] {
            assert!(
                text.contains(&format!("register \"${family}\"")),
                "{name}: {family} を登録していない"
            );
        }
    }
    Ok(())
}

#[test]
fn nf_o11__ステージングも本番も_直前の版へ戻す手段を持つ() -> Result<(), String> {
    let (_, staging) = workflow("rollback-staging")?;
    let (_, production) = workflow("rollback-production")?;
    assert_eq!(triggers(&staging), vec!["workflow_dispatch".to_owned()]);
    assert_eq!(triggers(&production), vec!["workflow_dispatch".to_owned()]);
    assert_eq!(environment_of(&staging).as_deref(), Some("staging"));
    assert_eq!(environment_of(&production).as_deref(), Some("production"));
    Ok(())
}

#[test]
fn nf_o11__ワークフローは_長期のアクセスキーを使わず_OIDC_で_AWS_を引き受ける() -> Result<(), String>
{
    for name in [
        "deploy-staging",
        "deploy-production",
        "rollback-staging",
        "rollback-production",
    ] {
        let (text, value) = workflow(name)?;
        assert_eq!(
            value
                .pointer("/permissions/id-token")
                .and_then(Value::as_str),
            Some("write"),
            "{name}"
        );
        assert!(
            !text.contains("AWS_ACCESS_KEY_ID") && !text.contains("AWS_SECRET_ACCESS_KEY"),
            "{name}"
        );
        assert!(text.contains("role-to-assume"), "{name}");
    }
    Ok(())
}

#[test]
fn nf_o11__ワークフローに_他のプロジェクトの名前が残っていない() -> Result<(), String> {
    for name in [
        "deploy-staging",
        "deploy-production",
        "rollback-staging",
        "rollback-production",
    ] {
        let (text, _) = workflow(name)?;
        // 画面（web/）は Kotlin 版と共有するので、その経路だけは許す
        let leftover: Vec<&str> = text
            .lines()
            .filter(|l| {
                l.to_lowercase().contains("kotlin")
                    && !l.contains("apps/beer-game-kotlin/web")
                    && !l.contains("Kotlin 版と共有")
            })
            .collect();
        assert!(leftover.is_empty(), "{name}: {leftover:?}");
    }
    Ok(())
}

// ---- Terraform ----

/// `locals { environment = [...]  secrets = [...] }` の、環境変数・秘密の名前（`name = "X"`）。
fn task_variables(ecs: &str, block: &str) -> Vec<String> {
    let start = ecs.find(&format!("{block} = [")).unwrap_or(0);
    let body = ecs.get(start..).unwrap_or_default();
    let end = body.find("\n  ]").unwrap_or(body.len());
    body.get(..end)
        .unwrap_or_default()
        .split("name = \"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next().map(str::to_owned))
        .collect()
}

#[test]
fn nf_o11__タスク定義は_アプリが読む環境変数と秘密を渡し_他のプロジェクトの変数は渡さない()
-> Result<(), String> {
    let ecs = read("apps/beer-game-rust/infra/modules/ecs/main.tf")?;
    let environment = task_variables(&ecs, "environment");
    let secrets = task_variables(&ecs, "secrets");
    // アプリ（`crates/app`）が読むもの: 接続 URL の部品、環境の名前（メトリクスの Environment）、ポート、資格の鍵
    for name in ["ENVIRONMENT", "DB_HOST", "DB_PORT", "DB_NAME", "PORT"] {
        assert!(
            environment.contains(&name.to_owned()),
            "環境変数 {name} が無い: {environment:?}"
        );
    }
    for name in ["DB_USER", "DB_PASSWORD", "CREDENTIAL_KEY"] {
        assert!(
            secrets.contains(&name.to_owned()),
            "秘密 {name} が無い: {secrets:?}"
        );
    }
    // Kotlin 版の設定（Rust のアプリは読まない）を持ち込まない
    for legacy in [
        "APP_ENV",
        "DB_KIND",
        "DB_URL",
        "MIGRATE_ON_START",
        "HOST",
        "ALLOWED_ORIGINS",
    ] {
        assert!(
            !environment.contains(&legacy.to_owned()),
            "不要な環境変数 {legacy} が残っている"
        );
    }
    for legacy in ["IDEMPOTENCY_KEY", "RESPONSE_KEY"] {
        assert!(
            !secrets.contains(&legacy.to_owned()),
            "不要な秘密 {legacy} が残っている"
        );
    }
    Ok(())
}

#[test]
fn nf_s9__本番は_独自ドメインとブルー_グリーンと_Multi_AZ_と削除保護を持ち_ステージングはローリング()
-> Result<(), String> {
    let production = read("apps/beer-game-rust/infra/envs/production/main.tf")?;
    assert!(production.contains("module \"domain\""));
    assert!(production.contains("deployment_strategy          = \"BLUE_GREEN\""));
    assert!(
        production.contains("multi_az            = true")
            && production.contains("deletion_protection = true")
    );
    let staging = read("apps/beer-game-rust/infra/envs/staging/main.tf")?;
    assert!(!staging.contains("BLUE_GREEN"), "ステージングはローリング");
    Ok(())
}

#[test]
fn nf_s9__CloudFront_は_TLS_1_2_以上を要求し_セキュリティヘッダーを付ける() -> Result<(), String> {
    let web = read("apps/beer-game-rust/infra/modules/web/main.tf")?;
    assert!(web.contains("TLSv1.2_2021"));
    for header in [
        "Permissions-Policy",
        "strict_transport_security",
        "content_security_policy",
    ] {
        assert!(
            web.contains(header) || web.to_lowercase().contains(&header.to_lowercase()),
            "{header}"
        );
    }
    Ok(())
}

#[test]
fn nf_o3__定期タスクは_retention_が_5_分ごと_検査が日次で_失敗を再試行しない() -> Result<(), String>
{
    let variables = read("apps/beer-game-rust/infra/modules/ecs/variables.tf")?;
    assert!(
        variables.contains("rate(5 minutes)"),
        "retention は 5 分ごと"
    );
    assert!(
        variables.contains("cron(0 18 * * ? *)"),
        "検査は日次（UTC 18:00 = 日本時間 03:00）"
    );
    let ecs = read("apps/beer-game-rust/infra/modules/ecs/main.tf")?;
    assert!(
        ecs.contains("maximum_retry_attempts       = 0"),
        "同じ起動を重ねて再試行しない"
    );
    Ok(())
}

#[test]
fn nf_o3__タスク定義は_メトリクスの環境の名前_ENVIRONMENT_を持つ() -> Result<(), String> {
    let ecs = read("apps/beer-game-rust/infra/modules/ecs/main.tf")?;
    assert!(
        ecs.contains("\"ENVIRONMENT\"") || ecs.contains("name  = \"ENVIRONMENT\""),
        "ENVIRONMENT が無い"
    );
    Ok(())
}

// ---- 復元と N-1 ----

fn script(name: &str, args: &[&str]) -> Result<(bool, String), String> {
    let path = root().join("apps/beer-game-rust/scripts").join(name);
    let output = Command::new("bash")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("{name}: {e}"))?;
    Ok((
        output.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    ))
}

#[test]
fn ac6_2_5__復元スクリプトは_既定ではドライランで_実行するコマンドを示すだけ() -> Result<(), String>
{
    let (ok, out) = script(
        "restore-pitr.sh",
        &[
            "--instance",
            "beer-game-rust-production",
            "--new-instance",
            "beer-game-rust-production-restore",
            "--target-time",
            "2026-12-01T10:00:00Z",
        ],
    )?;
    assert!(ok, "{out}");
    assert!(
        out.contains("restore-db-instance-to-point-in-time"),
        "{out}"
    );
    assert!(out.contains("ドライラン"), "{out}");
    assert!(
        out.contains("切り替え") && out.contains("verify-projections"),
        "切り替えと復元後の検査は人の手順: {out}"
    );
    Ok(())
}

#[test]
fn ac6_2_5__復元スクリプトは_引数が足りなければ失敗し_何も実行しない() -> Result<(), String> {
    let (ok, _) = script("restore-pitr.sh", &["--instance", "x"])?;
    assert!(!ok);
    Ok(())
}

#[test]
fn ac6_2_5__復元スクリプトは_時刻の指定が無ければ拒む() -> Result<(), String> {
    let (ok, out) = script(
        "restore-pitr.sh",
        &["--instance", "a", "--new-instance", "b"],
    )?;
    assert!(!ok, "{out}");
    Ok(())
}

#[test]
fn nf_o11__N_1_互換の確認スクリプトがある() -> Result<(), String> {
    let text = read("apps/beer-game-rust/scripts/n1-compat.sh")?;
    assert!(text.contains("schema_version") || text.contains("N-1"));
    assert!(text.starts_with("#!/usr/bin/env bash"));
    Ok(())
}

// ---- 運用手順書 ----

fn runbook(name: &str) -> Result<String, String> {
    read(&format!("docs/operation/beer-game-rust/{name}.md"))
}

#[test]
fn ac6_2_5__復元の手順書は_RPO_RTO_の約束を障害の種類ごとに区別して書く() -> Result<(), String> {
    let text = runbook("restore")?;
    // 承認した区別: RPO 0・RTO 15 分は Multi-AZ のフェイルオーバー。PITR は破損・誤操作向けで RPO は数分、RTO は実測後
    for needle in [
        "Multi-AZ",
        "PITR",
        "RPO 0",
        "RTO 15 分",
        "数分",
        "実測",
        "verify-projections",
        "再構築では",
    ] {
        assert!(text.contains(needle), "restore.md に「{needle}」が無い");
    }
    Ok(())
}

#[test]
fn nf_o11__運用手順書は_本番の適用前の確認_デプロイ_戻し_観測を持つ() -> Result<(), String> {
    for (name, needles) in [
        (
            "production",
            vec![
                "適用前の確認",
                "ブルー/グリーン",
                "ENVIRONMENT",
                "retention",
                "verify-projections",
            ],
        ),
        ("deploy", vec!["BEER_GAME_RUST_AUTO_DEPLOY", "ダイジェスト"]),
        ("rollback", vec!["マイグレーションは戻さない"]),
        (
            "observability",
            vec!["main-operation-stall", "projection-mismatch"],
        ),
    ] {
        let text = runbook(name)?;
        for needle in needles {
            assert!(text.contains(needle), "{name}.md に「{needle}」が無い");
        }
    }
    Ok(())
}

#[test]
fn nf_o11__運用の索引は_作った手順書を載せている() -> Result<(), String> {
    let index = runbook("index")?;
    for name in [
        "production.md",
        "restore.md",
        "deploy.md",
        "rollback.md",
        "observability.md",
    ] {
        assert!(index.contains(name), "索引に {name} が無い");
    }
    Ok(())
}
