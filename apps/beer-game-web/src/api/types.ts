// API の型。apps/beer-game-contracts/openapi.yaml から生成した src/api/generated/schema.d.ts（npm run api:generate）を、
// 画面が使う名前に写す。仕様を直したら型を再生成する（差分は npm run api:check と CI が検査する）。
// ここに手で書くのは、画面だけの型（CreateGameResult、ProblemBody、入力の緩い CreateGameRequest）と、実行時に要る値（ROLES）だけ。
import type { components } from './generated/schema';

type Schemas = components['schemas'];

export type Role = Schemas['Role'];

/** 画面の並び順（小売店から工場）。実行時の値なので生成物には無く、Role と一致することを型で検査する。 */
export const ROLES = [
    'RETAILER',
    'WHOLESALER',
    'DISTRIBUTOR',
    'FACTORY',
] as const satisfies readonly Role[];

// ROLES が Role の全値を含むことの検査（Role に値が増えて ROLES が追いつかなければ、型のエラーになる）。
const rolesCoverEveryRole: Exclude<Role, (typeof ROLES)[number]> extends never ? true : never =
    true;
void rolesCoverEveryRole;

export type ErrorCode = Schemas['ErrorCode'];

/** 追記後のストリームごとの版。そのコマンドが追記しなかったストリームは null。 */
export type StreamVersions = Schemas['StreamVersions'];

export type CommandResponse = Schemas['CommandResponse'];

/** 作成の応答。versions に加えて、進行役の復帰コード（recoveryCode）を一度だけ示す（B5 の例外。ADR-015）。 */
export type CreateGameResponse = Schemas['CreateGameResponse'];

/** 参加の応答。versions に加えて、参加したゲームの ID（gameId）を返す（B5 の判断項目 7）。 */
export type JoinResponse = Schemas['JoinResponse'];

export type RecoverRequest = Schemas['RecoverRequest'];

/** 復帰の応答。復帰したゲームの ID と、復帰した操作者の種別（進行役か参加者）、参加者の担当の役割。 */
export type RecoverResponse = Schemas['RecoverResponse'];

/** 作成の結果は、応答に加えて、Location から得たゲームの ID を持つ（クライアントが組み立てる）。 */
export interface CreateGameResult extends CreateGameResponse {
    gameId: string;
}

/**
 * 仕様（CreateGameRequest）は integer。画面は、整数に読めない入力を文字列のまま送り、サーバーの検証（422）に任せる。
 * そのため、仕様の型より広い（仕様の型の値は、すべてこの型に代入できる）。
 */
export interface CreateGameRequest {
    kind: Schemas['CreateGameRequest']['kind'];
    finalWeek: number | string;
    demand: ReadonlyArray<number | string>;
    retentionDays?: number | string;
    conditions?: CustomConditionsInput;
    commitMode?: CommitMode;
}

/** カスタム条件の入力。仕様（CustomConditions）と同じ項目で、値は整数に読めない入力も文字列のまま送れる。 */
export interface CustomConditionsInput {
    initialInventory?: Partial<Record<Role, number | string>>;
    initialFlow?: number | string;
    orderDelayWeeks?: number | string;
    shipmentDelayWeeks?: number | string;
    productionDelayWeeks?: number | string;
    holdingCostMinor?: number | string;
    backlogCostMinor?: number | string;
    disclosurePolicy?: Schemas['CustomConditions']['disclosurePolicy'];
}

export type CommitMode = Schemas['CommitMode'];

export type SettingsKind = Schemas['SettingsKind'];

export type SettingsField = Schemas['SettingsField'];

// 仕様の作成の要求が、画面の型に代入できること（画面の型が、仕様より狭くならないことの検査）。
const createRequestIsAccepted = (request: Schemas['CreateGameRequest']): CreateGameRequest =>
    request;
void createRequestIsAccepted;

export type JoinGameRequest = Schemas['JoinGameRequest'];

export type ProxyDecisionRequest = Schemas['ProxyDecisionRequest'];

export type SaveDecisionRequest = Schemas['SaveDecisionRequest'];

/** 保存した人（B6）。表示名は、同じ役割の共同担当と進行役にだけ届く。進行役の代理入力は表示名を持たない。 */
export type DecisionEditor = Schemas['DecisionEditor'];

/** 保存済みの入力（数量・版・保存者・保存の時刻）。競合の 409 の `latest` の形。 */
export type DecisionEntry = Schemas['DecisionEntry'];

export type CommitWeekRequest = Schemas['CommitWeekRequest'];

export type GameStatus = Schemas['Lobby']['status'];

export type LobbyParticipant = Schemas['LobbyParticipant'];

export type Lobby = Schemas['Lobby'];

/** 観察用の招待（B9）。招待コードの値は含まない（発行の応答だけが一度だけ運ぶ）。 */
export type LobbyInvitation = Schemas['LobbyInvitation'];

/** 参加した観察者（B9）。役割を持たない。 */
export type LobbyObserver = Schemas['LobbyObserver'];

/** 招待の発行の応答。招待コードと招待の ID・有効期限を、一度だけ示す。 */
export type InviteObserverResponse = Schemas['InviteObserverResponse'];

export type JoinObserverRequest = Schemas['JoinObserverRequest'];

/** 観察者の参加の応答。参加したゲームの ID と種別（OBSERVER）。 */
export type JoinObserverResponse = Schemas['JoinObserverResponse'];

/** 観察の内容（B9）。現在週・完了状況・チーム合計だけ。役割別の値・将来の需要・参加コードは含まない。 */
export type Observation = Schemas['Observation'];

export type ObservationWeek = Schemas['ObservationWeek'];

export type Review = Schemas['Review'];

/** 保持状態（B11。S09）。保持日数・削除予定日・削除の進行・バックアップの残存日数。進行役だけが取得できる。 */
export type Retention = Schemas['Retention'];

/** 出力の形式（B10）。`GET /games/{gameId}/exports?format=` の値。 */
export type ExportFormat = 'csv' | 'json';

/** 出力したファイル（B10）。名前はサーバーが決める（Content-Disposition）。ダウンロードは画面が Blob から行う。 */
export interface ExportFile {
    filename: string;
    blob: Blob;
}

export type GameState = Schemas['GameState'];

export type RoleStatus = Schemas['RoleStatus'];

export type RoleWeekResult = Schemas['RoleWeekResult'];

export type SessionStatus = Schemas['SessionState']['status'];

export type SessionState = Schemas['SessionState'];

export type FieldError = NonNullable<Schemas['ValidationProblemBody']['errors']>[number];

/** problem+json の本文（応答の形）。応答は信頼できない入力なので、項目はすべて任意で読む。 */
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
