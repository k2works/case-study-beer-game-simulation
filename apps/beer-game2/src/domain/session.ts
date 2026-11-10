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

export type SessionStatus = 'ACTIVE' | 'ENDED';

export interface Decision {
  quantity: number;
  /** 役割ごとの版。古い版の更新を拒否し、変更を黙って失わない */
  version: number;
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

/** Session 集約（進行）。不変。操作は新しい Session とイベントを返す。 */
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
  | { type: 'WeekCommitted'; sessionId: string; record: WeekRecord }
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

function requireActive(session: Session): void {
  if (session.status !== 'ACTIVE')
    throw new DomainError('このゲームは終了しています');
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
    throw new PermissionError('進行役の代理入力は、この版では使えません');
  }
  if (session.holders[role] !== actor.participantId) {
    throw new PermissionError(
      `${role} の担当ではないため、発注を保存できません`,
    );
  }
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
    savedBy: actor.participantId,
  };
  const saved: Session = {
    ...session,
    version: session.version + 1,
    decisions: { ...session.decisions, [role]: decision },
  };
  const events: SessionEvent[] = [
    {
      type: 'DecisionSaved',
      sessionId: session.id,
      role,
      quantity: value,
      savedBy: actor.participantId,
      version: decision.version,
    },
  ];
  // 自動確定: 最後の発注を保存した同じ操作の中で確定する（保存と確定の間に隙間を作らない）
  if (session.settings.commitMode === 'AUTO' && allDecided(saved)) {
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
  if (actor.kind !== 'FACILITATOR')
    throw new PermissionError('週の確定は進行役だけができます');
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
