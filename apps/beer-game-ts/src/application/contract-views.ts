import {
  changedSettingsOf,
  disclosureNameOf,
  settingsKindOf,
} from '../domain/contract-settings.js';
import type { Game } from '../domain/game.js';
import { MIN_CONTRIBUTORS } from '../domain/observation.js';
import type { ReviewRow } from '../domain/review.js';
import { RETENTION } from '../domain/retention.js';
import { downstreamOf, ROLES, type Role } from '../domain/role.js';
import {
  PROXY_OPERATOR,
  type Decision,
  type Session,
} from '../domain/session.js';

/**
 * 共有の API の契約（apps/beer-game-contracts/openapi.yaml）の、読み取りの投影の形。
 * ここは、集約・ポートから取り出した値を、契約の形に並べるだけの純粋な関数（時刻・DB・認可に依存しない）。
 * 誰に何を見せるか（開示の判定）は、呼び出す側のユースケースが決めて、ここには、見せてよい値だけを渡す。
 */

/** 追記後のストリームごとの版。そのストリームが無い（セッションが未作成など）なら null */
export interface StreamVersions {
  game: number | null;
  session: number | null;
}

export const versionsOf = (
  game: Game | null,
  session: Session | null,
): StreamVersions => ({
  game: game?.version ?? null,
  session: session?.version ?? null,
});

/** 呼び出した人（見せる値を決める側が、資格から作る） */
export type Viewer =
  { kind: 'FACILITATOR' } | { kind: 'PARTICIPANT'; participantId: string };

const roleOfParticipant = (game: Game, participantId: string): Role | null =>
  ROLES.find((r) => game.assignments[r]?.includes(participantId)) ?? null;

/** 設定の種別と、キットの値から変えた項目 */
export const settingsOf = (game: Game) => ({
  settingsKind: settingsKindOf(game.settings.changes),
  changedSettings: changedSettingsOf(game.settings.changes),
});

export function gameStateView(
  game: Game,
  viewer: Viewer | null,
  versions: StreamVersions,
) {
  const role =
    viewer?.kind === 'PARTICIPANT'
      ? roleOfParticipant(game, viewer.participantId)
      : null;
  return {
    gameId: game.id,
    // このゲームでは sessionId は gameId と同じ。開始前は null
    sessionId: game.status === 'PREPARING' ? null : game.id,
    status: game.status,
    ...settingsOf(game),
    commitMode: game.settings.commitMode,
    ...(viewer?.kind === 'FACILITATOR'
      ? { joinCode: game.joinCode, finalWeek: game.settings.finalWeek }
      : {}),
    ...(viewer?.kind === 'PARTICIPANT'
      ? { participantId: viewer.participantId, ...(role ? { role } : {}) }
      : {}),
    versions,
  };
}

export interface LobbyInvitationRow {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface LobbyObserverRow {
  id: string;
  displayName: string;
  joinedAt: Date;
}

export function lobbyView(
  game: Game,
  invitations: readonly LobbyInvitationRow[],
  observers: readonly LobbyObserverRow[],
  versions: StreamVersions,
) {
  return {
    gameId: game.id,
    status: game.status,
    joinCode: game.joinCode,
    ...settingsOf(game),
    commitMode: game.settings.commitMode,
    participants: game.participants.map((p) => ({
      participantId: p.id,
      displayName: p.displayName,
      role: roleOfParticipant(game, p.id),
      ...(p.replaced ? { replaced: true } : {}),
    })),
    invitations: invitations.map((i) => ({
      invitationId: i.id,
      expiresAt: i.expiresAt.toISOString(),
      revoked: i.revokedAt !== null,
      createdAt: i.createdAt.toISOString(),
    })),
    observers: observers.map((o) => ({
      observerId: o.id,
      displayName: o.displayName,
      joinedAt: o.joinedAt.toISOString(),
    })),
    versions,
  };
}

/** 入力を最後に保存した人。表示名は、見る人が同じ役割の担当か進行役のときだけ渡される前提（呼び出す側が判定する） */
function editorView(
  d: Decision,
  viewer: Viewer,
  names: Readonly<Record<string, string>>,
) {
  return d.savedBy === PROXY_OPERATOR
    ? {
        kind: 'FACILITATOR_PROXY' as const,
        displayName: null,
        isSelf: viewer.kind === 'FACILITATOR',
      }
    : {
        kind: 'PARTICIPANT' as const,
        displayName: names[d.savedBy] ?? null,
        isSelf:
          viewer.kind === 'PARTICIPANT' && viewer.participantId === d.savedBy,
      };
}

/** 契約の `DecisionEntry`。保存済みの入力（数量・版・最後の保存者・保存の時刻）。保存の時刻が無い（未永続）なら `fallbackAt` */
export function decisionEntryView(
  d: Decision,
  viewer: Viewer,
  names: Readonly<Record<string, string>>,
  fallbackAt: Date,
) {
  return {
    quantity: d.quantity,
    version: d.version,
    editor: editorView(d, viewer, names),
    savedAt: (d.savedAt ?? fallbackAt).toISOString(),
  };
}
export type DecisionEntryView = ReturnType<typeof decisionEntryView>;

/** 役割別の状況。当週の入荷・受注・入力。将来の週の需要は、どの役割にも含めない */
export function roleStatusView(
  session: Session,
  role: Role,
  viewer: Viewer,
  names: Readonly<Record<string, string>>,
) {
  const state = session.states[role];
  const decision = session.decisions[role];
  const downstream = downstreamOf(role);
  const active = session.status !== 'ENDED';
  // 当週の受注: 小売店は顧客の需要、ほかは下流が送った発注（届くのは先頭の 1 つ）
  const customerDemand = active
    ? (session.settings.demand[session.week - 1] ?? 0)
    : 0;
  const orders = downstream
    ? (session.states[downstream].outgoingOrders[0] ?? 0)
    : customerDemand;
  return {
    inventory: state.inventory,
    backlog: state.backlog,
    arrivals: state.incomingGoods[0] ?? 0,
    orders,
    ...(role === 'RETAILER' && active ? { customerDemand } : {}),
    decision: decision?.quantity ?? null,
    decisionVersion: decision?.version ?? 0,
    decisionEditor: decision ? editorView(decision, viewer, names) : null,
    decisionSavedAt: decision?.savedAt?.toISOString() ?? null,
  };
}

/** 確定した週の、役割別の結果（週の昇順、役割は上流から下流） */
export function resultsView(session: Session) {
  return session.history.flatMap((record) =>
    ROLES.map((role) => {
      const r = record.roles[role];
      return {
        role,
        week: record.week,
        orders: r.demand,
        order: r.order,
        inventory: r.endingInventory,
        backlog: r.endingBacklog,
        shipment: r.shipped,
        cost: r.weeklyCostMinor,
        cumulativeCost: r.cumulativeCostMinor,
      };
    }),
  );
}

export function sessionStateView(
  session: Session,
  viewer: Viewer,
  names: Readonly<Record<string, string>>,
  versions: StreamVersions,
) {
  const base = {
    sessionId: session.gameId,
    status: session.status,
    week: session.week,
    submittedRoleCount: ROLES.filter((r) => session.decisions[r] !== undefined)
      .length,
    versions,
  };
  if (viewer.kind === 'FACILITATOR') {
    return {
      ...base,
      finalWeek: session.settings.finalWeek,
      roles: Object.fromEntries(
        ROLES.map((r) => [r, roleStatusView(session, r, viewer, names)]),
      ),
      results: resultsView(session),
    };
  }
  const role = ROLES.find((r) =>
    session.holders[r].includes(viewer.participantId),
  );
  if (!role) return null;
  return {
    ...base,
    participantId: viewer.participantId,
    role,
    roleStatus: roleStatusView(session, role, viewer, names),
    // 同じ役割の共同担当（自分を含む）。参加者の ID は含めない
    coHolders: session.holders[role].map((id) => ({
      displayName: names[id] ?? null,
      isSelf: id === viewer.participantId,
    })),
  };
}

/** 観察。現在週・入力済みの役割数・確定した週のチーム合計だけ。役割別の値・将来の需要・入力者を含まない */
export function observationView(
  game: Game,
  session: Session | null,
  versions: StreamVersions,
) {
  const policy = disclosureNameOf(game.settings.disclosure);
  const weeks =
    policy === 'NONE' || !session
      ? []
      : session.history.map((record) => {
          const values = ROLES.map((r) => record.roles[r]);
          // 寄与者が足りない週は、値を出さない（1 役割だけの合計は、個別の値そのものになる）
          if (values.length < MIN_CONTRIBUTORS) {
            return {
              week: record.week,
              hidden: true,
              reason: 'CONTRIBUTORS_BELOW_MINIMUM' as const,
            };
          }
          const sum = (pick: (v: (typeof values)[number]) => number) =>
            values.reduce((a, v) => a + pick(v), 0);
          return {
            week: record.week,
            order: sum((v) => v.order),
            inventory: sum((v) => v.endingInventory),
            backlog: sum((v) => v.endingBacklog),
          };
        });
  return {
    gameId: game.id,
    status: game.status,
    finalWeek: game.settings.finalWeek,
    ...(session
      ? {
          sessionStatus: session.status,
          week: session.week,
          submittedRoleCount: ROLES.filter(
            (r) => session.decisions[r] !== undefined,
          ).length,
        }
      : {}),
    totals: {
      policy,
      ...(policy === 'NONE'
        ? { hiddenReason: 'DISCLOSURE_NONE' as const }
        : {}),
      weeks,
    },
    versions,
  };
}

/** 終了後の振り返り。全役割の全週の結果を、週・役割（上流から下流）の順に並べる */
export function reviewView(
  game: Game,
  rows: readonly ReviewRow[],
  versions: StreamVersions,
) {
  const roleIndex = (r: Role) => ROLES.indexOf(r);
  return {
    gameId: game.id,
    finalWeek: game.settings.finalWeek,
    ...settingsOf(game),
    commitMode: game.settings.commitMode,
    results: [...rows]
      .sort((a, b) => a.week - b.week || roleIndex(a.role) - roleIndex(b.role))
      .map((r) => ({
        role: r.role,
        week: r.week,
        orders: r.demand,
        order: r.order,
        inventory: r.endingInventory,
        backlog: r.endingBacklog,
        shipment: r.shipped,
        cost: r.weeklyCostMinor,
        cumulativeCost: r.cumulativeCostMinor,
      })),
    versions,
  };
}

/**
 * 保持状態。削除が完了したゲームは、記録ごと無くなるので、完了の状態は無い。
 * 再試行は、定期のタスクの次の実行で行い、時刻は定まらない（指数の待ちは持たない）ので、`nextAttemptAt` は null。
 * 失敗の分類（`lastFailureCode`）は、記録していないので null。
 */
export function retentionStateView(
  policy: { days: number; deleteAfter: Date },
  progress: { startsAt: Date; attempts: number },
) {
  const status =
    progress.attempts >= RETENTION.maxAttempts
      ? ('ABANDONED' as const)
      : progress.attempts > 0
        ? ('RETRY_PENDING' as const)
        : ('SCHEDULED' as const);
  return {
    retentionDays: policy.days,
    startsAt: progress.startsAt.toISOString(),
    deleteAfter: policy.deleteAfter.toISOString(),
    status,
    attempt: progress.attempts,
    nextAttemptAt: null,
    lastFailureCode: null,
    backupRetentionDays: RETENTION.backupDays,
  };
}
