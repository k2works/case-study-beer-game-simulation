//! 秘密を含む応答（作成・参加・再発行）の冪等記録。応答の中身（復帰コードなど）を **AES-256-GCM で暗号化して保存**し、
//! 同じ `Idempotency-Key` の再送には、復号した同じ値を返す。保存するのは、版と、応答に載せた 2 つの値だけ（本文は HTTP が組み立てる）。

use beergame_domain::{GameId, Instant};

use crate::{AppFailure, AppSettings, Env, PeripheralWrite, Secret, StoredResponse, open, seal};

/// 暗号化して保存する冪等記録の宛先。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedIdempotency {
    /// 操作の種類（`create`・`join`・`reissue_credential`）。
    pub scope: String,
    /// `Idempotency-Key` の鍵付きダイジェスト。
    pub key_digest: String,
    /// 要求の内容の鍵付きダイジェスト。同じキーで内容が違えば `IdempotencyKeyReused`。
    pub request_digest: String,
}

/// 保存した応答の中身。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedFields {
    pub game_version: u64,
    pub first: Secret<String>,
    pub second: Secret<String>,
}

/// 暗号化した冪等記録の書き込みを作る。鍵が使えなければ `None`（記録しない）。
#[must_use]
pub fn sealed_write(
    env: &impl Env,
    settings: &AppSettings,
    game_id: GameId,
    idem: &SealedIdempotency,
    status_code: u16,
    fields: &SealedFields,
    now: Instant,
) -> Option<PeripheralWrite> {
    let plain = format!(
        "1|{}|{}|{}",
        fields.game_version,
        fields.first.expose(),
        fields.second.expose()
    );
    let response = seal(
        &settings.credential_key,
        &env.token_bytes(),
        plain.as_bytes(),
    )?;
    Some(PeripheralWrite::Idempotency {
        game_id,
        scope: idem.scope.clone(),
        key_digest: idem.key_digest.clone(),
        request_digest: idem.request_digest.clone(),
        status_code,
        response,
        expires_at: Instant::from_epoch_millis(now.epoch_millis().saturating_add(86_400_000)),
    })
}

/// 保存した応答を、再送に返す値にする。要求の内容が違えば `IdempotencyKeyReused`。復号できなければ、記録の破損として失敗。
///
/// # Errors
/// 内容の違い（`IdempotencyKeyReused`）、復号の失敗（`Persistence`）。
pub fn open_sealed(
    settings: &AppSettings,
    request_digest: &str,
    stored: &StoredResponse,
) -> Result<SealedFields, AppFailure> {
    if stored.request_digest != request_digest {
        return Err(AppFailure::IdempotencyKeyReused);
    }
    let broken = || {
        AppFailure::Persistence(crate::PersistenceFailure::Storage(
            "冪等記録を復号できない".to_owned(),
        ))
    };
    // 現在の鍵、旧版の鍵の順に試す（鍵を更新した後の再送）
    let plain = settings
        .keys()
        .find_map(|(_, key)| open(key, &stored.body))
        .ok_or_else(broken)?;
    let text = String::from_utf8(plain).map_err(|_| broken())?;
    let mut parts = text.splitn(4, '|');
    let (Some("1"), Some(version), Some(first), Some(second)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(broken());
    };
    Ok(SealedFields {
        game_version: version.parse().map_err(|_| broken())?,
        first: Secret::new(first.to_owned()),
        second: Secret::new(second.to_owned()),
    })
}
