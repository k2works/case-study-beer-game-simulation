# Security Design - U2 Session Continuity

## Authentication and credential lifecycle

- recovery token は `crypto.randomBytes(32)` で生成する 256-bit opaque value とし、発行時に 1 回だけ browser へ返します。
- server は環境別 secret を使う HMAC-SHA-256 digest、key version、expiry、revokedAt、membership ID のみを保存します。raw token は database、log、trace、metric label に残しません。
- recovery 成功時は token を rotate し、旧 digest の失効と新 digest の保存を同一 transaction で行います。並行利用では最初の commit だけ成功します。
- browser session は opaque identifier を HttpOnly、Secure、SameSite=Lax cookie に保存します。state-changing request は Origin 検査と CSRF token を必須にします。

## Authorization

HTTP adapter は credential を actor context に変換し、application service は command ごとに game membership、role、facilitator 権限、session status を再検査します。U2 は C2 の `loadSessionForCommand` と `appendSessionTransition` を介し、U1 table を直接更新しません。

| Action | Required actor | Additional checks |
|---|---|---|
| recover | matching role membership | active token、not expired、not revoked、game not deleted |
| pause / resume / end | facilitator | expected version、valid lifecycle transition |
| proxy decision | facilitator | target role belongs to game、quantity validation、week is active |
| state query | participant / facilitator | role-safe field allowlist |

## Abuse resistance and failure privacy

- invalid、expired、revoked、deleted token はすべて `401 RECOVERY_NOT_AVAILABLE` と同一 response size class を返します。
- recovery endpoint は IP あたり 10 requests/minute、digest prefix あたり 5 failures/15 minutes を初期値とし、成功時も global capacity limit の対象にします。
- rate-limit key に raw token を使わず、server-side digest の先頭 64 bit を HMAC で再変換した bucket key を使います。
- JSON schema、request size 16 KiB、quantity の domain range、UUID / idempotency key 形式を boundary で検査します。
- CSP、`frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、strict referrer policy を設定します。

## Encryption and secrets

通信は TLS 1.2 以上、managed PostgreSQL は storage encryption を有効化します。HMAC key と cookie signing key は secrets manager から起動時に取得し、log へ出力しません。key rotation は active + previous の 2 version を読み取り可能にし、新規発行は active のみを使います。

## Audit and verification

audit は actor type、gameId、roleId の pseudonymous ID、action、result、correlationId、latency、credential key version を記録します。token、digest、decision payload、display name は除外します。Vitest で redaction、IDOR、CSRF、rotation race、rate limit、uniform failure response を検証します。

## Requirement coverage

NFR11.1〜NFR11.7、NFR13.4、NFR14.2 をこの設計で満たします。

