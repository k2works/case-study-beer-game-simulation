//! 秘密の扱い。資格（256 ビットの乱数）は、**生の値を保存せず、鍵付きダイジェスト（HMAC-SHA256）だけを保存する**（ADR-004・016 の引き継ぎ）。
//! 乱数・鍵は外から受け取る（このクレートは、乱数も時計も読まない）。

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

/// 秘密の値。`Debug` では中身を出さない（ログ・テスト出力への漏れを防ぐ）。
#[derive(Clone, PartialEq, Eq)]
pub struct Secret<A>(A);

impl<A> Secret<A> {
    #[must_use]
    pub const fn new(value: A) -> Self {
        Secret(value)
    }

    /// 中身を取り出す。応答に一度だけ載せる・ダイジェストを計算するときだけ使う。
    #[must_use]
    pub const fn expose(&self) -> &A {
        &self.0
    }
}

impl<A> std::fmt::Debug for Secret<A> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// 資格の生の値（256 ビットの乱数を URL 安全な Base64 にした 43 文字）。
#[must_use]
pub fn encode_token(bytes: &[u8; 32]) -> Secret<String> {
    Secret::new(URL_SAFE_NO_PAD.encode(bytes))
}

/// 資格の鍵付きダイジェスト（HMAC-SHA256 を 16 進にした 64 文字）。保存するのはこれだけ。
/// 鍵が空のときは `None`（鍵の未設定を通さない）。
#[must_use]
pub fn digest(key: &Secret<Vec<u8>>, token: &Secret<String>) -> Option<String> {
    // HMAC は空の鍵も受け付けるが、設定の誤り（鍵の未設定）を通さない
    if key.expose().is_empty() {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key.expose()).ok()?;
    mac.update(token.expose().as_bytes());
    let bytes = mac.finalize().into_bytes();
    Some(bytes.iter().fold(String::with_capacity(64), |mut out, b| {
        out.push_str(&format!("{b:02x}"));
        out
    }))
}
