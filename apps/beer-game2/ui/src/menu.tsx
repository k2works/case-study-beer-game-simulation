import { NavLink, useLocation } from 'react-router';

/** ゲームの画面（/games/:id/...）にいるとき、そのゲームの ID を返す */
function currentGameId(pathname: string): string | null {
  return /^\/games\/([^/]+)\//.exec(pathname)?.[1] ?? null;
}

/** 全画面共通のメニュー。ブラウザの戻る・進むに頼らず、画面を行き来できる */
export function Menu() {
  const gameId = currentGameId(useLocation().pathname);
  return (
    <nav aria-label="メインメニュー" className="menu">
      <ul>
        <li>
          <NavLink to="/" end>
            ホーム
          </NavLink>
        </li>
        <li>
          <NavLink to="/new">新しいゲーム</NavLink>
        </li>
        <li>
          <NavLink to="/join">ゲームに参加</NavLink>
        </li>
        {gameId && (
          <>
            <li className="menu-sep" aria-hidden="true">
              |
            </li>
            <li>
              <NavLink to={`/games/${gameId}/lobby`}>ロビー</NavLink>
            </li>
            <li>
              <NavLink to={`/games/${gameId}/play`}>自分の画面</NavLink>
            </li>
            <li>
              <NavLink to={`/games/${gameId}/console`}>
                進行役コンソール
              </NavLink>
            </li>
          </>
        )}
      </ul>
    </nav>
  );
}
