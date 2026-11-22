//! 冪等記録の応答の暗号化（AES-256-GCM）。保存する応答には、資格（復帰コード・セッション）が含まれうるため、暗号化して保存する。
//! 鍵は、資格のダイジェストの鍵（`CREDENTIAL_KEY`）から、用途を分けて導く。ノンスは呼び出し側が渡す（このクレートは乱数を読まない）。

use aes_gcm::aead::{Aead, Nonce};
use aes_gcm::{Aes256Gcm, KeyInit};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::Secret;

const NONCE_LEN: usize = 12;

/// 暗号化の鍵（32 バイト）。`CREDENTIAL_KEY` から HMAC-SHA256 で導く（用途の文字列で、ダイジェストの鍵と分ける）。
fn derive(key: &Secret<Vec<u8>>) -> Option<Aes256Gcm> {
    if key.expose().is_empty() {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key.expose()).ok()?;
    mac.update(b"beergame:idempotency-response-encryption:v1");
    let derived = mac.finalize().into_bytes();
    Aes256Gcm::new_from_slice(derived.as_slice()).ok()
}

/// 暗号化する。出力は `ノンス(12 バイト) || 暗号文 || 認証タグ`。鍵が空なら `None`。
#[must_use]
pub fn seal(key: &Secret<Vec<u8>>, nonce_bytes: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = derive(key)?;
    let nonce_part = nonce_bytes.get(..NONCE_LEN)?;
    let nonce = Nonce::<Aes256Gcm>::try_from(nonce_part).ok()?;
    let encrypted = cipher.encrypt(&nonce, plaintext).ok()?;
    let mut out = nonce_part.to_vec();
    out.extend(encrypted);
    Some(out)
}

/// 復号する。鍵が違う・改ざん・短すぎる入力は `None`。
#[must_use]
pub fn open(key: &Secret<Vec<u8>>, sealed: &[u8]) -> Option<Vec<u8>> {
    let cipher = derive(key)?;
    let (nonce_part, encrypted) = sealed.split_at_checked(NONCE_LEN)?;
    let nonce = Nonce::<Aes256Gcm>::try_from(nonce_part).ok()?;
    cipher.decrypt(&nonce, encrypted).ok()
}
