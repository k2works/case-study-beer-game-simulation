import type { Application } from '../../src/application/index.js';
import { ROLES, type Role } from '../../src/domain/role.js';

/** 契約テストの前提のゲーム。HTTP を通さずに、アプリケーションで用意する（契約テストは、読み取りの応答を検証する） */
export interface Table {
  gameId: string;
  joinCode: string;
  /** 進行役のブラウザセッションの資格（Cookie `bg_session` の値） */
  facilitator: string;
  players: Record<Role, { token: string; participantId: string }>;
}

/** 4 人が参加し、4 役割にそろって割り当てられている（開始前） */
export async function preparedTable(
  app: Application,
  options: { weeks?: number; demand?: number[] } = {},
): Promise<Table> {
  const weeks = options.weeks ?? 2;
  const created = await app.createGame({
    weeks,
    demand: options.demand ?? Array.from({ length: weeks }, () => 4),
  });
  const players = {} as Table['players'];
  for (const role of ROLES) {
    const joined = await app.joinGame({
      joinCode: created.joinCode,
      displayName: `参加者-${role}`,
    });
    await app.assignRole({
      token: created.facilitatorToken,
      gameId: created.gameId,
      participantId: joined.participantId,
      role,
    });
    players[role] = {
      token: joined.token,
      participantId: joined.participantId,
    };
  }
  return {
    gameId: created.gameId,
    joinCode: created.joinCode,
    facilitator: created.facilitatorToken,
    players,
  };
}

export async function startedTable(
  app: Application,
  options: { weeks?: number; demand?: number[] } = {},
): Promise<Table> {
  const table = await preparedTable(app, options);
  await app.startGame({ token: table.facilitator, gameId: table.gameId });
  return table;
}

/** 4 役割が当週の発注を保存する */
export async function saveAll(
  app: Application,
  table: Table,
  quantity = 4,
): Promise<void> {
  for (const role of ROLES) {
    await app.saveDecision({
      token: table.players[role].token,
      gameId: table.gameId,
      role,
      quantity,
      expectedVersion: 0,
    });
  }
}

/** 当週を、全役割が保存してから、進行役が確定する */
export async function playWeek(
  app: Application,
  table: Table,
  week: number,
  quantity = 4,
): Promise<void> {
  await saveAll(app, table, quantity);
  const { sessionVersion } = await app.console({
    token: table.facilitator,
    gameId: table.gameId,
  });
  await app.commitWeek({
    token: table.facilitator,
    gameId: table.gameId,
    week,
    version: sessionVersion,
    idempotencyKey: `week-${week}`,
  });
}

/** 最終週まで確定して、ゲームが終了している */
export async function endedTable(
  app: Application,
  options: { weeks?: number; demand?: number[] } = {},
): Promise<Table> {
  const weeks = options.weeks ?? 2;
  const table = await startedTable(app, { ...options, weeks });
  for (let week = 1; week <= weeks; week++) await playWeek(app, table, week);
  return table;
}

/** 観察者として参加し、観察者の資格を返す */
export async function observerOf(
  app: Application,
  table: Table,
): Promise<string> {
  const issued = await app.issueObserverInvitation({
    token: table.facilitator,
    gameId: table.gameId,
  });
  const joined = await app.joinAsObserver({
    code: issued.code,
    displayName: '見学者',
  });
  return joined.token;
}
