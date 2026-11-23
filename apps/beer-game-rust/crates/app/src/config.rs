//! 設定の読み取り（環境変数）。ECS では、Secrets Manager の値を 1 つの URL に合成して渡せないため、
//! 接続 URL は、`DATABASE_URL`（あればそれを優先。ローカル・試験）か、部品（`DB_HOST`・`DB_USER`・`DB_PASSWORD` ほか）から組み立てる。

/// 追記の競合の自動再試行の上限（`AppSettings::max_attempts`）。
/// 同じストリームへの**同時の書き手**（4 役割 + 進行役 + 共同担当）の数以上にする。競合した書き手は、再試行のたびに、
/// 他の書き手が先に 1 人成功しているので、書き手が `n` 人なら、最大でも `n - 1` 回の再試行で成功する。
/// 3 回では、同じゲームの 4 人が同時に保存すると、上限を超えて 503（`app.retry_exhausted`）になることがあった（B16 の計測）。
pub const MAX_ATTEMPTS: u32 = 6;

/// 同じストリームへの同時の書き手の数（4 役割 + 進行役 + 共同担当）。`MAX_ATTEMPTS` が、これ未満になるとコンパイルが通らない（NF-C2）。
const CONCURRENT_WRITERS: u32 = 6;
const _: () = assert!(MAX_ATTEMPTS >= CONCURRENT_WRITERS);

/// Cookie に `Secure` を付けるか（NF-S2）。`ENVIRONMENT` が無い・`local` のときだけ付けない（手元の HTTP で動くように）。
/// staging・production は、CloudFront（HTTPS）が前に立つので、ALB までの区間が HTTP でも、ブラウザには `Secure` の Cookie を返す。
#[must_use]
pub fn secure_cookies(get: impl Fn(&str) -> Option<String>) -> bool {
    get("ENVIRONMENT")
        .filter(|v| !v.is_empty())
        .is_some_and(|v| v != "local")
}

/// 接続 URL。`get` は環境変数の引き方（試験が差し替える）。
/// 部品から組み立てるとき: `DB_HOST` と `DB_USER` と `DB_PASSWORD` が要る。`DB_PORT`（既定 5432）、`DB_NAME`（既定 postgres）、
/// `DB_SSLMODE`（既定 require。RDS は SSL 必須）。ユーザー名・パスワードは、URL に入れられるようにパーセント符号化する。
#[must_use]
pub fn database_url(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    let present = |key: &str| get(key).filter(|v| !v.is_empty());
    if let Some(url) = present("DATABASE_URL") {
        return Some(url);
    }
    let host = present("DB_HOST")?;
    let user = present("DB_USER")?;
    let password = present("DB_PASSWORD")?;
    let port = present("DB_PORT").unwrap_or_else(|| "5432".to_owned());
    let name = present("DB_NAME").unwrap_or_else(|| "postgres".to_owned());
    let sslmode = present("DB_SSLMODE").unwrap_or_else(|| "require".to_owned());
    Some(format!(
        "postgres://{}:{}@{host}:{port}/{name}?sslmode={sslmode}",
        percent_encode(&user),
        percent_encode(&password)
    ))
}

/// URL のユーザー情報に入れられるよう、予約文字をパーセント符号化する（英数字と `-._~` はそのまま）。
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn nf_s2__staging_と_production_は_Cookie_に_Secure_を付ける() {
        assert!(secure_cookies(env(&[("ENVIRONMENT", "staging")])));
        assert!(secure_cookies(env(&[("ENVIRONMENT", "production")])));
    }

    #[test]
    fn nf_s2__ENVIRONMENT_が_local_か_未設定なら_手元の_HTTP_のため_Secure_を付けない() {
        assert!(!secure_cookies(env(&[("ENVIRONMENT", "local")])));
        assert!(!secure_cookies(env(&[])));
        assert!(!secure_cookies(env(&[("ENVIRONMENT", "")])));
    }

    #[test]
    fn nf_s2__知らない環境の名前は_安全側で_Secure_を付ける() {
        assert!(secure_cookies(env(&[("ENVIRONMENT", "preview")])));
    }

    #[test]
    fn nf_o11__DATABASE_URL_があれば_それをそのまま使う() {
        let url = database_url(env(&[
            ("DATABASE_URL", "postgres://u:p@h:5432/d"),
            ("DB_HOST", "ignored"),
        ]));
        assert_eq!(url.as_deref(), Some("postgres://u:p@h:5432/d"));
    }

    #[test]
    fn nf_o11__部品から組み立てる_既定は_5432_postgres_sslmode_require() {
        let url = database_url(env(&[
            ("DB_HOST", "db.example.internal"),
            ("DB_USER", "app"),
            ("DB_PASSWORD", "secret"),
        ]));
        assert_eq!(
            url.as_deref(),
            Some("postgres://app:secret@db.example.internal:5432/postgres?sslmode=require")
        );
    }

    #[test]
    fn nf_o11__部品の指定を使い_ユーザーとパスワードは_URL_に入れられるよう符号化する() {
        let url = database_url(env(&[
            ("DB_HOST", "h"),
            ("DB_PORT", "6543"),
            ("DB_NAME", "beergame"),
            ("DB_SSLMODE", "verify-full"),
            ("DB_USER", "a@b"),
            ("DB_PASSWORD", "p:/?#% w"),
        ]));
        assert_eq!(
            url.as_deref(),
            Some("postgres://a%40b:p%3A%2F%3F%23%25%20w@h:6543/beergame?sslmode=verify-full")
        );
    }

    #[test]
    fn nf_o11__ホスト_ユーザー_パスワードのどれかが無ければ_組み立てない() {
        assert_eq!(
            database_url(env(&[("DB_USER", "u"), ("DB_PASSWORD", "p")])),
            None
        );
        assert_eq!(
            database_url(env(&[("DB_HOST", "h"), ("DB_PASSWORD", "p")])),
            None
        );
        assert_eq!(
            database_url(env(&[("DB_HOST", "h"), ("DB_USER", "u")])),
            None
        );
        assert_eq!(database_url(env(&[])), None);
    }

    #[test]
    fn nf_o11__空の_DATABASE_URL_は無いものとして扱う() {
        let url = database_url(env(&[
            ("DATABASE_URL", ""),
            ("DB_HOST", "h"),
            ("DB_USER", "u"),
            ("DB_PASSWORD", "p"),
        ]));
        assert!(url.is_some_and(|u| u.contains("@h:5432")));
    }
}
