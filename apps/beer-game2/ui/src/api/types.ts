export type Role = 'FACTORY' | 'DISTRIBUTOR' | 'WHOLESALER' | 'RETAILER';
export type GameStatus = 'PREPARING' | 'STARTED' | 'ENDED';
export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

export interface Issue {
  week?: number;
  problem: string;
  fix: string;
}

/** API のエラー（Problem JSON） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type CommitMode = 'MANUAL' | 'AUTO';

export interface Lobby {
  commitMode: CommitMode;
  gameId: string;
  status: GameStatus;
  finalWeek: number;
  /** 進行役にだけ含まれる */
  joinCode?: string;
  viewer:
    { kind: 'FACILITATOR' } | { kind: 'PARTICIPANT'; participantId: string };
  participants: { id: string; displayName: string }[];
  assignments: Partial<Record<Role, string>>;
  missingRoles: Role[];
}

export interface WeekRow {
  week: number;
  order: number;
  demand: number;
  received: number;
  shipped: number;
  endingInventory: number;
  endingBacklog: number;
  weeklyCostMinor: number;
  cumulativeCostMinor: number;
}

export interface RoleView {
  commitMode: CommitMode;
  role: Role;
  status: SessionStatus;
  week: number;
  sessionVersion: number;
  inventory: number;
  backlog: number;
  incomingGoods: number[];
  /** 小売店だけ */
  customerDemand?: number;
  decision: { quantity: number; version: number } | null;
  history: WeekRow[];
}

export interface ConsoleView {
  status: SessionStatus;
  week: number;
  sessionVersion: number;
  submitted: Record<Role, boolean>;
  /** 役割ごとの入力の版（代理入力に使う） */
  versions: Record<Role, number>;
}

/** 資格の再発行の対象 */
export type CredentialTarget =
  { kind: 'FACILITATOR' } | { kind: 'PARTICIPANT'; participantId: string };

export interface Recovered {
  gameId: string;
  kind: 'FACILITATOR' | 'PARTICIPANT';
  participantId?: string;
  gameStatus: GameStatus;
}

export type Metric = 'order' | 'inventory' | 'backlog' | 'shipped' | 'cost';

/** 振り返り（役割別の時系列）。費用は最小単位（セント） */
export interface ReviewView {
  weeks: number[];
  demand: number[];
  series: Record<Metric, Record<Role, number[]>>;
}

export interface CommitResult {
  committedWeek: number;
  nextWeek: number;
  status: SessionStatus;
}

export interface ApiClient {
  createGame(input: {
    weeks: number;
    commitMode: CommitMode;
  }): Promise<{ gameId: string; joinCode: string; recoveryCode: string }>;
  join(input: {
    joinCode: string;
    displayName: string;
  }): Promise<{ gameId: string; participantId: string; recoveryCode: string }>;
  /** 復帰コードで戻る（新しい Cookie が設定される） */
  recover(code: string): Promise<Recovered>;
  pause(gameId: string): Promise<void>;
  resume(gameId: string): Promise<void>;
  proxyDecision(
    gameId: string,
    role: Role,
    quantity: number,
    version: number,
  ): Promise<{ version: number }>;
  /** 漏れた資格を失効させ、新しい復帰コードを受け取る */
  reissue(
    gameId: string,
    target: CredentialTarget,
  ): Promise<{ recoveryCode: string }>;
  lobby(gameId: string): Promise<Lobby>;
  assign(gameId: string, participantId: string, role: Role): Promise<void>;
  unassign(gameId: string, participantId: string): Promise<void>;
  start(gameId: string): Promise<void>;
  me(gameId: string): Promise<RoleView>;
  console(gameId: string): Promise<ConsoleView>;
  saveDecision(
    gameId: string,
    role: Role,
    quantity: number,
    version: number,
  ): Promise<{ version: number; committed?: CommitResult }>;
  commit(
    gameId: string,
    week: number,
    version: number,
    idempotencyKey: string,
  ): Promise<CommitResult>;
  review(gameId: string): Promise<ReviewView>;
  /** 変化の通知を購読する。戻り値で解除 */
  subscribe(gameId: string, onChange: () => void): () => void;
}
