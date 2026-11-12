import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type ApiClient, type Credential } from './api.js';
import type { CredentialStorage } from './storage.js';
import { CreateScreen } from './screens/CreateScreen.js';
import { GameScreen } from './screens/GameScreen.js';
import { JoinScreen } from './screens/JoinScreen.js';

interface Props {
  api: ApiClient;
  storage: CredentialStorage;
  /** 状態の取り直しの周期（ミリ秒）。既定は 1 秒 */
  pollMs?: number;
}

type View =
  | { name: 'boot' }
  | { name: 'join' }
  | { name: 'create' }
  | { name: 'game'; credential: Credential };

/** 画面の切り替え。保存済みの資格情報があれば、確かめてから同じ役割の画面へ戻る。 */
export function App({ api, storage, pollMs = 1000 }: Props) {
  const [view, setView] = useState<View>({ name: 'boot' });

  useEffect(() => {
    const stored = storage.load();
    if (!stored) {
      setView({ name: 'join' });
      return;
    }
    let alive = true;
    api
      .me(stored.secret)
      .then((me) => {
        if (alive) {
          setView({ name: 'game', credential: { ...stored, gameId: me.gameId } });
        }
      })
      .catch((e: unknown) => {
        if (!alive) {
          return;
        }
        if (e instanceof ApiError && e.kind === 'network') {
          // 通信が戻れば続けられる。資格情報は消さない
          setView({ name: 'game', credential: stored });
          return;
        }
        storage.clear();
        setView({ name: 'join' });
      });
    return () => {
      alive = false;
    };
  }, [api, storage]);

  const enter = useCallback(
    (credential: Credential) => {
      storage.save(credential);
      setView({ name: 'game', credential });
    },
    [storage],
  );

  const leave = useCallback(() => {
    storage.clear();
    setView({ name: 'join' });
  }, [storage]);

  const game = useMemo(() => (view.name === 'game' ? view.credential : null), [view]);

  if (view.name === 'boot') {
    return (
      <main>
        <p role="status">読み込んでいます</p>
      </main>
    );
  }
  if (view.name === 'create') {
    return (
      <CreateScreen api={api} onEnterLobby={enter} onCancel={() => setView({ name: 'join' })} />
    );
  }
  if (game) {
    return (
      <GameScreen api={api} credential={game} pollMs={pollMs} onDenied={leave} onLeave={leave} />
    );
  }
  return (
    <JoinScreen
      api={api}
      onJoined={enter}
      onFacilitator={enter}
      onCreate={() => setView({ name: 'create' })}
    />
  );
}
