import type { Credential } from './api.js';

/**
 * 資格情報の保存先。
 * - 参加者の token: localStorage（同じ端末で再読み込みしても同じ役割に戻れる。NFR6.10）
 * - 進行役用コード: sessionStorage（タブを閉じると消える。強い権限のコードを長く端末に残さない）
 * どちらも、使えない環境（プライベートウィンドウなど）では例外を握りつぶして保存しない。
 */
export interface CredentialStorage {
  load(): Credential | null;
  save(credential: Credential): void;
  clear(): void;
}

const PARTICIPANT_KEY = 'beerGame3.participant';
const FACILITATOR_KEY = 'beerGame3.facilitator';

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
      return (
        read(() => sessionStorage, FACILITATOR_KEY, 'facilitator') ??
        read(() => localStorage, PARTICIPANT_KEY, 'participant')
      );
    },
    save(credential) {
      try {
        const store = credential.kind === 'facilitator' ? sessionStorage : localStorage;
        const key = credential.kind === 'facilitator' ? FACILITATOR_KEY : PARTICIPANT_KEY;
        store.setItem(
          key,
          JSON.stringify({ secret: credential.secret, gameId: credential.gameId }),
        );
      } catch {
        // 保存できない環境では、再読み込みで入り直しになる
      }
    },
    clear() {
      for (const [store, key] of [
        [() => sessionStorage, FACILITATOR_KEY],
        [() => localStorage, PARTICIPANT_KEY],
      ] as const) {
        try {
          store().removeItem(key);
        } catch {
          // 何もしない
        }
      }
    },
  };
}
