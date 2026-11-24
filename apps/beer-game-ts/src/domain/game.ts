import type { Actor } from './actor.js';
import {
  KIT_CONDITIONS,
  conditionsOf,
  kitPreset,
  type ConditionItem,
  type Conditions,
  type ConditionsInput,
} from './conditions.js';
import { ROLES, type Role } from './role.js';
import {
  AlreadyStartedError,
  DemandSeries,
  DisplayName,
  DomainError,
  type Issue,
  Money,
  NotPreparingError,
  ParticipantNotFoundError,
  PermissionError,
  StartConditionError,
  QUANTITY_MAX,
  Quantity,
  Version,
  Week,
} from './values.js';

export type CommitMode = 'MANUAL' | 'AUTO';

/** ゲームの設定。条件（初期在庫・遅延・費用単価・公開範囲）を含む */
export interface GameSettings extends Conditions {
  /** キット準拠か、カスタムか（条件と需要系列から導出する） */
  kind: 'KIT' | 'CUSTOM';
  /** キット準拠値から変更した項目 */
  changes: readonly ConditionItem[];
  finalWeek: number;
  demand: DemandSeries;
  quantityMax: number;
  /** 週の確定方式。AUTO は、全役割の発注がそろった保存で、同じ操作の中で確定する */
  commitMode: CommitMode;
}

export interface Participant {
  id: string;
  displayName: string;
}

export type GameStatus = 'PREPARING' | 'STARTED' | 'ENDED';

/** Game 集約（準備）。不変。操作は新しい Game とイベントを返す。
 *
 * @landmark 準備の集約。設定・参加者・役割の割り当てと、開始の条件（4 役割がそろう）を持つ。不変で、操作は新しい Game とイベントを返す。
 */
export interface Game {
  id: string;
  /** 参加コード。推測困難な乱数（生成は外側の層） */
  joinCode: string;
  status: GameStatus;
  version: number;
  settings: GameSettings;
  participants: readonly Participant[];
  /** 役割 → 担当の参加者 ID の一覧。同じ役割に複数人（共同担当）。1 人は高々 1 つの役割 */
  assignments: Readonly<Partial<Record<Role, readonly string[]>>>;
}

export type GameEvent =
  | {
      type: 'GameCreated';
      gameId: string;
      kind: GameSettings['kind'];
      changes: readonly ConditionItem[];
    }
  | { type: 'ParticipantJoined'; gameId: string; participantId: string }
  | { type: 'RoleAssigned'; gameId: string; participantId: string; role: Role }
  | { type: 'RoleUnassigned'; gameId: string; participantId: string }
  | { type: 'GameStarted'; gameId: string };

export interface Outcome {
  game: Game;
  events: GameEvent[];
}

export const KIT_HOLDING_COST_MINOR = KIT_CONDITIONS.holdingCostMinor;
export const KIT_BACKLOG_COST_MINOR = KIT_CONDITIONS.backlogCostMinor;

/** キットの既定の需要: 4 週は 4、5 週目から 8。 */
export function kitDemand(weeks: number): DemandSeries {
  return DemandSeries.create(
    Array.from({ length: weeks }, (_, i) => (i < 4 ? 4 : 8)),
    weeks,
  );
}

export function createGame(input: {
  id: string;
  joinCode: string;
  weeks: number;
  demand?: readonly number[];
  commitMode?: CommitMode;
  /** キット準拠値から変える条件（指定の無い項目はキットの値。初期在庫は、省略した役割がキットの値） */
  conditions?: ConditionsInput;
}): Outcome {
  // 入力の誤りは、最初の 1 つで止めず、すべて集めて示す（AC1.1.2。最終週・需要系列・条件）
  const issues: Issue[] = [];
  const collect = <T>(validate: () => T): T | undefined => {
    try {
      return validate();
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      issues.push(...e.issues);
      return undefined;
    }
  };
  const finalWeek = collect(() => weekOf(input.weeks));
  const kit = finalWeek === undefined ? undefined : kitDemand(finalWeek);
  const demand =
    finalWeek === undefined
      ? undefined
      : collect(() =>
          input.demand ? DemandSeries.create(input.demand, finalWeek) : kit!,
        );
  const conditions = collect(() => conditionsOf(input.conditions ?? {}));
  if (
    issues.length > 0 ||
    finalWeek === undefined ||
    kit === undefined ||
    demand === undefined ||
    conditions === undefined
  )
    throw new DomainError('入力に誤りがあります', issues);
  const { kind, changes } = kitPreset(
    conditions,
    demand.some((v, i) => v !== kit[i]),
  );
  const game: Game = {
    id: input.id,
    joinCode: input.joinCode,
    status: 'PREPARING',
    version: 0,
    settings: {
      ...conditions,
      kind,
      changes,
      finalWeek,
      demand,
      holdingCostMinor: Money.ofMinor(conditions.holdingCostMinor),
      backlogCostMinor: Money.ofMinor(conditions.backlogCostMinor),
      quantityMax: Quantity.of(QUANTITY_MAX),
      commitMode: input.commitMode ?? 'MANUAL',
    },
    participants: [],
    assignments: {},
  };
  return {
    game,
    events: [{ type: 'GameCreated', gameId: game.id, kind, changes }],
  };
}

/** 最終週（1〜50 の整数）。範囲外は、対象の項目（`finalWeek`）つきで拒否する */
function weekOf(value: number): Week {
  try {
    return Week.of(value);
  } catch (e) {
    if (e instanceof DomainError && e.issues.length === 0)
      throw new DomainError(e.message, [
        {
          field: 'finalWeek',
          problem: e.message,
          fix: '最終週を 1〜50 の整数にしてください',
        },
      ]);
    throw e;
  }
}

function requirePreparing(game: Game): void {
  if (game.status !== 'PREPARING') throw new NotPreparingError();
}

function requireFacilitator(actor: Actor): void {
  if (actor.kind !== 'FACILITATOR')
    throw new PermissionError('この操作は進行役だけができます');
}

const bump = (game: Game, patch: Partial<Game>): Game => ({
  ...game,
  ...patch,
  version: Version.next(Version.of(game.version)),
});

export function joinGame(
  game: Game,
  input: { participantId: string; displayName: string },
): Outcome {
  requirePreparing(game);
  if (game.participants.some((p) => p.id === input.participantId)) {
    throw new DomainError('すでに参加しています');
  }
  const next = bump(game, {
    participants: [
      ...game.participants,
      {
        id: input.participantId,
        displayName: DisplayName.of(input.displayName),
      },
    ],
  });
  return {
    game: next,
    events: [
      {
        type: 'ParticipantJoined',
        gameId: game.id,
        participantId: input.participantId,
      },
    ],
  };
}

export function assignRole(
  game: Game,
  actor: Actor,
  participantId: string,
  role: Role,
): Outcome {
  requireFacilitator(actor);
  requirePreparing(game);
  if (!game.participants.some((p) => p.id === participantId)) {
    throw new ParticipantNotFoundError(
      '参加していない人は、役割を割り当てられません',
    );
  }
  const current = roleOf(game, participantId);
  // 同じ役割への割り当て直しは、何も変わらない（イベントも版も足さない）
  if (current === role) return { game, events: [] };
  // 1 人に同時に複数の役割は持たせない（AC1.2.5）。別の役割にいる人は、付け替え（D9）として、
  // 移動元の RoleUnassigned と移動先の RoleAssigned にする
  const moved: Readonly<Partial<Record<Role, readonly string[]>>> =
    current === undefined
      ? game.assignments
      : (() => {
          const rest = (game.assignments[current] ?? []).filter(
            (id) => id !== participantId,
          );
          // 元の役割から外す（共同担当の残りがいれば、元の役割に残す。最後の 1 人なら、役割の項目ごと外す）
          const others = Object.fromEntries(
            Object.entries(game.assignments).filter(([r]) => r !== current),
          );
          return rest.length > 0 ? { ...others, [current]: rest } : others;
        })();
  return {
    game: bump(game, {
      assignments: {
        ...moved,
        [role]: [...(moved[role] ?? []), participantId],
      },
    }),
    events: [
      ...(current === undefined
        ? []
        : [
            {
              type: 'RoleUnassigned' as const,
              gameId: game.id,
              participantId,
            },
          ]),
      { type: 'RoleAssigned', gameId: game.id, participantId, role },
    ],
  };
}

export function unassignRole(
  game: Game,
  actor: Actor,
  participantId: string,
): Outcome {
  requireFacilitator(actor);
  requirePreparing(game);
  const kept = Object.entries(game.assignments)
    .map(
      ([role, ids]) =>
        [role, (ids ?? []).filter((id) => id !== participantId)] as const,
    )
    .filter(([, ids]) => ids.length > 0);
  return {
    game: bump(game, { assignments: Object.fromEntries(kept) }),
    events: [{ type: 'RoleUnassigned', gameId: game.id, participantId }],
  };
}

/** 参加者の役割（未割り当てなら undefined） */
export function roleOf(game: Game, participantId: string): Role | undefined {
  return ROLES.find((r) => game.assignments[r]?.includes(participantId));
}

export function missingRoles(game: Game): Role[] {
  return ROLES.filter((r) => (game.assignments[r]?.length ?? 0) === 0);
}

export function startGame(game: Game, actor: Actor): Outcome {
  requireFacilitator(actor);
  if (game.status !== 'PREPARING') throw new AlreadyStartedError();
  const missing = missingRoles(game);
  if (missing.length > 0) {
    throw new StartConditionError(
      '開始できません。役割が足りません',
      missing,
      missing.map((r) => ({
        problem: `${r} に参加者がいません`,
        fix: `${r} に参加者を割り当ててください`,
      })),
    );
  }
  return {
    game: bump(game, { status: 'STARTED' }),
    events: [{ type: 'GameStarted', gameId: game.id }],
  };
}
