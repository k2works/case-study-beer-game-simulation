# Security Requirements - u5-accessible-experience

## Authentication and Authorization

| ID | Requirement | Verification |
|---|---|---|
| NFR3.12 | 復帰資格は HttpOnly、Secure、SameSite cookie を使い、JavaScript、URL、DOM、browser storage、analytics から raw token を参照できないようにする。 | browser storage、network、DOM の E2E inspection。 |
| NFR3.13 | UI の表示制御に加えて、全 read、mutation、SSE 購読、export、保持状態取得と retry で server 側の game / role / operation 認可を要求する。 | role matrix と cross-game negative contract test。 |
| NFR3.14 | role-safe response と event だけを扱い、他 role の非公開値、未来需要、逆算可能な観察値を DOM、状態管理、download payload に置かない。 | response fixture と DOM snapshot の negative test。 |
| NFR3.15 | mutation は expected version と idempotency key を付け、競合時は未保存 draft を保持して最新値との差を示す。権限失敗や削除済み状態を成功として表示しない。 | conflict / timeout / 403 / 404 / 410 の E2E test。 |
| NFR3.16 | cookie を伴う mutation には CSRF protection を適用し、外部 origin からの request を拒否する。CSP は inline script を原則禁止し、response / UI に secret を埋め込まない。 | CSRF negative test、security header inspection。 |

## Privacy and Audit

| ID | Requirement | Verification |
|---|---|---|
| NFR4.10 | UI が収集する個人情報は表示名だけとし、保持期間と削除予定日、削除 Saga の進捗を権限者に示す。削除 receipt に個人情報を含めない。 | form / response schema と role matrix test。 |
| NFR4.11 | 削除状態の COMPLETED は全 owner 完了と receipt の保存が server で確認された場合だけ表示する。FAILED は未完 owner と failure code を示す。 | partial / failed / completed の contract test。 |
| NFR7.10 | 画面で実行したゲーム作成、役割変更、代理入力、週確定、停止、再開、終了、削除・再試行は server audit の correlation ID と照合できるようにする。client telemetry に表示名、参加コード、token を含めない。 | audit / telemetry schema test と log scan。 |

## Threat Considerations

- 主な脅威は credential の script exposure、cross-game / cross-role data leak、CSRF、stale state による誤操作、export への private data 混入です。client 側の非表示だけを認可境界とみなしません。
- U2 と U4 の browser 向け操作、SSE、export の認可と error shape は共有契約に不足しています。NFR Design では実装可能な provider / consumer 契約へ落とします。

## Sources

- `inception/requirements-analysis/requirements.md` NFR3、NFR4、NFR7
- `inception/contract-design/contract-summary.md` C1、C4〜C6
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `construction/u5-accessible-experience/functional-design/reviews/review-01.md`
- `construction/u2-session-continuity/nfr-requirements/security-requirements.md` NFR11.4

## Assumptions & Open Questions

- cookie 発行・失効の正本は U2 の server 側です。U5 は raw recovery token を保持しません。
- 観察者の逆算可能性判定は server 側の応答契約で行い、UI は抑止済み値を再構成しません。
