import { performance } from 'node:perf_hooks';
import type { Secret } from '../shared/secret.js';
import { call } from './http.js';
import type { Recorder } from './recorder.js';

export interface StateObservation {
  week: number;
  status: string;
  receivedAt: number;
}

export interface VirtualClientOptions {
  baseUrl: string;
  gameId: string;
  token: Secret;
  intervalMs: number;
  recorder: Recorder;
  /** 取り直しの応答を受け取るたびに呼ぶ（反映の観察に使う） */
  onState?: (observation: StateObservation) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 仮想の利用者（1 画面）。1 秒周期で状態を取り直す。周期は「k 回目の予定時刻 = 開始時刻 + k × 間隔」で刻み、
 * **取り直しを飛ばさない**。前の応答が遅れて予定時刻に送れなかった分は、応答の直後に送る。
 * 応答時間の標本は、実際の送信時刻でなく**予定時刻**から応答の受信までを測る（coordinated omission を避ける）。
 */
export class VirtualClient {
  private stopped = false;
  private disconnectedUntil = 0;
  private loop: Promise<void> | null = null;
  private disconnects = 0;

  constructor(private readonly options: VirtualClientOptions) {}

  start(): void {
    if (this.loop) {
      return;
    }
    this.loop = this.run();
  }

  /** 切断の模擬: 指定の時間、取り直しを止めて再開する（再開時に予定時刻の基準を取り直す）。 */
  disconnectFor(ms: number): void {
    this.disconnectedUntil = performance.now() + ms;
    this.disconnects += 1;
  }

  get disconnectCount(): number {
    return this.disconnects;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    const { baseUrl, gameId, token, intervalMs, recorder, onState } = this.options;
    let base = performance.now();
    let k = 0;
    while (!this.stopped) {
      if (this.disconnectedUntil > performance.now()) {
        await sleep(Math.max(1, this.disconnectedUntil - performance.now()));
        base = performance.now();
        k = 0;
        continue;
      }
      const scheduled = base + k * intervalMs;
      const wait = scheduled - performance.now();
      if (wait > 0) {
        await sleep(wait);
        if (this.stopped) {
          break;
        }
      } else {
        // 予定の時刻を過ぎて送る。何周期ぶん遅れたかを数える（飛ばさずに、すぐ送る）
        const late = Math.floor(-wait / intervalMs);
        if (late > 0) {
          recorder.addBehind(late);
        }
      }
      const result = await call(baseUrl, 'GET', `/api/games/${gameId}/state`, {
        token,
        startedAt: scheduled,
      });
      recorder.recordPoll(result.outcome);
      if (result.outcome.kind === 'ok' && result.outcome.status === 200) {
        const body = result.json as { currentWeek?: unknown; status?: unknown } | undefined;
        if (typeof body?.currentWeek === 'number') {
          onState?.({
            week: body.currentWeek,
            status: typeof body.status === 'string' ? body.status : '',
            receivedAt: result.receivedAt,
          });
        }
      }
      k += 1;
    }
  }
}
