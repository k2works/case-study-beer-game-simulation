import type { CredentialValidity } from '../domain/credential.js';
import type { Game } from '../domain/game.js';
import type { ReviewRow } from '../domain/review.js';
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

/** 資格に対応する主体。生の資格は保存せず、ダイジェストだけを持つ */
export interface Principal {
  gameId: string;
  kind: 'FACILITATOR' | 'PARTICIPANT';
  participantId?: string;
}

/** 資格の種類。ブラウザセッション（Cookie の値）と、復帰コード（Cookie を失ったときに戻るため） */
export type CredentialPurpose = 'SESSION' | 'RECOVERY';

export interface CredentialRepository {
  /** 保存する。復帰コードは主体ごとに 1 つで、保存すると前の復帰コードは使えなくなる */
  save(
    digest: string,
    principal: Principal,
    purpose: CredentialPurpose,
    validity: CredentialValidity,
  ): Promise<void>;
  /** 候補のダイジェスト（鍵の版ごと）のうち、時刻 `at` で有効（失効・期限切れでない）なものの主体 */
  find(
    digests: readonly string[],
    purpose: CredentialPurpose,
    at: Date,
  ): Promise<Principal | null>;
  /** 主体のブラウザセッションと復帰コードを、すべて失効させる */
  revokeAll(principal: Principal, at: Date): Promise<void>;
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

/** 1 回の操作のトランザクション境界。失敗したら、何も残さない
 *
 * @landmark トランザクション境界の契約。成功したら全部、失敗したら何も残らない。メモリ版と PostgreSQL 版の 2 つの実装が、同じ契約でテストされている。
 */
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
  /** 256 ビットの資格と、保存用のダイジェスト（最新の鍵の版） */
  issue(): { token: string; digest: string };
  /** 検証用の、すべての鍵の版のダイジェスト */
  digestsOf(token: string): string[];
}

/** 状態の変化の通知（内容は含めず、変化があったことだけを伝える） */
export interface ChangeNotifier {
  subscribe(gameId: string, listener: () => void): () => void;
}

/** 振り返りの元データ。ゲームの状態と、確定した週の役割別の行 */
export interface ReviewSource {
  /** セッションが無い（未開始）なら null */
  sessionStatus: 'ACTIVE' | 'PAUSED' | 'ENDED' | null;
  rows: ReviewRow[];
}

/**
 * 読み取り専用の経路（集約を経由せず、ロックを取らない）。
 * 開示してよいかの判定はここでは行わない（ドメインの `canDisclose`）。
 */
export interface ReviewReader {
  read(gameId: string): Promise<ReviewSource>;
}

/**
 * 総当たりの対策のレート制限。状態はプロセスの外に持ち、タスク数で実効の上限が増えないようにする。
 */
export interface RateLimiter {
  /** `bucket` の、時刻 `at` を含む窓の回数を 1 増やし、上限以内なら true */
  hit(bucket: string, at: Date): Promise<boolean>;
}
