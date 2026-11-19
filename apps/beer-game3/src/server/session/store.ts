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
  /**
   * 状態を変えた最後の操作の時刻（BR25.2）。作成時は createdAt と同じ。
   * 状態を変える操作の保存と同じ保存の中で更新し、閲覧・再送・拒否では変えない。放置の判定に使う。
   */
  lastOperationAt: Date;
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
  /** 最後の操作の時刻の更新（touchToken）に使う */
  tokenId: string;
  gameId: string;
  participantId: string;
  role: Role | null;
  /** 最後の操作の時刻。期限の判定に使う（BR17.1）。失効していない token だけが返る */
  lastUsedAt: Date;
}

/** 資格情報として使える、ゲームのコード（参加コードは含まない）。 */
export interface CredentialCode {
  gameId: string;
  kind: 'facilitator' | 'observer';
}

/** 参加の窓の 1 回の試行（BR18.1）。 */
export interface JoinAttemptInput {
  /** 接続元の鍵付きの要約。生のアドレスは渡さない */
  sourceKey: string;
  now: Date;
  /** 窓の長さ（ミリ秒） */
  windowMs: number;
  /** 窓に許す件数。すでにこの件数あれば、コードを検証せずに拒否する */
  maxAttempts: number;
  /** 参加コードの照合用の値の候補（鍵の入れ替えの間は複数） */
  codeHashes: string[];
}

export type JoinAttemptOutcome =
  { result: 'limited' } | { result: 'invalid' } | { result: 'valid'; gameId: string };

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

/** runExclusive の結果。ロックを取れなかったときは、処理を呼ばずに acquired が false。 */
export type ExclusiveResult<T> = { acquired: true; value: T } | { acquired: false };

/** ゲームの行を占有している間だけ使える操作。 */
export interface GameTx {
  /**
   * 状態を変える書き込み（参加、割当て、入力、確定、入れ替え、updateGame など）が呼ばれたか（NFR2.5）。
   * GameSession.write が、立っていれば touchOperation を 1 回呼んでからコミットする。
   */
  readonly mutated: boolean;
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
  /**
   * 最後の操作の時刻を at まで進める（減らさない）。版を変えず、履歴に書かない（BR25.2）。
   * 呼ぶのは GameSession.write だけで、状態を変える操作の保存と同じ保存の中で 1 回。
   */
  touchOperation(at: Date): Promise<void>;
  /**
   * ゲームと、紐づくすべてのデータを削除する（BR24.3、C5）。終了したゲームだけ。
   * 外部キーの連鎖で 1 文の中で消え、途中で失敗したらすべて元に戻る。
   */
  deleteGame(): Promise<void>;
}

export interface Store {
  /** ゲーム、設定、需要系列、コードを 1 回の保存で作る。照合用の値が重なれば CodeCollisionError。 */
  createGame(input: NewGame): Promise<void>;
  findCodeByHash(
    hashes: string[],
    kind: AccessCodeKind,
  ): Promise<{ gameId: string; kind: AccessCodeKind } | null>;
  findTokenByHash(hash: string): Promise<ResolvedToken | null>;
  /** 進行役用コードまたは観察者用コードの照合用の値から引く（参加コードは対象外）。資格情報の種類は一致した行で決める。 */
  findCredentialCode(hashes: string[]): Promise<CredentialCode | null>;
  /**
   * 最後の操作の時刻を延ばす。最後の書き込みが minIntervalMs 以上前のときだけ書く条件付きの更新で、
   * 書いたら true。集約の版を変えず、履歴に書かない（BR17.2）。
   */
  touchToken(tokenId: string, now: Date, minIntervalMs: number): Promise<boolean>;
  /**
   * 参加の試行を数える（BR18）。接続元ごとの排他の中で、古い行の削除、件数の検査、
   * 件数が上限未満ならコードの検証、必要な追加を行う。保存に失敗したら、通さずに例外にする。
   */
  attemptJoin(input: JoinAttemptInput): Promise<JoinAttemptOutcome>;
  /** olderThan より古い窓の行を、他の処理を待たずに削除する（ロック中の行は飛ばす）。削除した件数を返す。 */
  sweepJoinAttempts(olderThan: Date): Promise<number>;
  /** 窓の行の数（接続元を指定しなければ全体）。試験と観測用。 */
  countJoinAttempts(sourceKey?: string): Promise<number>;
  getAccessCode(gameId: string, kind: AccessCodeKind): Promise<AccessCodeRow | null>;
  /** 行を占有しない読み取り。ゲームが無ければ null。 */
  readSnapshot(gameId: string): Promise<Snapshot | null>;
  /** ゲームの行を占有して処理する。待てなければ UnavailableError、ゲームが無ければ not_found。 */
  transact<T>(gameId: string, fn: (tx: GameTx) => Promise<T>): Promise<T>;
  /** 履歴を sequence の昇順で全件読む（BR13.2）。行を占有しない 1 回の読み取り。 */
  readHistory(gameId: string): Promise<LogEntryRow[]>;
  /**
   * 放置されたゲーム（終了しておらず、最後の操作が before 以前）を、最後の操作の古い順に limit 件まで返す（BR25.1）。
   * exclude のゲームは、順序と上限の前に除く（失敗が続くゲームが後ろの正常なゲームを塞がない、BR26.3）。
   */
  findStaleGames(before: Date, limit: number, exclude: readonly string[]): Promise<string[]>;
  /**
   * 保持期間を過ぎたゲーム（終了済みで、終了が before 以前）を、終了の古い順に limit 件まで返す（BR24.2）。
   * exclude の扱いは findStaleGames と同じ。
   */
  findExpiredGames(before: Date, limit: number, exclude: readonly string[]): Promise<string[]>;
  /**
   * key の排他ロックを待たずに試み、取れたときだけ fn を呼ぶ（BR26.2）。fn が終わったら（失敗でも）解放する。
   * PostgreSQL の保存では、ロックを持つ専用の接続を使い、ゲームの処理（fn の中）にはほかの接続を使う。
   */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<ExclusiveResult<T>>;
  /** 保存先に接続できるか（ヘルスチェック）。 */
  ping(): Promise<void>;
  close(): Promise<void>;
}
