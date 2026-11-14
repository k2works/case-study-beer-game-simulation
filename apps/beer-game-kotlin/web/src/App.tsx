import { BrowserRouter, Link, Outlet, Route, Routes } from 'react-router';
import { ApiProvider } from './api/ApiContext';
import { PageHeading } from './components/PageHeading';
import { ConsolePage } from './features/console/ConsolePage';
import { LobbyPage } from './features/lobby/LobbyPage';
import { JoinPage } from './features/participation/JoinPage';
import { PlayPage } from './features/play/PlayPage';
import { CreateGamePage } from './features/setup/CreateGamePage';
import { WelcomePage } from './features/welcome/WelcomePage';

function Shell() {
    return (
        <>
            <a href="#main" className="skip-link">
                本文へスキップ
            </a>
            <header>
                <Link to="/">ビールゲーム</Link>
            </header>
            <main id="main">
                <Outlet />
            </main>
        </>
    );
}

function NotFoundPage() {
    return (
        <>
            <PageHeading title="ページが見つかりません" />
            <Link to="/">はじめるへ戻る</Link>
        </>
    );
}

/** 画面の URL。B1 の範囲（S01〜S06）。ID は docs/design/beer-game-kotlin/ui-design.md の画面一覧。 */
export function AppRoutes() {
    return (
        <Routes>
            <Route element={<Shell />}>
                <Route path="/" element={<WelcomePage />} />
                <Route path="/new" element={<CreateGamePage />} />
                <Route path="/join" element={<JoinPage />} />
                <Route path="/games/:gameId/lobby" element={<LobbyPage />} />
                <Route path="/games/:gameId/play" element={<PlayPage />} />
                <Route path="/games/:gameId/console" element={<ConsolePage />} />
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}

export function App() {
    return (
        <BrowserRouter>
            <ApiProvider>
                <AppRoutes />
            </ApiProvider>
        </BrowserRouter>
    );
}
