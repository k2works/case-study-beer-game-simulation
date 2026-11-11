import type { Actor } from './actor.js';
import type { Game, GameSettings } from './game.js';
import { ROLES, type Role } from './role.js';
import {
  initialRoleStates,
  simulateWeek,
  type RoleStates,
  type RoleWeekResult,
} from './simulate-week.js';
import {
  DomainError,
  PermissionError,
  Quantity,
  StaleError,
} from './values.js';

export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

/** 代理入力の保存者 */
export const PROXY_OPERATOR = 'FACILITATOR';

export interface Decision {
  quantity: number;
  /** 役割ごとの版。古い版の更新を拒否し、変更を黙って失わない */
  version: number;
  /** 保存した参加者 ID。代理入力なら `PROXY_OPERATOR` */
  savedBy: string;
}

/** 役割別の週結果（その週の発注を含む） */
export interface RoleWeekRecord extends RoleWeekResult {
  order: number;
}
export interface WeekRecord {
  week: number;
  /** 手動（進行役）か自動（全役割の保存）か */
  commitKind: 'MANUAL' | 'AUTO';
  roles: Readonly<Record<Role, RoleWeekRecord>>;
}

/** Session 集約（進行）。不変。操作は新しい Session とイベントを返す。
 *
 * @landmark 進行の集約。週・役割別の状態・発注・履歴を持ち、確定と自動確定の不変条件を守る。Game とは別の集約にして、更新の競合を小さくしている。
 */
export interface Session {
  id: string;
  gameId: string;
  status: SessionStatus;
  /** 週の確定と、入力の変更のたびに増える */
  version: number;
  week: number;
  settings: GameSettings;
  /** 役割 → 担当の参加者 ID（開始時点の写し） */
  holders: Readonly<Record<Role, string>>;
  states: RoleStates;
  decisions: Readonly<Partial<Record<Role, Decision>>>;
  history: readonly WeekRecord[];
}

export type SessionEvent =
  | { type: 'SessionStarted'; gameId: string; sessionId: string }
  | {
      type: 'DecisionSaved';
      sessionId: string;
      role: Role;
      quantity: number;
      savedBy: string;
      version: number;
    }
  | {
      type: 'ProxyDecisionSubmitted';
      sessionId: string;
      role: Role;
      quantity: number;
      version: number;
      operator: typeof PROXY_OPERATOR;
      /** 操作の時刻（ISO 8601）。監査の記録 */
      at: string;
    }
  | { type: 'WeekCommitted'; sessionId: string; record: WeekRecord }
  | { type: 'SessionPaused'; sessionId: string }
  | { type: 'SessionResumed'; sessionId: string }
  | { type: 'SessionEnded'; sessionId: string };

export interface SessionOutcome {
  session: Session;
  events: SessionEvent[];
}

export function startSession(game: Game, sessionId: string): SessionOutcome {
  if (game.status !== 'STARTED')
    throw new DomainError('開始済みのゲームからだけ、進行を始められます');
  const holders = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = game.assignments[role];
    if (id === undefined) throw new DomainError(`${role} に参加者がいません`);
    holders[role] = id;
  }
  const session: Session = {
    id: sessionId,
    gameId: game.id,
    status: 'ACTIVE',
    version: 0,
    week: 1,
    settings: game.settings,
    holders,
    states: initialRoleStates(),
    decisions: {},
    history: [],
  };
  return {
    session,
    events: [{ type: 'SessionStarted', gameId: game.id, sessionId }],
  };
}

function requireNotEnded(session: Session): void {
  if (session.status === 'ENDED')
    throw new DomainError('このゲームは終了しています');
}

function requireActive(session: Session): void {
  requireNotEnded(session);
  if (session.status === 'PAUSED')
    throw new DomainError(
      '停止中です。進行役の再開を待ってください（保存済みの入力は残っています）',
    );
}

function requireFacilitator(actor: Actor, operation: string): void {
  if (actor.kind !== 'FACILITATOR')
    throw new PermissionError(`${operation}は進行役だけができます`);
}

/** 進行役が停止する。停止中は、参加者の保存と週の確定を拒否する */
export function pauseSession(session: Session, actor: Actor): SessionOutcome {
  requireFacilitator(actor, '停止');
  requireActive(session);
  return {
    session: { ...session, status: 'PAUSED', version: session.version + 1 },
    events: [{ type: 'SessionPaused', sessionId: session.id }],
  };
}

/** 進行役が再開する。最後の確定済みの週の次から、入力を続けられる */
export function resumeSession(session: Session, actor: Actor): SessionOutcome {
  requireFacilitator(actor, '再開');
  requireNotEnded(session);
  if (session.status !== 'PAUSED')
    throw new DomainError('停止中ではないため、再開できません');
  return {
    session: { ...session, status: 'ACTIVE', version: session.version + 1 },
    events: [{ type: 'SessionResumed', sessionId: session.id }],
  };
}

/**
 * @guidedTour walking-skeleton 50 ルールの本体その 1。担当の役割だけが、進行中に、範囲内の数量を、版が一致するときだけ保存できる。自動確定のゲームでは、最後の保存で、同じ操作の中で週を確定する。
 */
export function saveDecision(
  session: Session,
  actor: Actor,
  role: Role,
  quantity: number,
  expectedVersion: number,
): SessionOutcome {
  requireActive(session);
  if (actor.kind !== 'PARTICIPANT') {
    throw new PermissionError(
      '進行役は、参加者の保存ではなく代理入力を使ってください',
    );
  }
  if (session.holders[role] !== actor.participantId) {
    throw new PermissionError(
      `${role} の担当ではないため、発注を保存できません`,
    );
  }
  const { saved, decision } = storeDecision(
    session,
    role,
    quantity,
    expectedVersion,
    actor.participantId,
  );
  return withAutoCommit(saved, [
    {
      type: 'DecisionSaved',
      sessionId: session.id,
      role,
      quantity: decision.quantity,
      savedBy: actor.participantId,
      version: decision.version,
    },
  ]);
}

/**
 * 進行役の代理入力。進行中・停止中のどちらでもでき、操作者・役割・時刻・値をイベント（監査の記録）に残す。
 */
export function proxyDecision(
  session: Session,
  actor: Actor,
  role: Role,
  quantity: number,
  expectedVersion: number,
  at: Date,
): SessionOutcome {
  requireFacilitator(actor, '代理入力');
  requireNotEnded(session);
  const { saved, decision } = storeDecision(
    session,
    role,
    quantity,
    expectedVersion,
    PROXY_OPERATOR,
  );
  return withAutoCommit(saved, [
    {
      type: 'ProxyDecisionSubmitted',
      sessionId: session.id,
      role,
      quantity: decision.quantity,
      version: decision.version,
      operator: PROXY_OPERATOR,
      at: at.toISOString(),
    },
  ]);
}

/** 範囲と版を検査して、役割の意思決定を保存する（参加者・代理で共通） */
function storeDecision(
  session: Session,
  role: Role,
  quantity: number,
  expectedVersion: number,
  savedBy: string,
): { saved: Session; decision: Decision } {
  const value = Quantity.of(quantity, session.settings.quantityMax);
  const current = session.decisions[role];
  if ((current?.version ?? 0) !== expectedVersion) {
    throw new StaleError(
      `他の操作で更新されています。最新の発注は ${current?.quantity ?? '未入力'} です`,
    );
  }
  const decision: Decision = {
    quantity: value,
    version: expectedVersion + 1,
    savedBy,
  };
  return {
    decision,
    saved: {
      ...session,
      version: session.version + 1,
      decisions: { ...session.decisions, [role]: decision },
    },
  };
}

/** 自動確定: 最後の入力を保存した同じ操作の中で確定する（保存と確定の間に隙間を作らない）。停止中は確定しない */
function withAutoCommit(
  saved: Session,
  events: SessionEvent[],
): SessionOutcome {
  if (
    saved.status === 'ACTIVE' &&
    saved.settings.commitMode === 'AUTO' &&
    allDecided(saved)
  ) {
    const committed = applyCommit(saved, 'AUTO');
    return {
      session: committed.session,
      events: [...events, ...committed.events],
    };
  }
  return { session: saved, events };
}

const allDecided = (session: Session) =>
  ROLES.every((r) => session.decisions[r] !== undefined);

/**
 * @guidedTour walking-skeleton 60 ルールの本体その 2。進行役だけが、4 役割の発注がそろい、週と版が一致するときだけ確定できる（確認した後に入力が変わったら拒否）。計算は `simulateWeek` に任せ、役割別の週結果を履歴に積む。
 */
export function commitWeek(
  session: Session,
  actor: Actor,
  request: { week: number; version: number },
): SessionOutcome {
  requireFacilitator(actor, '週の確定');
  requireActive(session);
  if (request.week !== session.week) {
    throw new StaleError(
      `現在の週は ${session.week} 週目です。要求の週が一致しません`,
    );
  }
  if (request.version !== session.version) {
    throw new StaleError(
      '確認した後に入力が変更されました（版が一致しません）。再読み込みしてください',
    );
  }
  const missing = ROLES.filter((r) => session.decisions[r] === undefined);
  if (missing.length > 0) {
    throw new DomainError(
      '4 役割の発注がそろっていないため、確定できません',
      missing.map((r) => ({
        problem: `${r} の発注がありません`,
        fix: `${r} の発注を入力してください`,
      })),
    );
  }
  return applyCommit(session, 'MANUAL');
}

/** 4 役割の発注がそろっている前提で、週を確定する（手動・自動で共通） */
function applyCommit(
  session: Session,
  kind: 'MANUAL' | 'AUTO',
): SessionOutcome {
  const orders = Object.fromEntries(
    ROLES.map((r) => [r, session.decisions[r]!.quantity]),
  ) as Record<Role, number>;
  const demand = session.settings.demand[session.week - 1] ?? 0;
  const { states, results } = simulateWeek(
    session.states,
    demand,
    orders,
    session.settings,
  );
  const record: WeekRecord = {
    week: session.week,
    commitKind: kind,
    roles: Object.fromEntries(
      ROLES.map((r) => [r, { ...results[r], order: orders[r] }]),
    ) as Record<Role, RoleWeekRecord>,
  };
  const ended = session.week >= session.settings.finalWeek;
  const next: Session = {
    ...session,
    status: ended ? 'ENDED' : 'ACTIVE',
    version: session.version + 1,
    week: ended ? session.week : session.week + 1,
    states,
    decisions: {},
    history: [...session.history, record],
  };
  const events: SessionEvent[] = [
    { type: 'WeekCommitted', sessionId: session.id, record },
  ];
  if (ended) events.push({ type: 'SessionEnded', sessionId: session.id });
  return { session: next, events };
}
