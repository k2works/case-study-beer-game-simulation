import type { Credential } from './api.js';

/**
 * 資格情報の保存先。
 * - 参加者の token: localStorage（同じ端末で再読み込みしても同じ役割に戻れる。NFR6.10）
 * - 観察者用コード: localStorage の専用のキー（URL に出さない。BR15.4）
 * - 進行役用コード: sessionStorage（タブを閉じると消える。強い権限のコードを長く端末に残さない）
 * どれも、使えない環境（プライベートウィンドウなど）では例外を握りつぶして保存しない。
 * 送信前の入力値は保存しない（BR20.3）。
 */
export interface CredentialStorage {
  load(): Credential | null;
  save(credential: Credential): void;
  clear(): void;
}

const PARTICIPANT_KEY = 'beerGame3.participant';
const OBSERVER_KEY = 'beerGame3.observer';
const FACILITATOR_KEY = 'beerGame3.facilitator';

const SLOTS: ReadonlyArray<{
  kind: Credential['kind'];
  key: string;
  storage: () => Storage;
}> = [
  { kind: 'facilitator', key: FACILITATOR_KEY, storage: () => sessionStorage },
  { kind: 'observer', key: OBSERVER_KEY, storage: () => localStorage },
  { kind: 'participant', key: PARTICIPANT_KEY, storage: () => localStorage },
];

function read(storage: () => Storage, key: string, kind: Credential['kind']): Credential | null {
  try {
    const raw = storage().getItem(key);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as { secret?: unknown; gameId?: unknown };
    return typeof value.secret === 'string' && typeof value.gameId === 'string'
      ? { kind, secret: value.secret, gameId: value.gameId }
      : null;
  } catch {
    return null;
  }
}

export function createBrowserStorage(): CredentialStorage {
  return {
    load() {
      for (const slot of SLOTS) {
        const found = read(slot.storage, slot.key, slot.kind);
        if (found) {
          return found;
        }
      }
      return null;
    },
    save(credential) {
      const slot = SLOTS.find((candidate) => candidate.kind === credential.kind);
      if (!slot) {
        return;
      }
      try {
        slot
          .storage()
          .setItem(
            slot.key,
            JSON.stringify({ secret: credential.secret, gameId: credential.gameId }),
          );
      } catch {
        // 保存できない環境では、再読み込みで入り直しになる
      }
    },
    clear() {
      for (const slot of SLOTS) {
        try {
          slot.storage().removeItem(slot.key);
        } catch {
          // 何もしない
        }
      }
    },
  };
}
