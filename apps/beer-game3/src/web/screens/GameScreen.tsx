import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiClient,
  type Credential,
  type GameStateView,
  type ObserverView,
} from '../api.js';
import { RESULTS_MESSAGES } from '../messages.js';
import { FacilitatorBoard } from './FacilitatorBoard.js';
import { LobbyScreen } from './LobbyScreen.js';
import { ObserverScreen } from './ObserverScreen.js';
import { PlayScreen } from './PlayScreen.js';
import { ResultsScreen } from './ResultsScreen.js';

interface Props {
  api: ApiClient;
  credential: Credential;
  /** 取り直しの周期（ミリ秒）。画面の既定は 1 秒（NFR3.4） */
  pollMs: number;
  onDenied: () => void;
  onLeave: () => void;
}

/**
 * 状態を一定の周期で取り直す。版が変わったときだけ描画し直し、通信が切れたら帯で知らせる。
 * 取り直しは読み取りだけ（ゲームの行を占有しない）。
 */
function useGameState(
  api: ApiClient,
  credential: Credential,
  pollMs: number,
  onDenied: () => void,
) {
  const [state, setState] = useState<GameStateView | ObserverView | null>(null);
  const [lost, setLost] = useState(false);
  const version = useRef<number | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const denied = useRef(onDenied);
  denied.current = onDenied;

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const next = await api.getState(credential);
      if (!alive.current) {
        return;
      }
      setLost(false);
      if (version.current !== next.version) {
        version.current = next.version;
        setState(next);
      }
    } catch (e) {
      if (!alive.current) {
        return;
      }
      if (e instanceof ApiError && e.kind === 'forbidden') {
        denied.current();
      } else {
        setLost(true);
      }
    } finally {
      inFlight.current = false;
    }
  }, [api, credential]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return { state, lost, refresh: useCallback(() => void refresh(), [refresh]) };
}

export function GameScreen({ api, credential, pollMs, onDenied, onLeave }: Props) {
  const { state, lost, refresh } = useGameState(api, credential, pollMs, onDenied);
  const [showResults, setShowResults] = useState(false);
  // 結果画面へ移れるのは、終了したゲームの参加者と進行役だけ。終了前は導線を出さない（BR22.6）。
  // 観察者は、終了後もチーム全体の集計値だけを見る（BR21.2）
  const canSeeResults = state?.status === 'ended' && state.viewerKind !== 'observer';

  let body;
  if (state && canSeeResults && showResults) {
    body = (
      <ResultsScreen
        api={api}
        credential={credential}
        gameName={state.name}
        onBack={() => setShowResults(false)}
      />
    );
  } else if (!state) {
    body = (
      <main>
        <p role="status">読み込んでいます</p>
      </main>
    );
  } else if (state.viewerKind === 'observer') {
    body = <ObserverScreen state={state} />;
  } else if (state.status === 'preparing') {
    body = <LobbyScreen api={api} credential={credential} state={state} refresh={refresh} />;
  } else if (state.viewerKind === 'facilitator') {
    body = <FacilitatorBoard api={api} credential={credential} state={state} refresh={refresh} />;
  } else {
    body = <PlayScreen api={api} credential={credential} state={state} refresh={refresh} />;
  }

  return (
    <>
      {lost ? (
        <p role="status" data-testid="connection-lost" className="banner">
          接続が切れています。自動で再接続を試みます
        </p>
      ) : null}
      {canSeeResults && !showResults ? (
        <nav aria-label="結果" className="results-link">
          <button type="button" data-testid="show-results" onClick={() => setShowResults(true)}>
            {RESULTS_MESSAGES.open}
          </button>
        </nav>
      ) : null}
      {body}
      <footer>
        <button type="button" data-testid="leave" onClick={onLeave}>
          入り直す
        </button>
      </footer>
    </>
  );
}
