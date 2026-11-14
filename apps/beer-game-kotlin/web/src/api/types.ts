// API の型。contracts/openapi.yaml から生成した src/api/generated/schema.d.ts（npm run api:generate）を、
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

/** 作成の応答は、versions に加えて、Location から得たゲームの ID を持つ（クライアントが組み立てる）。 */
export interface CreateGameResult extends CommandResponse {
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
}

// 仕様の作成の要求が、画面の型に代入できること（画面の型が、仕様より狭くならないことの検査）。
const createRequestIsAccepted = (request: Schemas['CreateGameRequest']): CreateGameRequest =>
    request;
void createRequestIsAccepted;

export type JoinGameRequest = Schemas['JoinGameRequest'];

export type SaveDecisionRequest = Schemas['SaveDecisionRequest'];

export type CommitWeekRequest = Schemas['CommitWeekRequest'];

export type GameStatus = Schemas['Lobby']['status'];

export type LobbyParticipant = Schemas['LobbyParticipant'];

export type Lobby = Schemas['Lobby'];

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
