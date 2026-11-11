export type Role = 'FACTORY' | 'DISTRIBUTOR' | 'WHOLESALER' | 'RETAILER';
export type GameStatus = 'PREPARING' | 'STARTED' | 'ENDED';
export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

export interface Issue {
  week?: number;
  problem: string;
  fix: string;
}

/** 共同入力の競合で返る、その役割の最新の入力 */
export interface LatestDecision {
  quantity: number;
  version: number;
  /** 保存者の表示名（代理入力なら「進行役」） */
  savedBy: string;
}

/** API のエラー（Problem JSON） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: Issue[] = [],
    /** 共同入力の競合（409）のときの最新の入力。未入力なら null */
    readonly latest?: LatestDecision | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type CommitMode = 'MANUAL' | 'AUTO';

export type DisclosurePolicy = 'TEAM_TOTAL' | 'PROGRESS_ONLY';

/** ゲームの条件（キット準拠値から変えられる項目）。費用は最小単位（セント） */
export interface Conditions {
  initialInventory: number;
  orderDelayWeeks: number;
  shipmentDelayWeeks: number;
  productionDelayWeeks: number;
  holdingCostMinor: number;
  backlogCostMinor: number;
  disclosure: DisclosurePolicy;
}

export type ConditionItem = keyof Conditions | 'demand';

/** 画面に出す設定。キット準拠か、カスタムか、変更した項目 */
export interface SettingsView extends Conditions {
  kind: 'KIT' | 'CUSTOM';
  changes: ConditionItem[];
}

export interface Lobby {
  commitMode: CommitMode;
  settings: SettingsView;
  gameId: string;
  status: GameStatus;
  finalWeek: number;
  /** 進行役にだけ含まれる */
  joinCode?: string;
  viewer:
    { kind: 'FACILITATOR' } | { kind: 'PARTICIPANT'; participantId: string };
  participants: { id: string; displayName: string }[];
  /** 役割 → 担当の参加者 ID の一覧（共同担当を含む） */
  assignments: Partial<Record<Role, string[]>>;
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
  /** 同じ役割の担当（共同担当を含む）の表示名 */
  coHolders: string[];
  decision: LatestDecision | null;
  history: WeekRow[];
}

export interface ConsoleView {
  settings: SettingsView;
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
    conditions: Conditions;
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
