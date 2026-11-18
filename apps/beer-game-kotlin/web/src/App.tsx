import { BrowserRouter, Link, Outlet, Route, Routes } from 'react-router';
import { ApiProvider } from './api/ApiContext';
import { NarrowScreenNotice } from './components/NarrowScreenNotice';
import { PageHeading } from './components/PageHeading';
import { ConsolePage } from './features/console/ConsolePage';
import { HelpPage } from './features/help/HelpPage';
import { LobbyPage } from './features/lobby/LobbyPage';
import { ObservationPage } from './features/observer/ObservationPage';
import { ObserverJoinPage } from './features/observer/ObserverJoinPage';
import { JoinPage } from './features/participation/JoinPage';
import { PlayPage } from './features/play/PlayPage';
import { RetentionPage } from './features/retention/RetentionPage';
import { ReviewPage } from './features/review/ReviewPage';
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
                <NarrowScreenNotice />
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

/** 画面の URL。S01〜S11（B9 で観察 S07・観察者の参加 S10、B11 で保持状態 S09、B15 でヘルプ S11 を足した）。ID は docs/design/beer-game-kotlin/ui-design.md の画面一覧。 */
export function AppRoutes() {
    return (
        <Routes>
            <Route element={<Shell />}>
                <Route path="/" element={<WelcomePage />} />
                <Route path="/new" element={<CreateGamePage />} />
                <Route path="/join" element={<JoinPage />} />
                <Route path="/observe" element={<ObserverJoinPage />} />
                <Route path="/help" element={<HelpPage />} />
                <Route path="/games/:gameId/lobby" element={<LobbyPage />} />
                <Route path="/games/:gameId/observation" element={<ObservationPage />} />
                <Route path="/games/:gameId/play" element={<PlayPage />} />
                <Route path="/games/:gameId/console" element={<ConsolePage />} />
                <Route path="/games/:gameId/review" element={<ReviewPage />} />
                <Route path="/games/:gameId/retention" element={<RetentionPage />} />
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
