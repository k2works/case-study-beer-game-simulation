# Security Design - u5-accessible-experience

## Credential and request boundary

復帰資格は U2 が発行・失効する opaque session の `HttpOnly; Secure; SameSite=Strict` cookie で運びます。U5 は raw token を JavaScript、DOM、URL、localStorage、sessionStorage に置きません。すべての credential 付き request は同一 origin の HTTPS から `credentials: include` で送ります。logout、終了後の失効、削除時の失効は server が cookie を破棄し、U5 は画面 state を破棄します。これは NFR3.12 に対応します。

## CSRF and browser security

利用者の選択に従い、CSRF token は使用しません。変更操作は `SameSite=Strict` と、server での `Origin` の完全一致検査を必須とします。`Origin` がない browser request は同一 origin の HTTPS `Referer` を確認し、どちらも無い場合、異なる場合、`null` の場合は fail-closed で拒否します。許可 origin は固定設定とし、wildcard CORS、credential を伴う cross-origin request は許可しません。拒否は secret や protected object の存在を示さない 403 と correlation ID だけを返します。GET は副作用を持たず、cookie を使う state-changing endpoint にこの検査を一律適用します。これが NFR3.16 の採用方式です。

U1 の既存 NFR Design は CSRF token を要求しており、今回の選択と矛盾します。U1 / U2 / U3 / U4 の browser 向け provider 契約と U1 設計を同じ方式に改訂し、negative test を更新するまで Code Generation で両方式を混在させません。

Content Security Policy は nonce または hash で script を制限し、inline script と外部送信先を allowlist で管理します。HSTS、`nosniff`、frame denial を適用します。form の text / integer は client で補助検査し、server schema validation を正本にします。

## Authorization and privacy

| 要件 | 設計と検証 |
|---|---|
| NFR3.13 | server が game、participant、role、operation を read / write / SSE subscribe / export / retention status / retry の全境界で検査する。UI の route guard は体験改善のみ。cross-game と cross-role の negative contract test を用意する。 |
| NFR3.14 | U1 / U3 / U4 が role-safe DTO を生成し、U5 は DTO 以外を受け取らない。観察値抑止は server で行い、抑止済み値を DOM、chart model、download に含めない。 |
| NFR3.15 | mutation に expected version と idempotency key を付ける。競合時は最新値と draft を別 state に保持し、再送には同じ key を使う。403、404、410 を成功 UI に変換しない。 |
| NFR4.10 | 表示名以外の個人情報を UI で収集しない。保持方針と削除予定日を operator のみに表示し、receipt に個人情報を含めない。 |
| NFR4.11 | retention status の COMPLETED は全 owner 完了と receipt 保存を server が返した場合のみ表示する。FAILED は未完 owner、failure code、連絡導線を示す。 |
| NFR7.10 | 画面からの変更 request に correlation ID を渡すか server 発行 ID を response から取得する。telemetry は event 名、結果、経過時間、ID のみを allowlist で記録し、表示名、参加コード、token を除外する。 |

## Provider contracts and failure handling

共有 C1 / C6 に cookie 発行・失効、cookie 対象 operation、Origin / Referer 拒否、U2 browser 操作、U4 retention status / retry、U3 export 完了確認と download が不足しています。U5 は画面上の成功状態を provider の確定応答に限定します。共有契約に request / response、認可、version、idempotency、失敗形が追加されるまでは該当 flow の実装受入を保留します。

## Sources

- `construction/u5-accessible-experience/nfr-requirements/security-requirements.md`
- `construction/u5-accessible-experience/nfr-requirements/tech-stack-decisions.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `inception/contract-design/contract-summary.md` C1、C4〜C6
- `nfr-design-questions.md` Q2

## Assumptions & Open Questions

- cookie と Origin の共有仕様は U1 / U2 の provider と合意が必要です。U1 の CSRF token 記述は現在のままでは矛盾しています。
