import { useMemo, useState } from 'react';
import { BrowserApi } from './browser-api.js';
import { CreateGameForm, JoinAndRecovery, Lobby } from './CreateJoinLobby.js';
import { PlayPage } from './PlayPage.js';
import { FacilitatorConsole } from './FacilitatorConsole.js';
import { ObservationPage, ReviewPage } from './LearningPages.js';
import { RetentionPage } from './RetentionPage.js';

type Page =
  'welcome' | 'create' | 'join' | 'lobby' | 'play' | 'observation' | 'review' | 'retention';

export function App({ api }: { api?: BrowserApi }) {
  const browserApi = useMemo(() => api ?? new BrowserApi(), [api]);
  const [page, setPage] = useState<Page>('welcome');
  const [gameId, setGameId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [facilitator, setFacilitator] = useState(false);

  function enterLobby(id: string, asFacilitator: boolean) {
    setGameId(id);
    setFacilitator(asFacilitator);
    setPage('lobby');
  }
  return (
    <>
      <a className="skip-link" href="#main">
        本文へスキップ
      </a>
      <header>
        <h1>ビールゲーム</h1>
      </header>
      <main id="main" tabIndex={-1}>
        {gameId && page !== 'welcome' && page !== 'create' && page !== 'join' && (
          <nav aria-label="ゲーム画面">
            {page !== 'observation' && (
              <button type="button" onClick={() => setPage('observation')}>
                観察を見る
              </button>
            )}
            {page === 'observation' && (
              <button type="button" onClick={() => setPage(sessionId ? 'play' : 'lobby')}>
                ゲームへ戻る
              </button>
            )}
            {facilitator && page !== 'retention' && (
              <button type="button" onClick={() => setPage('retention')}>
                保持状態を見る
              </button>
            )}
            {page === 'retention' && (
              <button type="button" onClick={() => setPage(sessionId ? 'play' : 'lobby')}>
                ゲームへ戻る
              </button>
            )}
          </nav>
        )}
        {page === 'welcome' && (
          <section aria-labelledby="welcome-title">
            <h2 id="welcome-title">はじめる</h2>
            <button type="button" onClick={() => setPage('create')}>
              ゲームを作る
            </button>
            <button type="button" onClick={() => setPage('join')}>
              ゲームに参加・復帰
            </button>
          </section>
        )}
        {page === 'create' && (
          <CreateGameForm api={browserApi} onLobby={(id) => enterLobby(id, true)} />
        )}
        {page === 'join' && (
          <JoinAndRecovery
            api={browserApi}
            onJoined={(id) => enterLobby(id, false)}
            onRecovered={(id, restoredSessionId) => {
              setGameId(id);
              setFacilitator(false);
              setSessionId(restoredSessionId);
              setPage('play');
            }}
          />
        )}
        {page === 'lobby' && (
          <Lobby
            api={browserApi}
            gameId={gameId}
            facilitator={facilitator}
            onStarted={(id) => {
              setSessionId(id);
              setPage('play');
            }}
          />
        )}
        {page === 'play' &&
          (facilitator ? (
            <FacilitatorConsole
              api={browserApi}
              gameId={gameId}
              sessionId={sessionId}
              onEnded={() => setPage('review')}
            />
          ) : (
            <PlayPage
              api={browserApi}
              gameId={gameId}
              sessionId={sessionId}
              onReview={() => setPage('review')}
            />
          ))}
        {page === 'observation' && <ObservationPage api={browserApi} gameId={gameId} />}
        {page === 'review' && (
          <ReviewPage api={browserApi} gameId={gameId} facilitator={facilitator} />
        )}
        {page === 'retention' && <RetentionPage api={browserApi} gameId={gameId} />}
      </main>
    </>
  );
}
