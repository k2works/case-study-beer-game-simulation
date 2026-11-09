# Security Requirements - U4 Retention Operations

## Controls

| ID | Requirement | Verification |
|---|---|---|
| NFR3.1 | policy 変更、手動 retry、status 読取は server-side operator authorization を毎回検査する | authorization matrix / IDOR test |
| NFR3.2 | C4/C5 は schemaVersion、deletionId、ownerUnit、eventId を検証し、unknown major を隔離する | contract fuzz test |
| NFR3.3 | receipt、event、log に displayName、token、credential digest、削除 payload を含めない | sensitive-data scan |
| NFR3.4 | game reference は不可逆 digest とし、receipt は保存時と通信時に暗号化する | storage/config inspection |
| NFR4.1 | deletion receipt は U4 が一元所有し、記録後 1 年で削除する | retention lifecycle test |

## Threats

replay、偽 completion、旧 attempt の遅延 completion、権限昇格、receipt からの再識別を対象にします。C5 の current attempt binding は NFR Design で必須の整合性制御として定義します。

## Sources

- `functional-design/rules.md` BR15.3〜BR15.7
- `contract-summary.md` C4/C5
- `requirements.md` NFR3、NFR4
