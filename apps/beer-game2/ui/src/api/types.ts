export type Role = 'FACTORY' | 'DISTRIBUTOR' | 'WHOLESALER' | 'RETAILER';
export type GameStatus = 'PREPARING' | 'STARTED' | 'ENDED';
export type SessionStatus = 'ACTIVE' | 'ENDED';

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
  }): Promise<{ gameId: string; joinCode: string }>;
  join(input: {
    joinCode: string;
    displayName: string;
  }): Promise<{ gameId: string; participantId: string }>;
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
  /** 変化の通知を購読する。戻り値で解除 */
  subscribe(gameId: string, onChange: () => void): () => void;
}
