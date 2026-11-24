//! 操作の名前（OpenAPI の operationId）。メトリクスのディメンション `Operation` は、この**固定の集合**だけ（カーディナリティを抑える）。
//! 経路は URL の実値でなく、テンプレートで引く（ゲーム ID などの識別子がメトリクスに入らない。NF-S14）。
//! 表は `contracts/openapi.yaml` と一致しなければならない（`app/tests/metrics_http.rs` が突き合わせる）。

/// どの経路にも当たらない要求の操作名。
pub const UNMATCHED: &str = "unmatched";

/// （メソッド, 経路のテンプレート, operationId）。
pub const OPERATIONS: [(&str, &str, &str); 25] = [
    ("GET", "/api/v1/health", "getHealth"),
    ("GET", "/api/v1/ready", "getReady"),
    ("POST", "/api/v1/games", "createGame"),
    ("POST", "/api/v1/participations/join", "joinGame"),
    (
        "POST",
        "/api/v1/participations/recover",
        "recoverParticipation",
    ),
    ("POST", "/api/v1/participations/observe", "joinAsObserver"),
    (
        "POST",
        "/api/v1/games/{game_id}/credentials/revoke",
        "revokeCredential",
    ),
    (
        "POST",
        "/api/v1/games/{game_id}/credentials/reissue",
        "reissueCredential",
    ),
    (
        "PUT",
        "/api/v1/games/{game_id}/participants/{participant_id}/role",
        "assignRole",
    ),
    ("POST", "/api/v1/games/{game_id}/start", "startGame"),
    ("GET", "/api/v1/games/{game_id}/state", "getGameState"),
    ("GET", "/api/v1/games/{game_id}/lobby", "getLobby"),
    ("GET", "/api/v1/games/{game_id}/review", "getReview"),
    (
        "GET",
        "/api/v1/games/{game_id}/observation",
        "getObservation",
    ),
    ("GET", "/api/v1/games/{game_id}/exports", "getExport"),
    ("GET", "/api/v1/games/{game_id}/retention", "getRetention"),
    (
        "POST",
        "/api/v1/games/{game_id}/observer-invitations",
        "inviteObserver",
    ),
    (
        "POST",
        "/api/v1/games/{game_id}/observer-invitations/{invitation_id}/revoke",
        "revokeObserverInvitation",
    ),
    (
        "PUT",
        "/api/v1/sessions/{session_id}/decisions",
        "saveDecision",
    ),
    (
        "POST",
        "/api/v1/sessions/{session_id}/weeks/{week}/commit",
        "commitWeek",
    ),
    (
        "POST",
        "/api/v1/sessions/{session_id}/pause",
        "pauseSession",
    ),
    (
        "POST",
        "/api/v1/sessions/{session_id}/resume",
        "resumeSession",
    ),
    (
        "PUT",
        "/api/v1/sessions/{session_id}/commit-mode",
        "setCommitMode",
    ),
    (
        "PUT",
        "/api/v1/sessions/{session_id}/proxy-decisions/{role}",
        "submitProxyDecision",
    ),
    (
        "GET",
        "/api/v1/sessions/{session_id}/state",
        "getSessionState",
    ),
];

/// 要求の操作名。どれにも当たらなければ `UNMATCHED`。
#[must_use]
pub fn operation_of(method: &str, path: &str) -> &'static str {
    OPERATIONS
        .iter()
        .find(|(m, template, _)| *m == method && matches_template(template, path))
        .map_or(UNMATCHED, |(_, _, id)| id)
}

/// 経路が、テンプレートに当たるか。`{…}` の区間は、空でない任意の 1 区間に当たる。
fn matches_template(template: &str, path: &str) -> bool {
    let mut template_segments = template.split('/');
    let mut path_segments = path.split('/');
    loop {
        match (template_segments.next(), path_segments.next()) {
            (None, None) => return true,
            (Some(t), Some(p)) => {
                let wildcard = t.starts_with('{') && t.ends_with('}');
                if !(t == p || (wildcard && !p.is_empty())) {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;

    #[test]
    fn ac6_1_3__経路の実値は_テンプレートの操作名に引ける() {
        assert_eq!(
            operation_of(
                "GET",
                "/api/v1/games/00000000-0000-0000-0000-000000000001/state"
            ),
            "getGameState"
        );
        assert_eq!(operation_of("POST", "/api/v1/games"), "createGame");
        assert_eq!(
            operation_of("POST", "/api/v1/sessions/abc/weeks/3/commit"),
            "commitWeek"
        );
        assert_eq!(operation_of("GET", "/api/v1/ready"), "getReady");
    }

    #[test]
    fn ac6_1_3__メソッドが違えば_別の操作か_当たらない() {
        assert_eq!(
            operation_of("PUT", "/api/v1/sessions/s/decisions"),
            "saveDecision"
        );
        assert_eq!(
            operation_of("GET", "/api/v1/sessions/s/decisions"),
            UNMATCHED
        );
    }

    #[test]
    fn ac6_1_3__知らない経路は_unmatched_で_経路の実値を返さない() {
        assert_eq!(operation_of("GET", "/secret/abc"), UNMATCHED);
        assert_eq!(
            operation_of("GET", "/api/v1/games/x/state/extra"),
            UNMATCHED
        );
        assert_eq!(operation_of("GET", "/api/v1/games//state"), UNMATCHED);
    }

    #[test]
    fn ac6_1_3__表の_operationId_は重複せず_メソッドと経路の組も重複しない() {
        let mut ids: Vec<&str> = OPERATIONS.iter().map(|o| o.2).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), OPERATIONS.len());
        let mut keys: Vec<(&str, &str)> = OPERATIONS.iter().map(|o| (o.0, o.1)).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), OPERATIONS.len());
    }
}
