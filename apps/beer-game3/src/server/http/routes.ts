import type { Action } from '../access/access-control.js';

export type RouteId =
  | 'health'
  | 'me'
  | 'createGame'
  | 'joinGame'
  | 'getState'
  | 'getCodes'
  | 'assignRole'
  | 'startGame'
  | 'submitDecision'
  | 'confirmWeek'
  | 'pauseGame'
  | 'resumeGame'
  | 'endGame'
  | 'replaceAssignee'
  | 'getHistory'
  | 'viewResults'
  | 'exportGame';

export interface RouteSpec {
  id: RouteId;
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  /** 必要な操作（操作の表）。public は資格情報なしで呼べる（作成、参加、ヘルスチェック） */
  action: Action | 'public';
}

/**
 * 経路の表（BR19.3、NFR6.8）。入口はこの表から経路を登録する。表に無い経路が登録されると起動が失敗し、
 * 網羅試験（tests/u4）は、この表の全行について、無資格・別のゲーム・別の役割・観察者の拒否を確かめる。
 */
export const routeCatalog: readonly RouteSpec[] = [
  { id: 'health', method: 'GET', url: '/health', action: 'public' },
  { id: 'me', method: 'GET', url: '/api/me', action: 'identify' },
  { id: 'createGame', method: 'POST', url: '/api/games', action: 'public' },
  { id: 'joinGame', method: 'POST', url: '/api/games/join', action: 'public' },
  { id: 'getState', method: 'GET', url: '/api/games/:gameId/state', action: 'viewState' },
  { id: 'getCodes', method: 'GET', url: '/api/games/:gameId/codes', action: 'getCodes' },
  {
    id: 'assignRole',
    method: 'PUT',
    url: '/api/games/:gameId/assignments/:participantId',
    action: 'assignRole',
  },
  { id: 'startGame', method: 'POST', url: '/api/games/:gameId/start', action: 'startGame' },
  {
    id: 'submitDecision',
    method: 'PUT',
    url: '/api/games/:gameId/weeks/:week/decisions/:role',
    action: 'submitDecision',
  },
  {
    id: 'confirmWeek',
    method: 'POST',
    url: '/api/games/:gameId/weeks/:week/confirm',
    action: 'confirmWeek',
  },
  { id: 'pauseGame', method: 'POST', url: '/api/games/:gameId/pause', action: 'pauseGame' },
  { id: 'resumeGame', method: 'POST', url: '/api/games/:gameId/resume', action: 'resumeGame' },
  { id: 'endGame', method: 'POST', url: '/api/games/:gameId/end', action: 'endGame' },
  {
    id: 'replaceAssignee',
    method: 'POST',
    url: '/api/games/:gameId/roles/:role/replacement',
    action: 'replaceAssignee',
  },
  { id: 'getHistory', method: 'GET', url: '/api/games/:gameId/history', action: 'getHistory' },
  { id: 'viewResults', method: 'GET', url: '/api/games/:gameId/results', action: 'viewResults' },
  { id: 'exportGame', method: 'GET', url: '/api/games/:gameId/export', action: 'exportGame' },
];

export interface RegisteredRoute {
  method: string;
  url: string;
}

/** 登録された経路のうち、表に無いものを返す。空なら差が無い。 */
export function findUncatalogedRoutes(
  registered: readonly RegisteredRoute[],
  catalog: readonly RouteSpec[],
): RegisteredRoute[] {
  const known = new Set(catalog.map((row) => `${row.method} ${row.url}`));
  return registered.filter((route) => !known.has(`${route.method} ${route.url}`));
}

/** API の経路か（表の対象か）。画面の配信の経路は対象にしない。 */
export function isGuardedUrl(url: string): boolean {
  return url === '/health' || url.startsWith('/api');
}
