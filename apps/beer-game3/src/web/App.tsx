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

/**
 * 保存した資格情報が使えなかったときの案内（BR17.3）。理由（期限切れ・失効・不明）は区別しない。
 * 参加者の token は進行役への依頼を案内し、観察者の入口は入口の文言にする。
 */
function noticeFor(kind: Credential['kind']): string {
  switch (kind) {
    case 'participant':
      return 'この端末の参加情報は使えません。進行役に担当者の入れ替えを依頼してください';
    case 'observer':
      return '観察者用コードが正しくありません';
    case 'facilitator':
      return '進行役用コードが正しくありません';
  }
}

/** 画面の切り替え。保存済みの資格情報があれば、確かめてから同じ役割の画面へ戻る。 */
export function App({ api, storage, pollMs = 1000 }: Props) {
  const [view, setView] = useState<View>({ name: 'boot' });
  const [notice, setNotice] = useState<string | null>(null);

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
        setNotice(e instanceof ApiError && e.kind === 'forbidden' ? noticeFor(stored.kind) : null);
        setView({ name: 'join' });
      });
    return () => {
      alive = false;
    };
  }, [api, storage]);

  const enter = useCallback(
    (credential: Credential) => {
      storage.save(credential);
      setNotice(null);
      setView({ name: 'game', credential });
    },
    [storage],
  );

  const leave = useCallback(() => {
    storage.clear();
    setNotice(null);
    setView({ name: 'join' });
  }, [storage]);

  // 無効な資格情報を受けたとき: 保存した値を消して参加画面へ戻り、案内を示す（BR17.3）
  const denied = useCallback(
    (kind: Credential['kind']) => {
      storage.clear();
      setNotice(noticeFor(kind));
      setView({ name: 'join' });
    },
    [storage],
  );

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
      <GameScreen
        api={api}
        credential={game}
        pollMs={pollMs}
        onDenied={() => denied(game.kind)}
        onLeave={leave}
      />
    );
  }
  return (
    <JoinScreen
      api={api}
      notice={notice}
      onJoined={enter}
      onFacilitator={enter}
      onObserver={enter}
      onCreate={() => setView({ name: 'create' })}
    />
  );
}
