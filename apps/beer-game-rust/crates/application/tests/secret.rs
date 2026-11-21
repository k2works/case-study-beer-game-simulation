// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 資格の生成とダイジェスト（NF-S: 生の値を保存しない。AC1.2.1・AC3.2.*）。

use beergame_application::{Secret, digest, encode_token};

fn key(n: u8) -> Secret<Vec<u8>> {
    Secret::new(vec![n; 32])
}

#[test]
fn nf_s__資格は_256_ビットから_43_文字の_URL_安全な文字列になる() {
    let token = encode_token(&[7; 32]);
    assert_eq!(token.expose().len(), 43);
    assert!(
        token
            .expose()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    );
}

#[test]
fn nf_s__ダイジェストは決定的で_鍵と値が違えば変わる() {
    let token = encode_token(&[1; 32]);
    let a = digest(&key(1), &token);
    assert_eq!(a, digest(&key(1), &token));
    assert_eq!(a.as_ref().map(String::len), Some(64));
    assert_ne!(a, digest(&key(2), &token));
    assert_ne!(a, digest(&key(1), &encode_token(&[2; 32])));
}

#[test]
fn nf_s__ダイジェストに生の値を含めない() {
    let token = encode_token(&[3; 32]);
    let d = digest(&key(1), &token).unwrap_or_default();
    assert!(!d.contains(token.expose().as_str()));
}

#[test]
fn nf_s__鍵が空ならダイジェストを作らない() {
    assert_eq!(
        digest(&Secret::new(Vec::new()), &encode_token(&[1; 32])),
        None
    );
}

#[test]
fn x3__秘密は_Debug_に出ない() {
    let token = encode_token(&[9; 32]);
    assert!(!format!("{token:?}").contains(token.expose().as_str()));
    assert_eq!(format!("{:?}", key(1)), "Secret(***)");
}
