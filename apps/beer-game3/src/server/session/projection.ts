import { ordersReceivedOf, receiptOf } from '../domain/engine.js';
import { ROLES, type GameStatus, type Role, type SetupKind } from '../domain/types.js';
import type { Principal } from '../access/access-control.js';
import { participantLabel } from './history.js';
import type { Snapshot, WeekRecordRow } from './store.js';
import { engineStateAtWeekStart } from './week-state.js';

export interface HistoryRow {
  week: number;
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  decision: number;
  weeklyCost: number;
  cumulativeCost: number;
}

/** 参加者に見せる、自分の役割の状況。 */
export interface MineView {
  role: Role;
  week: number;
  /** 当週の入荷（確定前から見える） */
  receipt: number;
  /** 当週の受注。小売店は当週の顧客需要（将来の需要は含めない） */
  ordersReceived: number;
  /** 前週末の在庫と受注残 */
  inventory: number;
  backlog: number;
  cumulativeCost: number;
  decision: number | null;
  /** decision を保存するたびに 1 増える。画面は、自分が最後に保存した版と違う版を受け取ると置き換わりに気づく（BR12.2） */
  decisionRevision: number;
  /** decision を最後に保存した主体。参加者ならラベル、進行役なら「進行役」。未入力は null */
  decidedBy: DecidedByView | null;
  history: HistoryRow[];
}

export interface DecidedByView {
  kind: 'participant' | 'facilitator';
  /** 「表示名 #参加順」。進行役のときは「進行役」（BR12.4） */
  label: string;
  /** kind が participant のとき入力した参加者 */
  participantId?: string;
}

/** ロビーや進行管理の参加者の 1 件。ラベルは常に参加順つき（BR12.4）。 */
export interface ParticipantItem {
  participantId?: string;
  displayName: string;
  joinOrder: number;
  label: string;
  /** 入れ替えで役割を離れた参加者は true */
  replaced: boolean;
}

/** 参加者が自分の役割について見る状況（入力値を含む）。 */
interface RoleOverview {
  decided: boolean;
  decision: number | null;
  receipt: number;
  ordersReceived: number;
  inventory: number;
  backlog: number;
  cumulativeCost: number;
}

/**
 * 進行役が見る役割ごとの状況。入力値の項目を持たない（BR14.2、NFR6.4）。
 * 型に項目が無いため、誤って含めることができない。
 */
export interface FacilitatorRoleOverview {
  decided: boolean;
  receipt: number;
  ordersReceived: number;
  inventory: number;
  backlog: number;
  cumulativeCost: number;
}

/** 呼び出した人ごとの投影（contract-summary.md の GameStateView）。 */
export interface GameStateView {
  gameId: string;
  name: string;
  status: GameStatus;
  currentWeek: number;
  weekCount: number;
  setupKind: SetupKind;
  /** 保存のたびに 1 増える。画面は版が変わったときだけ描画し直す */
  version: number;
  viewerKind: 'participant' | 'facilitator';
  /** ロビーの一覧。参加者には表示名と参加順の番号だけ */
  participants: ParticipantItem[];
  /** 4 役割のうち、当週の入力が済んだ数（どの役割かは参加者には示さない） */
  inputsDone: number;
  role?: Role;
  self?: { participantId: string; displayName: string; joinOrder: number };
  mine?: MineView;
  /** 進行役だけ: 割当て、役割ごとの状況、未割当ての役割、未入力の役割 */
  assignments?: Array<{ participantId: string; role: Role }>;
  /** 進行役だけ: 各役割の現在の担当者（ラベルと役割、BR14.1）。交代済みの人は含まない */
  assignees?: Array<{ participantId: string; label: string; role: Role }>;
  unassignedRoles?: Role[];
  roles?: Record<Role, FacilitatorRoleOverview>;
  missingInputRoles?: Role[];
}

function historyOf(records: WeekRecordRow[], role: Role): HistoryRow[] {
  return records
    .filter((r) => r.role === role && r.isConfirmed)
    .sort((a, b) => a.week - b.week)
    .map((r) => ({
      week: r.week,
      receipt: r.receipt ?? 0,
      ordersReceived: r.ordersReceived ?? 0,
      shipped: r.shipped ?? 0,
      inventory: r.inventory ?? 0,
      backlog: r.backlog ?? 0,
      decision: r.decision ?? 0,
      weeklyCost: r.weeklyCost ?? 0,
      cumulativeCost: r.cumulativeCost ?? 0,
    }));
}

/** 役割ごとの当週の状況。進行中は週の初めの状態から、終了後は最終週の確定済みの記録から求める。 */
function overviewOf(snapshot: Snapshot, role: Role): RoleOverview {
  const { game, settings, weekRecords, slots } = snapshot;
  const current = weekRecords.find((r) => r.week === game.currentWeek && r.role === role);
  if (game.status === 'ended' && current?.isConfirmed) {
    return {
      decided: true,
      decision: current.decision,
      receipt: current.receipt ?? 0,
      ordersReceived: current.ordersReceived ?? 0,
      inventory: current.inventory ?? 0,
      backlog: current.backlog ?? 0,
      cumulativeCost: current.cumulativeCost ?? 0,
    };
  }
  const state = engineStateAtWeekStart(settings, game.currentWeek, weekRecords, slots);
  const roleState = state.roles[role];
  const demand = settings.demandSeries[game.currentWeek - 1] ?? 0;
  return {
    decided: current?.decision !== null && current?.decision !== undefined,
    decision: current?.decision ?? null,
    receipt: receiptOf(role, roleState),
    ordersReceived: ordersReceivedOf(role, roleState, demand),
    inventory: roleState.inventory,
    backlog: roleState.backlog,
    cumulativeCost: roleState.cumulativeCost,
  };
}

/** 呼び出した人の投影だけを作る（ADR-002）。GameSession の内部の状態をそのまま返す経路は作らない。 */
export function projectState(snapshot: Snapshot, principal: Principal): GameStateView {
  const { game, weekRecords, participants, assignments } = snapshot;
  const started = game.status !== 'preparing';
  const currentRecords = started ? weekRecords.filter((r) => r.week === game.currentWeek) : [];
  const inputsDone = currentRecords.filter((r) => r.decision !== null).length;

  const base = {
    gameId: game.gameId,
    name: game.name,
    status: game.status,
    currentWeek: game.currentWeek,
    weekCount: game.weekCount,
    setupKind: game.setupKind,
    version: game.version,
    inputsDone,
  };

  if (principal.kind === 'facilitator') {
    const assignedRoles = new Set(assignments.map((a) => a.role));
    const roles = {} as Record<Role, FacilitatorRoleOverview>;
    if (started) {
      for (const role of ROLES) {
        const overview = overviewOf(snapshot, role);
        // 入力値（decision）は写さない。入力済みの真偽だけを持つ（BR14.2）
        roles[role] = {
          decided: overview.decided,
          receipt: overview.receipt,
          ordersReceived: overview.ordersReceived,
          inventory: overview.inventory,
          backlog: overview.backlog,
          cumulativeCost: overview.cumulativeCost,
        };
      }
    }
    const byId = new Map(participants.map((p) => [p.participantId, p]));
    return {
      ...base,
      viewerKind: 'facilitator',
      participants: participants.map((p) => ({
        participantId: p.participantId,
        displayName: p.displayName,
        joinOrder: p.joinOrder,
        label: participantLabel(p),
        replaced: p.replacedAt !== null,
      })),
      assignments: assignments.map((a) => ({ participantId: a.participantId, role: a.role })),
      assignees: assignments.flatMap((a) => {
        const person = byId.get(a.participantId);
        return person
          ? [{ participantId: a.participantId, label: participantLabel(person), role: a.role }]
          : [];
      }),
      unassignedRoles: ROLES.filter((role) => !assignedRoles.has(role)),
      ...(started ? { roles } : {}),
      missingInputRoles:
        game.status === 'running' || game.status === 'paused'
          ? ROLES.filter((role) => currentRecords.find((r) => r.role === role)?.decision === null)
          : [],
    };
  }

  const self = participants.find((p) => p.participantId === principal.participantId);
  const role = assignments.find((a) => a.participantId === principal.participantId)?.role;
  const view: GameStateView = {
    ...base,
    viewerKind: 'participant',
    participants: participants.map((p) => ({
      displayName: p.displayName,
      joinOrder: p.joinOrder,
      label: participantLabel(p),
      replaced: p.replacedAt !== null,
    })),
    ...(self
      ? {
          self: {
            participantId: self.participantId,
            displayName: self.displayName,
            joinOrder: self.joinOrder,
          },
        }
      : {}),
  };
  if (role) {
    view.role = role;
    if (started) {
      const overview = overviewOf(snapshot, role);
      const record = currentRecords.find((r) => r.role === role);
      view.mine = {
        role,
        week: game.currentWeek,
        receipt: overview.receipt,
        ordersReceived: overview.ordersReceived,
        inventory: overview.inventory,
        backlog: overview.backlog,
        cumulativeCost: overview.cumulativeCost,
        decision: overview.decision,
        decisionRevision: record?.decisionRevision ?? 0,
        decidedBy: decidedByOf(record, participants),
        history: historyOf(weekRecords, role),
      };
    }
  }
  return view;
}

/** 最後に入力した主体。参加者のときはラベル、進行役のときは「進行役」。 */
function decidedByOf(
  record: WeekRecordRow | undefined,
  participants: Snapshot['participants'],
): DecidedByView | null {
  if (!record || record.decisionRevision === 0 || record.decidedByKind === null) {
    return null;
  }
  if (record.decidedByKind === 'facilitator') {
    return { kind: 'facilitator', label: '進行役' };
  }
  const person = participants.find((p) => p.participantId === record.decidedByParticipantId);
  return person
    ? { kind: 'participant', label: participantLabel(person), participantId: person.participantId }
    : null;
}
