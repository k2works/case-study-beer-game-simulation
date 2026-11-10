import pg from 'pg';
import type { ChangeNotifier } from '../../ports/index.js';

const CHANNEL = 'session_changed';

export interface PgNotifierOptions {
  /** 接続が切れたときの再接続の間隔（ミリ秒） */
  retryMs?: number;
}

/**
 * PostgreSQL の LISTEN / NOTIFY による変化の通知。再生はしない（見逃しはポーリングで追いつく）。
 * 接続が切れてもプロセスは落とさず、再接続する。
 */
export class PgNotifier implements ChangeNotifier {
  private client: pg.Client | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly retryMs: number;

  constructor(
    private readonly connectionString: string,
    options: PgNotifierOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 1000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      for (const listener of this.listeners.get(msg.payload) ?? []) listener();
    });
    const lost = () => {
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    };
    client.on('error', lost);
    client.on('end', lost);
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, this.retryMs);
  }

  subscribe(gameId: string, listener: () => void): () => void {
    const set = this.listeners.get(gameId) ?? new Set();
    set.add(listener);
    this.listeners.set(gameId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(gameId);
    };
  }
}
