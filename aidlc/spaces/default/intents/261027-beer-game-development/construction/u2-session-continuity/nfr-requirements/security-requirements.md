# Security Requirements - U2

## Credential and authorization

- **NFR11.1** recovery token は CSPRNG 256-bit 以上とし、raw value を log / database / telemetry に保存しません。
- **NFR11.2** token は SHA-256 以上の keyed digest で照合し、rotation 時に旧 token を原子的に失効します。
- **NFR11.3** recovery、pause、resume、end、proxy decision は server-side game / role membership と actor authorization を毎回検証します。
- **NFR11.4** cookie は署名または opaque server-side session とし、HttpOnly、Secure、SameSite を必須にします。

## Abuse resistance

- **NFR11.5** recovery failure は token の存在・期限・削除状態を区別しない response とします。
- **NFR11.6** recovery endpoint は IP と token digest prefix 単位で rate limit し、連続失敗を監査します。
- **NFR11.7** audit は credential、raw decision history、不要な個人情報を含めません。

## Sources

`functional-design/rules.md`、`requirements.md`、`contract-summary.md`、U1 security design。
