export interface FailureMemoryOptions {
  /** 失敗したゲームを選択から外す時間（ミリ秒）。定期処理の 1 周期 */
  cooldownMs: number;
  /** 覚える最大の件数。超えたら古い順に捨てる（既定 1000） */
  max?: number;
}

/**
 * 直近の処理で失敗したゲームの識別子を、プロセスのメモリに持つ（NFR2.4、BR26.3）。
 * 失敗から 1 周期のあいだは対象の選択から除き、失敗が続くゲームが上限の件数を占めて
 * 後ろの正常なゲームが処理されなくなること（先頭詰まり）を防ぐ。再起動で消えてよい（最適化のため）。
 */
export class FailureMemory {
  /** 識別子 → 選択に戻す時刻（ミリ秒）。挿入の順が、失敗の古い順 */
  private readonly until = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly max: number;

  constructor(options: FailureMemoryOptions) {
    this.cooldownMs = options.cooldownMs;
    this.max = options.max ?? 1000;
  }

  /** 失敗を記録する。続けて失敗したら、期限を延ばす。 */
  record(gameId: string, now: Date): void {
    this.until.delete(gameId);
    this.until.set(gameId, now.getTime() + this.cooldownMs);
    while (this.until.size > this.max) {
      const oldest = this.until.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.until.delete(oldest);
    }
  }

  /** 成功したゲームは忘れる。 */
  forget(gameId: string): void {
    this.until.delete(gameId);
  }

  /** いま選択から外すゲームの識別子。期限を過ぎたものは取り除く。 */
  excluded(now: Date): string[] {
    for (const [gameId, until] of this.until) {
      if (until <= now.getTime()) {
        this.until.delete(gameId);
      }
    }
    return [...this.until.keys()];
  }

  size(): number {
    return this.until.size;
  }
}
