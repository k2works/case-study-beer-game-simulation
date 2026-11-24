//! 冪等性。同じ `Idempotency-Key` の再送は、保存した**成功の応答**をそのまま返す（業務の失敗は保存せず、再計算して同じ失敗を返す）。
//! 記録の照合は、追記と同じトランザクションの中で、読み込みの前に行う（認証・認可の後。順序の固定は設計: RB3）。
//! 保存するのは、秘密を含まない応答（`versions` だけ）に限る。資格を運ぶ応答（作成・参加）は対象外（暗号化の承認待ち）。

use beergame_domain::{GameId, Instant};

/// 応答の形。`versions` のどのストリームに、追記後の版を入れるか。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseShape {
    Game,
    Session,
    /// 開始（2 本のストリームへ追記）。`body_both` を使う。
    Both,
}

impl ResponseShape {
    /// `{"versions":{"game":<v>,"session":null}}` のような本文。
    #[must_use]
    pub fn body(self, version: u64) -> Vec<u8> {
        match self {
            ResponseShape::Both => String::new(),
            ResponseShape::Game => format!(r#"{{"versions":{{"game":{version},"session":null}}}}"#),
            ResponseShape::Session => {
                format!(r#"{{"versions":{{"game":null,"session":{version}}}}}"#)
            }
        }
        .into_bytes()
    }
}

impl ResponseShape {
    /// 開始の本文（両方の版）。
    #[must_use]
    pub fn body_both(game: u64, session: u64) -> Vec<u8> {
        format!(r#"{{"versions":{{"game":{game},"session":{session}}}}}"#).into_bytes()
    }
}

/// 要求ごとの冪等性の情報。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Idempotency {
    pub game_id: GameId,
    /// 操作の種類（例: `assign_role`）。
    pub scope: String,
    /// `Idempotency-Key` の鍵付きダイジェスト（生のキーは保存しない）。
    pub key_digest: String,
    /// 要求の内容（経路と本文）の鍵付きダイジェスト。同じキーで内容が違えば `IdempotencyKeyReused`。
    pub request_digest: String,
    pub shape: ResponseShape,
    pub expires_at: Instant,
}

/// 保存済みの応答。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredResponse {
    pub request_digest: String,
    pub status_code: u16,
    pub body: Vec<u8>,
}

/// コマンドの実行結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Executed {
    /// 実行した。追記後の版。
    Fresh(u64),
    /// 同じキー・同じ内容の再送。保存した応答を返す（実行しない）。
    Replayed(StoredResponse),
}
