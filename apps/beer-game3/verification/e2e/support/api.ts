import { ROLES, ROLE_LABELS, type Role } from '../../shared/roles.js';
import { displayNameFor } from '../../shared/rng.js';

/**
 * 画面の試験の状態を作る補助。公開の API だけを使う（内部の関数や DB への直接の書き込みで作らない）。
 * 試験ごとに独立したゲームを作り、資格情報も試験ごとに生成する（試験の間で状態を共有しない）。
 * 表示名は架空の規則（displayNameFor）で作る。
 */

export interface GameCodes {
  gameId: string;
  joinCode: string;
  facilitatorCode: string;
  observerCode: string;
}

export interface Player {
  role: Role;
  participantId: string;
  token: string;
  displayName: string;
}

export interface RunningGame extends GameCodes {
  weekCount: number;
  players: Record<Role, Player>;
}

let counter = 0;
/** 同じプロセスの中で試験ごとに違う値を作る（表示名のチームの番号に使う。実在の語を使わない）。 */
export function nextTeamNumber(): number {
  counter += 1;
  return counter % 90;
}

async function request(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.key) {
    headers['idempotency-key'] = options.key;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const json: unknown = await response.json().catch(() => undefined);
  return { status: response.status, json };
}

async function must(
  label: string,
  result: { status: number; json: unknown },
): Promise<Record<string, unknown>> {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label}に失敗しました（状態 ${result.status}）`);
  }
  return (result.json ?? {}) as Record<string, unknown>;
}

let keySeed = 0;
function key(prefix: string): string {
  keySeed += 1;
  return `e2e-${prefix}-${Date.now().toString(36)}-${keySeed}`;
}

export async function createGame(
  baseUrl: string,
  options: { weekCount?: number; name?: string } = {},
): Promise<GameCodes> {
  const body = await must(
    'ゲームの作成',
    await request(baseUrl, 'POST', '/api/games', {
      body: {
        name: options.name ?? displayNameFor(nextTeamNumber(), 'ゲーム'),
        weekCount: options.weekCount ?? 3,
      },
    }),
  );
  const codes = body.codes as { joinCode: string; facilitatorCode: string; observerCode: string };
  return {
    gameId: String(body.gameId),
    joinCode: codes.joinCode,
    facilitatorCode: codes.facilitatorCode,
    observerCode: codes.observerCode,
  };
}

export async function join(
  baseUrl: string,
  game: GameCodes,
  displayName: string,
): Promise<{ participantId: string; token: string }> {
  const body = await must(
    '参加',
    await request(baseUrl, 'POST', '/api/games/join', {
      body: { joinCode: game.joinCode, displayName },
    }),
  );
  return { participantId: String(body.participantId), token: String(body.token) };
}

export async function assign(
  baseUrl: string,
  game: GameCodes,
  participantId: string,
  role: Role,
): Promise<void> {
  await must(
    '役割の割当て',
    await request(baseUrl, 'PUT', `/api/games/${game.gameId}/assignments/${participantId}`, {
      token: game.facilitatorCode,
      body: { role },
    }),
  );
}

/** 準備中のゲーム: 4 人が参加している。assigned が false なら、割当てをしない（ロビーの未割当ての状態）。 */
export async function bootLobbyGame(
  baseUrl: string,
  options: { weekCount?: number; assigned?: boolean } = {},
): Promise<RunningGame> {
  const game = await createGame(baseUrl, options);
  const team = nextTeamNumber();
  const players = {} as Record<Role, Player>;
  for (const role of ROLES) {
    const displayName = displayNameFor(team, ROLE_LABELS[role]);
    const joined = await join(baseUrl, game, displayName);
    if (options.assigned !== false) {
      await assign(baseUrl, game, joined.participantId, role);
    }
    players[role] = { role, displayName, ...joined };
  }
  return { ...game, weekCount: options.weekCount ?? 3, players };
}

export async function startGame(baseUrl: string, game: GameCodes): Promise<void> {
  await must(
    '開始',
    await request(baseUrl, 'POST', `/api/games/${game.gameId}/start`, {
      token: game.facilitatorCode,
    }),
  );
}

export async function bootRunningGame(
  baseUrl: string,
  options: { weekCount?: number } = {},
): Promise<RunningGame> {
  const game = await bootLobbyGame(baseUrl, options);
  await startGame(baseUrl, game);
  return game;
}

export async function submitWeek(
  baseUrl: string,
  game: RunningGame,
  week: number,
  quantity = 4,
): Promise<void> {
  for (const role of ROLES) {
    await must(
      `第 ${week} 週の入力`,
      await request(baseUrl, 'PUT', `/api/games/${game.gameId}/weeks/${week}/decisions/${role}`, {
        token: game.players[role].token,
        body: { quantity },
        key: key(`in-${role}-${week}`),
      }),
    );
  }
}

export async function confirmWeek(baseUrl: string, game: RunningGame, week: number): Promise<void> {
  await must(
    `第 ${week} 週の確定`,
    await request(baseUrl, 'POST', `/api/games/${game.gameId}/weeks/${week}/confirm`, {
      token: game.facilitatorCode,
      key: key(`confirm-${week}`),
    }),
  );
}

export async function playWeek(baseUrl: string, game: RunningGame, week: number): Promise<void> {
  await submitWeek(baseUrl, game, week);
  await confirmWeek(baseUrl, game, week);
}

export async function pauseGame(baseUrl: string, game: GameCodes): Promise<void> {
  await must(
    '一時停止',
    await request(baseUrl, 'POST', `/api/games/${game.gameId}/pause`, {
      token: game.facilitatorCode,
    }),
  );
}

export async function endGame(baseUrl: string, game: GameCodes): Promise<void> {
  await must(
    '終了',
    await request(baseUrl, 'POST', `/api/games/${game.gameId}/end`, {
      token: game.facilitatorCode,
    }),
  );
}

/** 全週を確定して、ゲームを終了させる（結果と出力の状態）。 */
export async function playUntilEnded(baseUrl: string, game: RunningGame): Promise<void> {
  for (let week = 1; week <= game.weekCount; week += 1) {
    await playWeek(baseUrl, game, week);
  }
}
