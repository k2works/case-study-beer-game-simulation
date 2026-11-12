import type { RandomSource } from '../clock.js';
import { forbiddenError, internalError } from '../errors.js';
import type { Role } from '../domain/types.js';
import { projectState, type GameStateView } from '../session/projection.js';
import type { AccessCodeKind, AccessCodeRow, Snapshot, Store } from '../session/store.js';
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

/**
 * 呼び出した人。観察者（kind: observer）は U4 が足す。
 * U1 は観察者用コードの発行と保存までを持ち、資格情報としては受け付けない。
 */
export type Principal = ParticipantPrincipal | FacilitatorPrincipal;

export interface IssuedCodes {
  rows: AccessCodeRow[];
  plain: { joinCode: string; facilitatorCode: string; observerCode: string };
}

export interface IssuedToken {
  plain: string;
  hash: string;
}

export interface AccessControlDeps {
  store: Store;
  keyRing: KeyRing;
  random: RandomSource;
}

const sha256Stored = (value: string): string => `sha256:${sha256Hex(value)}`;

/**
 * AccessControl（C4）。資格情報の判定、権限の判定、役割別の投影、コードと token の発行を持つ。
 * - 資格情報は種類の印で判別する: `fac_`（進行役用コード）、`tok_`（参加者の token）。
 *   参加コードは参加の入口にだけ使い、資格情報（Authorization）としては使えない。
 * - 失敗の形はすべて同じ（forbidden）。コードの推測に手がかりを与えない。
 */
export class AccessControl {
  private readonly store: Store;
  private readonly keyRing: KeyRing;
  private readonly random: RandomSource;

  constructor(deps: AccessControlDeps) {
    this.store = deps.store;
    this.keyRing = deps.keyRing;
    this.random = deps.random;
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

  /** Authorization の資格情報から Principal を求める。無効なら null。 */
  async authenticate(credential: string | null | undefined): Promise<Principal | null> {
    const value = credential?.trim();
    if (!value) {
      return null;
    }
    if (value.startsWith(PREFIX_FACILITATOR)) {
      const found = await this.store.findCodeByHash([sha256Stored(value)], 'facilitator');
      return found ? { kind: 'facilitator', gameId: found.gameId } : null;
    }
    if (value.startsWith(PREFIX_TOKEN)) {
      const found = await this.store.findTokenByHash(sha256Stored(value));
      return found
        ? {
            kind: 'participant',
            gameId: found.gameId,
            participantId: found.participantId,
            role: found.role,
          }
        : null;
    }
    // 観察者用コード（PREFIX_OBSERVER）は U4 が入口を足す。U1 では資格情報として受け付けない
    return null;
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

  /** 状態を見られるのは、そのゲームの進行役と参加者。 */
  requireViewer(principal: Principal | null, gameId: string): Principal {
    if (!principal || principal.gameId !== gameId) {
      throw forbiddenError(
        'このゲームの状況を見る権限がありません',
        '参加したときのコードで入り直してください',
      );
    }
    return principal;
  }

  /** 呼び出した人の投影だけを作る（NFR6.2）。 */
  project(snapshot: Snapshot, principal: Principal): GameStateView {
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

  /** 接続元を鍵付きで要約する（無効なコードの試行の記録用。生の接続元は残さない）。 */
  sourceDigest(address: string): string {
    return keyedDigest(this.keyRing, address);
  }
}

export { PREFIX_OBSERVER };
