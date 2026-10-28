import { useEffect, useState } from 'react';

type SafeState = {
  week: number;
  version: number;
  status: string;
  own: { role: string; inventory: number; backlog: number };
};

export function App() {
  const [state, setState] = useState<SafeState>();
  const [quantity, setQuantity] = useState('4');
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () =>
      fetch('/api/v1/sessions/current/state', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('状態を取得できません'))))
        .then(setState)
        .catch((e) => setError(e.message));
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, []);
  async function submit() {
    setError('');
    const response = await fetch('/api/v1/sessions/current/decisions', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'if-match': '0',
        'idempotency-key': crypto.randomUUID(),
        'x-csrf-token': document.cookie.match(/bg_csrf=([^;]+)/)?.[1] ?? '',
      },
      body: JSON.stringify({ quantity: Number(quantity) }),
    });
    if (!response.ok) setError('発注量を保存できません');
  }
  return (
    <main>
      <h1>Beer Game</h1>
      <div role="status" aria-live="polite">
        {error}
      </div>
      {state ? (
        <section>
          <h2>
            {state.own.role} — Week {state.week}
          </h2>
          <dl>
            <dt>在庫</dt>
            <dd>{state.own.inventory}</dd>
            <dt>受注残</dt>
            <dd>{state.own.backlog}</dd>
          </dl>
          <label>
            発注量
            <input
              data-testid="decision-quantity"
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <button data-testid="submit-decision" onClick={submit}>
            保存
          </button>
        </section>
      ) : (
        <p>読み込み中…</p>
      )}
    </main>
  );
}
