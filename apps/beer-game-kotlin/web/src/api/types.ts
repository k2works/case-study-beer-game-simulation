// API の型。contracts/openapi.yaml（B1 の範囲）に合わせた手書き。
// 型の生成ツールは B2 で選定・承認するため、B1 では生成せず、B2 で生成に置き換える。
// 仕様を変えたら、この型も手で合わせる（契約テストの自動化は B2）。

export const ROLES = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const;
export type Role = (typeof ROLES)[number];

export type ErrorCode =
    | 'session.decision_conflict'
    | 'session.week_advanced'
    | 'session.decisions_changed'
    | 'session.already_started'
    | 'session.already_ended'
    | 'session.not_active'
    | 'session.incomplete_decisions'
    | 'game.invitation_invalid'
    | 'game.not_preparing'
    | 'game.already_created'
    | 'game.participant_not_found'
    | 'game.start_condition_not_met'
    | 'validation.invalid_input'
    | 'app.retry_exhausted'
    | 'app.idempotency_key_reused'
    | 'app.unauthorized'
    | 'app.internal'
    | 'app.not_ready'
    | 'app.rate_limited'
    | 'request.too_large'
    | 'request.not_found'
    | 'request.method_not_allowed';

/** 追記後のストリームごとの版。そのコマンドが追記しなかったストリームは null。 */
export interface StreamVersions {
    game: number | null;
    session: number | null;
}

export interface CommandResponse {
    versions: StreamVersions;
}

/** 作成の応答は、versions に加えて、Location から得たゲームの ID を持つ（クライアントが組み立てる）。 */
export interface CreateGameResult extends CommandResponse {
    gameId: string;
}

export interface CreateGameRequest {
    kind: 'KIT';
    /** 仕様は integer。画面は、整数に読めない入力を文字列のまま送り、サーバーの検証（422）に任せる。 */
    finalWeek: number | string;
    demand: ReadonlyArray<number | string>;
    retentionDays?: number | string;
}

export interface JoinGameRequest {
    joinCode: string;
    displayName: string;
}

export interface SaveDecisionRequest {
    week: number;
    quantity: number;
}

export interface CommitWeekRequest {
    requestedWeek: number;
    basis: Record<Role, number>;
}

export type GameStatus = 'PREPARING' | 'STARTED' | 'ENDED';

export interface LobbyParticipant {
    participantId: string;
    displayName: string | null;
    role: Role | null;
}

export interface Lobby {
    gameId: string;
    status: GameStatus;
    joinCode: string;
    participants: LobbyParticipant[];
    versions: StreamVersions;
}

export interface GameState {
    gameId: string;
    sessionId: string | null;
    status: GameStatus;
    joinCode?: string;
    finalWeek?: number;
    participantId?: string;
    role?: Role;
    versions: StreamVersions;
}

export interface RoleStatus {
    inventory: number;
    backlog: number;
    arrivals: number;
    orders: number;
    customerDemand?: number;
    decision: number | null;
    decisionVersion: number;
}

export interface RoleWeekResult {
    role: Role;
    week: number;
    orders: number;
    order: number;
    inventory: number;
    backlog: number;
    shipment: number;
    cost: number;
    cumulativeCost: number;
}

export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

export interface SessionState {
    sessionId: string;
    status: SessionStatus;
    week: number;
    submittedRoleCount: number;
    participantId?: string;
    role?: Role;
    finalWeek?: number;
    roleStatus?: RoleStatus;
    roles?: Partial<Record<Role, RoleStatus>>;
    results?: RoleWeekResult[];
    versions: StreamVersions;
}

export interface FieldError {
    field: string;
    week?: number;
    message: string;
}

/** problem+json の本文（応答の形）。 */
export interface ProblemBody {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    code?: string;
    correlationId?: string;
    errors?: FieldError[];
    missingRoles?: Role[];
    [key: string]: unknown;
}
