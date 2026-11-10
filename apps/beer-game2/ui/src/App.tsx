import { Route, Routes } from 'react-router';
import type { ApiClient } from './api/types.js';
import { ApiContext, PollContext } from './hooks.js';
import { ConsoleScreen } from './features/console.js';
import { Home, Join, NewGame } from './features/home.js';
import { LobbyScreen } from './features/lobby.js';
import { PlayScreen } from './features/play.js';
import { ReviewScreen } from './features/review.js';
import { Menu } from './menu.js';

/** ルーティング。API クライアントは差し替えられる（テストでは偽物を渡す） */
export function App({
  api,
  pollMs = 5000,
}: {
  api: ApiClient;
  pollMs?: number;
}) {
  return (
    <ApiContext.Provider value={api}>
      <PollContext.Provider value={pollMs}>
        <Menu />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewGame />} />
          <Route path="/join" element={<Join />} />
          <Route path="/games/:id/lobby" element={<LobbyScreen />} />
          <Route path="/games/:id/play" element={<PlayScreen />} />
          <Route path="/games/:id/console" element={<ConsoleScreen />} />
          <Route path="/games/:id/review" element={<ReviewScreen />} />
        </Routes>
      </PollContext.Provider>
    </ApiContext.Provider>
  );
}
