import type { Clock, RandomSource } from '../clock.js';
import { Reporting, type ExportFile } from '../reporting/reporting.js';
import type { ResultsView } from '../reporting/results.js';
import { GameSession } from '../session/game-session.js';
import type { Store } from '../session/store.js';
import { AccessControl, type Principal } from './access-control.js';
import type { KeyRing } from './keys.js';
import type { AccessPolicy } from './policy.js';

/**
 * 入口から GameSession を呼ぶ唯一の経路（BR19.2）。
 * 入口（src/server/http）は GameSession を import できない（lint と構造の試験）。
 * ここで操作ごとに AccessControl の権限の判定を行ってから GameSession を呼ぶ。
 * 入口の onRequest でも同じ判定を先に行う（本文の解析より前に 403 を返すため）。判定は純粋な関数で、二重でも副作用はない。
 */
export class SessionGateway {
  constructor(
    private readonly access: AccessControl,
    private readonly session: GameSession,
    private readonly reporting: Reporting,
  ) {}

  createGame(body: unknown) {
    return this.session.createGame(body);
  }

  /** 参加。verifiedGameId は、入口が参加の窓の中で検証した参加コードのゲーム（BR18）。 */
  joinGame(body: unknown, verifiedGameId?: string) {
    return this.session.joinGame(body, verifiedGameId);
  }

  getState(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'viewState', { gameId });
    return this.session.getState(principal, gameId);
  }

  getCodes(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'getCodes', { gameId });
    return this.session.getCodes(principal, gameId);
  }

  assignRole(principal: Principal | null, gameId: string, participantId: string, role: unknown) {
    this.access.authorize(principal, 'assignRole', { gameId });
    return this.session.assignRole(principal, gameId, participantId, role);
  }

  startGame(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'startGame', { gameId });
    return this.session.startGame(principal, gameId);
  }

  submitDecision(
    principal: Principal | null,
    gameId: string,
    week: number,
    role: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ) {
    this.access.authorize(principal, 'submitDecision', { gameId, role });
    return this.session.submitDecision(principal, gameId, week, role, body, idempotencyKey);
  }

  confirmWeek(
    principal: Principal | null,
    gameId: string,
    week: number,
    idempotencyKey: string | undefined,
  ) {
    this.access.authorize(principal, 'confirmWeek', { gameId });
    return this.session.confirmWeek(principal, gameId, week, idempotencyKey);
  }

  pauseGame(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'pauseGame', { gameId });
    return this.session.pauseGame(principal, gameId);
  }

  resumeGame(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'resumeGame', { gameId });
    return this.session.resumeGame(principal, gameId);
  }

  endGame(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'endGame', { gameId });
    return this.session.endGame(principal, gameId);
  }

  replaceAssignee(principal: Principal | null, gameId: string, role: string, body: unknown) {
    this.access.authorize(principal, 'replaceAssignee', { gameId, role });
    return this.session.replaceAssignee(principal, gameId, role, body);
  }

  getHistory(principal: Principal | null, gameId: string) {
    this.access.authorize(principal, 'getHistory', { gameId });
    return this.session.getHistory(principal, gameId);
  }

  /** 終了後の結果。参加者と進行役だけ（BR21.2）。読み取りだけで、GameSession の書き込みを通らない（BR21.5）。 */
  viewResults(principal: Principal | null, gameId: string): Promise<ResultsView> {
    this.access.requireResultsViewer(principal, gameId);
    return this.reporting.results(gameId);
  }

  /** 結果の出力（csv または json）。進行役だけ、終了後だけ（BR23.1）。 */
  exportGame(principal: Principal | null, gameId: string, format: unknown): Promise<ExportFile> {
    this.access.requireExporter(principal, gameId);
    return this.reporting.exportGame(gameId, format);
  }
}

export interface ServicesDeps {
  store: Store;
  keyRing: KeyRing;
  clock: Clock;
  random: RandomSource;
  policy?: Partial<AccessPolicy>;
}

/**
 * AccessControl と、GameSession への唯一の経路を組み立てる。
 * session は、入口以外（起動を組み立てる main.ts の定期処理）が内部から呼ぶための口で、入口は使わない。
 */
export function createServices(deps: ServicesDeps): {
  access: AccessControl;
  gateway: SessionGateway;
  session: GameSession;
} {
  const access = new AccessControl({
    store: deps.store,
    keyRing: deps.keyRing,
    random: deps.random,
    clock: deps.clock,
    ...(deps.policy ? { policy: deps.policy } : {}),
  });
  const session = new GameSession({
    store: deps.store,
    access,
    clock: deps.clock,
    random: deps.random,
  });
  const reporting = new Reporting({ store: deps.store });
  return { access, gateway: new SessionGateway(access, session, reporting), session };
}
