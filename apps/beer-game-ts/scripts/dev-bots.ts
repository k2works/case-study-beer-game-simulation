/**
 * ローカルで 1 人でも 1 ゲーム遊べるようにする、開発用のボット（共有の契約 /api/v1）。
 * 使い方: npm run dev:bots -- <参加コード> [人数=3]
 *
 * ボットは参加し、役割が割り当てられたら、毎週 4 を発注する（Ctrl-C で終了）。
 * 進行役（あなた）は、ブラウザで役割を割り当て（ボット 3 人 + あなた自身）、開始し、週を確定する。
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const ORDER = Number(process.env.BOT_ORDER ?? 4);
// steady: 毎週 ORDER を発注する。reactive: 今週の受注 + 受注残 + (目標在庫 12 − 在庫) を発注する（基点在庫方式。
// 上流ほど注文が大きく揺れる「ブルウィップ効果」が現れる。振り返りの確認に使う）
const STRATEGY = process.env.BOT_STRATEGY ?? 'steady';

const [joinCode, countArg] = process.argv.slice(2);
if (!joinCode) {
  console.error('使い方: npm run dev:bots -- <参加コード> [人数=3]');
  process.exit(1);
}
const count = Number(countArg ?? 3);

/** 自分の役割の状況（`roleStatus`）の情報だけで、今週の発注を決める */
function quantityFor(s: {
  inventory: number;
  backlog: number;
  orders: number;
}): number {
  if (STRATEGY !== 'reactive') return ORDER;
  return Math.max(0, s.orders + s.backlog + (12 - s.inventory));
}

class Bot {
  private session = '';
  gameId = '';
  constructor(readonly name: string) {}

  private async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.session ? { cookie: `bg_session=${this.session}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      if (pair?.startsWith('bg_session=')) this.session = pair.slice(11);
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  async join() {
    const r = await this.call('POST', '/api/v1/participations/join', {
      joinCode,
      displayName: this.name,
    });
    if (r.status !== 200)
      throw new Error(
        `${this.name}: 参加できません (${r.status} ${r.data?.code ?? ''})`,
      );
    this.gameId = r.data.gameId;
    console.log(`✓ ${this.name} が参加`);
  }

  /** 役割があり、進行中で、今週の発注が未入力なら、発注する */
  async tick() {
    const state = await this.call(
      'GET',
      `/api/v1/sessions/${this.gameId}/state`,
    );
    if (state.status !== 200) return; // 役割の割り当て前、または開始前
    const v = state.data;
    if (v.status !== 'ACTIVE' || v.roleStatus.decision !== null) return;
    const quantity = quantityFor(v.roleStatus);
    const r = await this.call(
      'PUT',
      `/api/v1/sessions/${this.gameId}/decisions`,
      { week: v.week, quantity },
      { 'if-match': `"${v.roleStatus.decisionVersion}"` },
    );
    if (r.status === 200)
      console.log(
        `  ${this.name}（${v.role}）が ${v.week} 週目に ${quantity} を発注`,
      );
  }
}

const bots = Array.from({ length: count }, (_, i) => new Bot(`ボット${i + 1}`));
for (const bot of bots) await bot.join();
console.log(
  'ブラウザで役割を割り当て、ゲームを開始してください。Ctrl-C で終了します。',
);
setInterval(() => {
  for (const bot of bots)
    bot.tick().catch((e) => console.error(`${bot.name}: ${e.message}`));
}, 1000);
