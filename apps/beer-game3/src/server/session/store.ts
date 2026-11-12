import type { EndReason, GameStatus, Role, SetupKind, SlotKind } from '../domain/types.js';
import type { LogEntryRow, NewLogEntry } from './history.js';

/** 保存先の行の形。メモリ上の保存と PostgreSQL の保存が同じ形を共有する（C3）。 */

export interface GameRow {
  gameId: string;
  name: string;
  status: GameStatus;
  weekCount: number;
  currentWeek: number;
  setupKind: SetupKind;
  version: number;
  createdAt: Date;
  endedAt: Date | null;
  /** status が ended のときだけ持つ（BR9.4） */
  endReason: EndReason | null;
  /** 次に履歴へ足す sequence。ゲームの行を占有した中で 1 ずつ進める（NFR9.2） */
  nextLogSequence: number;
}

export interface SettingsRow {
  settingsId: string;
  gameId: string;
  weekCount: number;
  initialInventory: number;
  initialPipelineQuantity: number;
  inventoryUnitCost: number;
  backlogUnitCost: number;
  visibilityScope: 'team_totals';
  demandSeries: number[];
  isProvisionalDefault: boolean;
}

export interface ParticipantRow {
  participantId: string;
  gameId: string;
  displayName: string;
  joinOrder: number;
  joinedAt: Date;
  /** 入れ替えで役割を離れた時刻（BR10.2）。参加者の行は消さない */
  replacedAt: Date | null;
  /** 入れ替えで進行役が作った参加者は true */
  createdByFacilitator: boolean;
}

export interface AssignmentRow {
  assignmentId: string;
  gameId: string;
  participantId: string;
  role: Role;
}

export interface WeekRecordRow {
  weekRecordId: string;
  gameId: string;
  week: number;
  role: Role;
  decision: number | null;
  receipt: number | null;
  ordersReceived: number | null;
  shipped: number | null;
  inventory: number | null;
  backlog: number | null;
  weeklyCost: number | null;
  cumulativeCost: number | null;
  isConfirmed: boolean;
  /** decision を最後に保存した主体（BR11.2）。decision が null のときは null */
  decidedByKind: DecidedByKind | null;
  decidedByParticipantId: string | null;
  decidedAt: Date | null;
  /** decision を保存するたびに 1 増える（BR12.2）。0 は未入力 */
  decisionRevision: number;
}

export type DecidedByKind = 'participant' | 'facilitator';

export interface DecisionBy {
  kind: DecidedByKind;
  /** kind が participant のとき入力した参加者。facilitator のときは null */
  participantId: string | null;
}

export interface SlotRow {
  kind: SlotKind;
  role: Role;
  /** 1: 当週に届く、2: 次の週に届く */
  remainingWeeks: 1 | 2;
  quantity: number;
}

export type AccessCodeKind = 'join' | 'facilitator' | 'observer';

export interface AccessCodeRow {
  codeId: string;
  gameId: string;
  kind: AccessCodeKind;
  codeHash: string;
  codeSealed: string | null;
  issuedAt: Date;
}

export interface IdempotencyRow {
  recordId: string;
  gameId: string;
  key: string;
  operation: 'submitDecision' | 'confirmWeek';
  requesterId: string;
  requestDigest: string;
  responseBody: unknown;
  createdAt: Date;
}

/** ゲームの作成に必要なものすべて（1 回の保存で書く）。logs は sequence 1 から順に足す（BR13.4）。 */
export interface NewGame {
  game: GameRow;
  settings: SettingsRow;
  codes: AccessCodeRow[];
  logs: NewLogEntry[];
}

export interface Snapshot {
  game: GameRow;
  settings: SettingsRow;
  participants: ParticipantRow[];
  assignments: AssignmentRow[];
  weekRecords: WeekRecordRow[];
  slots: SlotRow[];
}

export interface ResolvedToken {
  gameId: string;
  participantId: string;
  role: Role | null;
}

export interface GameUpdate {
  status?: GameStatus;
  currentWeek?: number;
  endedAt?: Date | null;
  endReason?: EndReason | null;
}

export interface ConfirmedRecord {
  role: Role;
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  weeklyCost: number;
  cumulativeCost: number;
}

/** ゲームの行を占有している間だけ使える操作。 */
export interface GameTx {
  game(): GameRow;
  settings(): Promise<SettingsRow>;
  participants(): Promise<ParticipantRow[]>;
  assignments(): Promise<AssignmentRow[]>;
  weekRecords(week?: number): Promise<WeekRecordRow[]>;
  slots(): Promise<SlotRow[]>;
  snapshot(): Promise<Snapshot>;

  addParticipant(participant: ParticipantRow, tokenHash: string, issuedAt: Date): Promise<void>;
  setAssignment(participantId: string, role: Role | null, assignmentId: string): Promise<void>;
  insertWeekRecords(rows: WeekRecordRow[]): Promise<void>;
  setDecision(week: number, role: Role, quantity: number, by: DecisionBy, at: Date): Promise<void>;
  /** その参加者の復帰用 token が、失効していないものを 1 つ以上持つか（NFR6.3 の再検査） */
  hasActiveToken(participantId: string): Promise<boolean>;
  /** 入れ替えで役割を離れる: replacedAt を設定し、復帰用 token をすべて失効させる（BR10.2、BR10.4） */
  replaceParticipant(participantId: string, at: Date): Promise<void>;
  confirmRecords(week: number, records: ConfirmedRecord[]): Promise<void>;
  replaceSlots(rows: SlotRow[]): Promise<void>;
  findIdempotency(
    operation: IdempotencyRow['operation'],
    requesterId: string,
    key: string,
  ): Promise<IdempotencyRow | null>;
  saveIdempotency(row: IdempotencyRow): Promise<void>;
  /**
   * 版を 1 増やして更新する。expectedVersion が行の版と違えば VersionConflictError。
   * logs は同じ保存の中で履歴へ追記する（BR13.1）。履歴の追記だけを別に呼ぶ関数は持たない。
   * 履歴を残さない更新（参加）は、空の配列を明示する。
   */
  updateGame(
    update: GameUpdate,
    expectedVersion: number,
    logs: readonly NewLogEntry[],
  ): Promise<GameRow>;
}

export interface Store {
  /** ゲーム、設定、需要系列、コードを 1 回の保存で作る。照合用の値が重なれば CodeCollisionError。 */
  createGame(input: NewGame): Promise<void>;
  findCodeByHash(
    hashes: string[],
    kind: AccessCodeKind,
  ): Promise<{ gameId: string; kind: AccessCodeKind } | null>;
  findTokenByHash(hash: string): Promise<ResolvedToken | null>;
  getAccessCode(gameId: string, kind: AccessCodeKind): Promise<AccessCodeRow | null>;
  /** 行を占有しない読み取り。ゲームが無ければ null。 */
  readSnapshot(gameId: string): Promise<Snapshot | null>;
  /** ゲームの行を占有して処理する。待てなければ UnavailableError、ゲームが無ければ not_found。 */
  transact<T>(gameId: string, fn: (tx: GameTx) => Promise<T>): Promise<T>;
  /** 履歴を sequence の昇順で全件読む（BR13.2）。行を占有しない 1 回の読み取り。 */
  readHistory(gameId: string): Promise<LogEntryRow[]>;
  /** 保存先に接続できるか（ヘルスチェック）。 */
  ping(): Promise<void>;
  close(): Promise<void>;
}
