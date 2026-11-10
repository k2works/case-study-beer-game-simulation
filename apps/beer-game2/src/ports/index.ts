import type { Game } from '../domain/game.js';
import type { Session } from '../domain/session.js';

/** 版が古い、または既に存在する。呼び出し側は競合として扱う */
export class ConflictError extends Error {
  constructor(message = '他の操作で更新されています') {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface GameRepository {
  find(id: string): Promise<Game | null>;
  findByJoinCode(joinCode: string): Promise<Game | null>;
  /** expectedVersion が null なら新規。版が合わなければ ConflictError */
  save(game: Game, expectedVersion: number | null): Promise<void>;
}

export interface SessionRepository {
  findByGame(gameId: string): Promise<Session | null>;
  save(session: Session, expectedVersion: number | null): Promise<void>;
}

/** 資格（Cookie の値）に対応する主体。生の資格は保存せず、ダイジェストだけを持つ */
export interface Principal {
  gameId: string;
  kind: 'FACILITATOR' | 'PARTICIPANT';
  participantId?: string;
}
export interface CredentialRepository {
  save(digest: string, principal: Principal): Promise<void>;
  find(digest: string): Promise<Principal | null>;
}

export interface IdempotencyRecord {
  gameId: string;
  key: string;
  /** 要求の指紋。同じキーで内容が違えば競合 */
  fingerprint: string;
  response: unknown;
}
export interface IdempotencyRepository {
  find(gameId: string, key: string): Promise<IdempotencyRecord | null>;
  save(record: IdempotencyRecord): Promise<void>;
}

export interface EventLog {
  append(gameId: string, events: readonly object[]): Promise<void>;
}

export interface Repositories {
  games: GameRepository;
  sessions: SessionRepository;
  credentials: CredentialRepository;
  idempotency: IdempotencyRepository;
  events: EventLog;
}

/** 1 回の操作のトランザクション境界。失敗したら、何も残さない */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
  joinCode(): string;
}

export interface CredentialPolicy {
  /** 256 ビットの資格と、保存用のダイジェスト */
  issue(): { token: string; digest: string };
  digestOf(token: string): string;
}

/** 状態の変化の通知（内容は含めず、変化があったことだけを伝える） */
export interface ChangeNotifier {
  subscribe(gameId: string, listener: () => void): () => void;
}
