import type { BrowserContext } from '@playwright/test';

export interface SignIn {
  kind: 'participant' | 'facilitator' | 'observer';
  secret: string;
  gameId: string;
}

/**
 * 画面の保存領域に資格情報を入れて、その役割で入った状態にする（画面の仕様 BR17.3 の復帰の入口）。
 * 進行役用コードは sessionStorage、参加者の token と観察者用コードは localStorage に保存される。
 */
export async function signIn(context: BrowserContext, who: SignIn): Promise<void> {
  const key =
    who.kind === 'facilitator'
      ? 'beerGame3.facilitator'
      : who.kind === 'observer'
        ? 'beerGame3.observer'
        : 'beerGame3.participant';
  await context.addInitScript(
    ({ key: storageKey, session, value }) => {
      const target = session ? window.sessionStorage : window.localStorage;
      target.setItem(storageKey, value);
    },
    {
      key,
      session: who.kind === 'facilitator',
      value: JSON.stringify({ secret: who.secret, gameId: who.gameId }),
    },
  );
}
