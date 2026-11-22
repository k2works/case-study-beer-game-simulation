// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 冪等記録の応答の暗号化（AES-256-GCM）。

use beergame_application::{Secret, open, seal};

fn key(byte: u8) -> Secret<Vec<u8>> {
    Secret::new(vec![byte; 32])
}

#[test]
fn nf_s5__暗号化した応答は同じ鍵で復号でき_平文を含まない() -> Result<(), String> {
    let plain = br#"{"recoveryCode":"secret-recovery-code"}"#;
    let sealed = seal(&key(1), &[7; 32], plain).ok_or("暗号化できない")?;
    assert!(!sealed.windows(plain.len()).any(|w| w == plain));
    assert!(!String::from_utf8_lossy(&sealed).contains("secret-recovery-code"));
    assert_eq!(open(&key(1), &sealed).as_deref(), Some(plain.as_slice()));
    Ok(())
}

#[test]
fn nf_s5__鍵が違う_改ざん_短すぎる_空の鍵は復号も暗号化もできない() -> Result<(), String> {
    let sealed = seal(&key(1), &[7; 32], b"x").ok_or("暗号化できない")?;
    assert_eq!(open(&key(2), &sealed), None, "別の鍵");
    let mut tampered = sealed.clone();
    if let Some(last) = tampered.last_mut() {
        *last ^= 1;
    }
    assert_eq!(open(&key(1), &tampered), None, "改ざん");
    assert_eq!(open(&key(1), &sealed[..5]), None, "短すぎる");
    assert_eq!(seal(&Secret::new(Vec::new()), &[7; 32], b"x"), None);
    assert_eq!(open(&Secret::new(Vec::new()), &sealed), None);
    // 同じ平文でも、ノンスが違えば暗号文が違う
    let other = seal(&key(1), &[8; 32], b"x").ok_or("暗号化できない")?;
    assert_ne!(sealed, other);
    Ok(())
}
