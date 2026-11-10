import type { Actor } from './actor.js';
import { ROLES, type Role } from './role.js';
import {
  DemandSeries,
  DisplayName,
  DomainError,
  Money,
  PermissionError,
  QUANTITY_MAX,
  Quantity,
  Version,
  Week,
} from './values.js';

export type CommitMode = 'MANUAL' | 'AUTO';

export interface GameSettings {
  /** キット準拠か、カスタムか（カスタムは Bolt 6） */
  kind: 'KIT';
  finalWeek: number;
  demand: DemandSeries;
  holdingCostMinor: number;
  backlogCostMinor: number;
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
  /** 役割 → 参加者 ID（この Bolt では 1 役割 1 人） */
  assignments: Readonly<Partial<Record<Role, string>>>;
}

export type GameEvent =
  | { type: 'GameCreated'; gameId: string; kind: GameSettings['kind'] }
  | { type: 'ParticipantJoined'; gameId: string; participantId: string }
  | { type: 'RoleAssigned'; gameId: string; participantId: string; role: Role }
  | { type: 'RoleUnassigned'; gameId: string; participantId: string }
  | { type: 'GameStarted'; gameId: string };

export interface Outcome {
  game: Game;
  events: GameEvent[];
}

export const KIT_HOLDING_COST_MINOR = 50;
export const KIT_BACKLOG_COST_MINOR = 100;

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
}): Outcome {
  const finalWeek = Week.of(input.weeks);
  const demand = input.demand
    ? DemandSeries.create(input.demand, finalWeek)
    : kitDemand(finalWeek);
  const game: Game = {
    id: input.id,
    joinCode: input.joinCode,
    status: 'PREPARING',
    version: 0,
    settings: {
      kind: 'KIT',
      finalWeek,
      demand,
      holdingCostMinor: Money.ofMinor(KIT_HOLDING_COST_MINOR),
      backlogCostMinor: Money.ofMinor(KIT_BACKLOG_COST_MINOR),
      quantityMax: Quantity.of(QUANTITY_MAX),
      commitMode: input.commitMode ?? 'MANUAL',
    },
    participants: [],
    assignments: {},
  };
  return {
    game,
    events: [{ type: 'GameCreated', gameId: game.id, kind: 'KIT' }],
  };
}

function requirePreparing(game: Game): void {
  if (game.status !== 'PREPARING')
    throw new DomainError('このゲームは参加の受付を終了しています');
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
    throw new DomainError('参加していない人は、役割を割り当てられません');
  }
  const current = ROLES.find((r) => game.assignments[r] === participantId);
  if (current !== undefined) {
    throw new DomainError(
      `この参加者はすでに ${current} です。1 人に複数の役割は割り当てられません`,
      [
        {
          problem: `${current} に割り当て済みです`,
          fix: '先に割り当てを解除してください',
        },
      ],
    );
  }
  const holder = game.assignments[role];
  if (holder !== undefined && holder !== participantId) {
    throw new DomainError(`${role} はすでに割り当て済みです`);
  }
  return {
    game: bump(game, {
      assignments: { ...game.assignments, [role]: participantId },
    }),
    events: [{ type: 'RoleAssigned', gameId: game.id, participantId, role }],
  };
}

export function unassignRole(
  game: Game,
  actor: Actor,
  participantId: string,
): Outcome {
  requireFacilitator(actor);
  requirePreparing(game);
  const kept = Object.entries(game.assignments).filter(
    ([, id]) => id !== participantId,
  );
  return {
    game: bump(game, { assignments: Object.fromEntries(kept) }),
    events: [{ type: 'RoleUnassigned', gameId: game.id, participantId }],
  };
}

export function missingRoles(game: Game): Role[] {
  return ROLES.filter((r) => game.assignments[r] === undefined);
}

export function startGame(game: Game, actor: Actor): Outcome {
  requireFacilitator(actor);
  if (game.status !== 'PREPARING')
    throw new DomainError('このゲームはすでに開始されています');
  const missing = missingRoles(game);
  if (missing.length > 0) {
    throw new DomainError(
      '開始できません。役割が足りません',
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
