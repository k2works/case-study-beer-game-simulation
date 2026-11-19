import type { Clock, RandomSource } from '../clock.js';
import { forbiddenError, internalError, invalidCredentialError } from '../errors.js';
import { ROLES, type Role } from '../domain/types.js';
import { projectState, type GameStateView, type ObserverView } from '../session/projection.js';
import type {
  AccessCodeKind,
  AccessCodeRow,
  JoinAttemptOutcome,
  ResolvedToken,
  Snapshot,
  Store,
} from '../session/store.js';
import {
  PREFIX_FACILITATOR,
  PREFIX_OBSERVER,
  PREFIX_TOKEN,
  generateJoinCode,
  generateSecret,
  normalizeJoinCode,
  sha256Hex,
} from './codes.js';
import { hmacCandidates, hmacForStorage, keyedDigest, seal, unseal, type KeyRing } from './keys.js';
import { withDefaults, type AccessPolicy } from './policy.js';
import { normalizeSource } from './source.js';

export interface ParticipantPrincipal {
  kind: 'participant';
  gameId: string;
  participantId: string;
  role: Role | null;
}

export interface FacilitatorPrincipal {
  kind: 'facilitator';
  gameId: string;
}

/** 観察者（BR15.1）。特定できるのは観察者だけで、参加者や進行役の権限は持たない。 */
export interface ObserverPrincipal {
  kind: 'observer';
  gameId: string;
}

/** 呼び出した人。 */
export type Principal = ParticipantPrincipal | FacilitatorPrincipal | ObserverPrincipal;

/**
 * 権限を判定する操作の一覧（操作の表、NFR6.1）。経路の表（routeCatalog）の各行が 1 つを指す。
 * - identify: 自分が誰かの確認。有効な資格情報ならゲームを問わない
 */
export const ACTIONS = [
  'identify',
  'viewState',
  'getCodes',
  'assignRole',
  'startGame',
  'submitDecision',
  'confirmWeek',
  'pauseGame',
  'resumeGame',
  'endGame',
  'replaceAssignee',
  'getHistory',
  'viewResults',
  'exportGame',
] as const;

export type Action = (typeof ACTIONS)[number];

/** 参加者に許す操作（状態の取得、自分の役割の入力、終了後の結果の閲覧だけ）。 */
const PARTICIPANT_ACTIONS: ReadonlySet<Action> = new Set([
  'viewState',
  'submitDecision',
  'viewResults',
]);

/** 観察者に許す操作は、状態の取得だけ（BR15.2）。 */
const OBSERVER_ACTIONS: ReadonlySet<Action> = new Set(['viewState']);

/** 権限の判定に使う、要求のゲームと役割。 */
export interface ActionScope {
  gameId?: string;
  role?: string;
}

export interface IssuedCodes {
  rows: AccessCodeRow[];
  plain: { joinCode: string; facilitatorCode: string; observerCode: string };
}

export interface IssuedToken {
  plain: string;
  hash: string;
}

/** 認証に成功した参加者の token。応答のあとの最後の操作の時刻の更新に使う。 */
export interface TokenTouch {
  tokenId: string;
}

export interface Authenticated {
  principal: Principal | null;
  touch: TokenTouch | null;
}

export interface AccessControlDeps {
  store: Store;
  keyRing: KeyRing;
  random: RandomSource;
  clock: Clock;
  policy?: Partial<AccessPolicy>;
}

const sha256Stored = (value: string): string => `sha256:${sha256Hex(value)}`;

/** 復帰用 token の期限の判定（BR17.1）。最後の操作から有効期間を過ぎたら期限切れ。行は変えない。 */
export function isExpired(lastUsedAt: Date, now: Date, ttlMs: number): boolean {
  return now.getTime() > lastUsedAt.getTime() + ttlMs;
}

/**
 * AccessControl（C4）。資格情報の判定、権限の判定、役割別の投影、コードと token の発行を持つ。
 * - 資格情報の種類は、ヘッダの形ではなく照合の結果で決める。参加者の token（return_tokens）と
 *   進行役用・観察者用のコード（access_codes）を、ハッシュの索引で引く。参加コードは資格情報にならない。
 * - 失敗の形はすべて同じ（forbidden）。コードの推測に手がかりを与えない。
 */
export class AccessControl {
  private readonly store: Store;
  private readonly keyRing: KeyRing;
  private readonly random: RandomSource;
  private readonly clock: Clock;
  readonly policy: AccessPolicy;

  constructor(deps: AccessControlDeps) {
    this.store = deps.store;
    this.keyRing = deps.keyRing;
    this.random = deps.random;
    this.clock = deps.clock;
    this.policy = withDefaults(deps.policy);
  }

  /** 作成時に 3 種類のコードを発行する。照合用の値と、再表示のための暗号化した値を作る。 */
  issueGameCodes(gameId: string, issuedAt: Date, newId: () => string): IssuedCodes {
    const joinCode = generateJoinCode(this.random);
    const facilitatorCode = generateSecret(this.random, PREFIX_FACILITATOR);
    const observerCode = generateSecret(this.random, PREFIX_OBSERVER);
    const row = (
      kind: AccessCodeKind,
      codeHash: string,
      sealedPlain: string | null,
    ): AccessCodeRow => ({
      codeId: newId(),
      gameId,
      kind,
      codeHash,
      codeSealed:
        sealedPlain === null
          ? null
          : seal(this.keyRing, sealedPlain, `${gameId}:${kind}`, this.random),
      issuedAt,
    });
    return {
      rows: [
        row('join', hmacForStorage(this.keyRing, joinCode), joinCode),
        // 進行役用コードはハッシュだけ。紛失しても再表示も再発行もしない
        row('facilitator', sha256Stored(facilitatorCode), null),
        row('observer', hmacForStorage(this.keyRing, observerCode), observerCode),
      ],
      plain: { joinCode, facilitatorCode, observerCode },
    };
  }

  /** 参加者の token を発行する。token そのものは保存せず、ハッシュを保存する。 */
  issueToken(): IssuedToken {
    const plain = generateSecret(this.random, PREFIX_TOKEN);
    return { plain, hash: sha256Stored(plain) };
  }

  /**
   * 参加者の token の判定を 1 か所に集める（NFR6.4）。不明、失効、期限切れは、同じ結果（null）を返す。
   * 失効した token は保存の層が返さないので、ここでは不明と期限切れを区別しない。
   */
  resolveParticipant(found: ResolvedToken | null): Authenticated | null {
    if (!found || isExpired(found.lastUsedAt, this.clock.now(), this.policy.tokenTtlMs)) {
      return null;
    }
    return {
      principal: {
        kind: 'participant',
        gameId: found.gameId,
        participantId: found.participantId,
        role: found.role,
      },
      touch: { tokenId: found.tokenId },
    };
  }

  /** Authorization の資格情報から呼び出した人を求め、最後の操作の時刻を延ばす対象も返す。無効なら principal が null。 */
  async authenticateWithTouch(credential: string | null | undefined): Promise<Authenticated> {
    const value = credential?.trim();
    if (!value) {
      return { principal: null, touch: null };
    }
    const stored = sha256Stored(value);
    const [token, code] = await Promise.all([
      this.store.findTokenByHash(stored),
      this.store.findCredentialCode([stored, ...hmacCandidates(this.keyRing, value)]),
    ]);
    if (token) {
      return this.resolveParticipant(token) ?? { principal: null, touch: null };
    }
    if (code) {
      return {
        principal: { kind: code.kind, gameId: code.gameId },
        touch: null,
      };
    }
    return { principal: null, touch: null };
  }

  /** Authorization の資格情報から Principal を求める。無効なら null。 */
  async authenticate(credential: string | null | undefined): Promise<Principal | null> {
    return (await this.authenticateWithTouch(credential)).principal;
  }

  /** 認証に成功した要求の、最後の操作の時刻を延ばす（1 分に 1 回まで、BR17.2）。書いたら true。 */
  async touch(target: TokenTouch): Promise<boolean> {
    return this.store.touchToken(target.tokenId, this.clock.now(), this.policy.touchIntervalMs);
  }

  /** 参加コードからゲームを特定する。無効なら null。 */
  async resolveJoinCode(input: string): Promise<string | null> {
    const normalized = normalizeJoinCode(input);
    if (normalized.length === 0 || normalized.length > 64) {
      return null;
    }
    const found = await this.store.findCodeByHash(hmacCandidates(this.keyRing, normalized), 'join');
    return found?.gameId ?? null;
  }

  /**
   * 参加コードによる参加の試行を数える（BR18）。窓の検査、コードの検証、記録を原子的に行う。
   * 窓が満杯なら limited（コードは検証しない）、無効なら invalid、有効なら valid とゲームの識別子。
   */
  async attemptJoin(address: string, rawCode: string): Promise<JoinAttemptOutcome> {
    const normalized = normalizeJoinCode(rawCode);
    const codeHashes =
      normalized.length === 0 || normalized.length > 64
        ? []
        : hmacCandidates(this.keyRing, normalized);
    return this.store.attemptJoin({
      sourceKey: this.sourceDigest(address),
      now: this.clock.now(),
      windowMs: this.policy.joinWindowMs,
      maxAttempts: this.policy.joinMaxAttempts,
      codeHashes,
    });
  }

  /**
   * 操作の表（NFR6.1、BR19.1）。資格情報の種類と、要求のゲーム・役割への権限を検証する。
   * 存在しないゲームも別のゲームも同じ 403 で、存在を明かさない。
   * - 進行役: 自分のゲームのすべての操作（代理入力を含む）
   * - 参加者: 状態の取得と、自分の役割の入力
   * - 観察者: 状態の取得だけ
   */
  authorize(principal: Principal | null, action: Action, scope: ActionScope): Principal {
    const denied = invalidCredentialError();
    if (!principal) {
      throw denied;
    }
    if (action === 'identify') {
      return principal;
    }
    if (scope.gameId === undefined || principal.gameId !== scope.gameId) {
      throw denied;
    }
    switch (principal.kind) {
      case 'facilitator':
        return principal;
      case 'observer':
        if (OBSERVER_ACTIONS.has(action)) {
          return principal;
        }
        throw denied;
      case 'participant': {
        if (!PARTICIPANT_ACTIONS.has(action)) {
          throw denied;
        }
        if (action === 'submitDecision') {
          const role = ROLES.find((candidate) => candidate === scope.role);
          if (!role || principal.role !== role) {
            throw denied;
          }
        }
        // 結果を見られる参加者は、役割が割り当てられている人（BR21.2）
        if (action === 'viewResults' && principal.role === null) {
          throw denied;
        }
        return principal;
      }
    }
  }

  /** 進行役の操作は、そのゲームの進行役用コードを持つ人だけができる（BR1.5）。 */
  requireFacilitator(principal: Principal | null, gameId: string): FacilitatorPrincipal {
    if (principal?.kind !== 'facilitator' || principal.gameId !== gameId) {
      throw forbiddenError(
        '進行役の操作には進行役用コードが必要です',
        '進行役用コードで操作してください',
      );
    }
    return principal;
  }

  /** 参加者の操作は、そのゲームの、その役割の参加者だけができる（BR4.1）。 */
  requireParticipantOfRole(
    principal: Principal | null,
    gameId: string,
    role: Role,
  ): ParticipantPrincipal {
    if (
      principal?.kind !== 'participant' ||
      principal.gameId !== gameId ||
      principal.role !== role
    ) {
      throw forbiddenError(
        '自分の役割以外の操作はできません',
        '自分の役割の画面から操作してください',
      );
    }
    return principal;
  }

  /**
   * 入力できるのは、そのゲームのその役割の参加者か、進行役（代理入力、BR11.1）。
   * 進行役の代理入力は、担当者の有無によらず、どの役割にもできる。
   */
  requireDecisionActor(
    principal: Principal | null,
    gameId: string,
    role: Role,
  ): ParticipantPrincipal | FacilitatorPrincipal {
    if (principal?.kind === 'facilitator' && principal.gameId === gameId) {
      return principal;
    }
    return this.requireParticipantOfRole(principal, gameId, role);
  }

  /** 状態を見られるのは、そのゲームの進行役と参加者と観察者。 */
  requireViewer(principal: Principal | null, gameId: string): Principal {
    if (!principal || principal.gameId !== gameId) {
      throw forbiddenError(
        'このゲームの状況を見る権限がありません',
        '参加したときのコードで入り直してください',
      );
    }
    return principal;
  }

  /**
   * 結果を見られるのは、そのゲームの参加者（役割が割り当てられた人）と進行役だけ（BR21.2）。
   * 観察者、資格情報なし、別のゲームは、資格情報の無効と区別できない同じ 403 で拒否する。
   */
  requireResultsViewer(
    principal: Principal | null,
    gameId: string,
  ): ParticipantPrincipal | FacilitatorPrincipal {
    const allowed = this.authorize(principal, 'viewResults', { gameId });
    if (allowed.kind === 'observer') {
      throw invalidCredentialError();
    }
    return allowed;
  }

  /** 出力ができるのは、そのゲームの進行役だけ（BR23.1）。参加者と観察者も、同じ 403 で拒否する。 */
  requireExporter(principal: Principal | null, gameId: string): FacilitatorPrincipal {
    const allowed = this.authorize(principal, 'exportGame', { gameId });
    if (allowed.kind !== 'facilitator') {
      throw invalidCredentialError();
    }
    return allowed;
  }

  /** 呼び出した人の投影だけを作る（NFR6.2）。観察者にはチーム全体の合計だけの専用の型を返す。 */
  project(snapshot: Snapshot, principal: ObserverPrincipal): ObserverView;
  project(
    snapshot: Snapshot,
    principal: ParticipantPrincipal | FacilitatorPrincipal,
  ): GameStateView;
  project(snapshot: Snapshot, principal: Principal): GameStateView | ObserverView;
  project(snapshot: Snapshot, principal: Principal): GameStateView | ObserverView {
    return projectState(snapshot, principal);
  }

  /** 参加コードまたは観察者用コードを、進行役の再表示のために復号する。失敗したら internal。 */
  async reveal(gameId: string, kind: 'join' | 'observer'): Promise<string> {
    const row = await this.store.getAccessCode(gameId, kind);
    if (!row?.codeSealed) {
      throw internalError('コードを表示できません', '管理者に連絡してください');
    }
    try {
      return unseal(this.keyRing, row.codeSealed, `${gameId}:${kind}`);
    } catch {
      // 復号に失敗したら、コードを推測で返さない
      throw internalError('コードを復号できません', '管理者に連絡してください');
    }
  }

  /** 接続元を正規化して鍵付きで要約する（窓の鍵とログ用。生の接続元は残さない）。 */
  sourceDigest(address: string): string {
    return keyedDigest(this.keyRing, normalizeSource(address));
  }
}

export { PREFIX_OBSERVER };
