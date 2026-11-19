interface EventSourcePort {
  addEventListener(name: string, listener: () => void): void;
  onerror?: (() => void) | null;
  onopen?: (() => void) | null;
  close(): void;
}

export class LiveStateAdapter<T extends { version: number }> {
  private source?: EventSourcePort;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private latestVersion = -1;
  private latestFingerprint = '';
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly snapshot: () => Promise<T>,
    private readonly onUpdate: (state: T) => void,
    private readonly createSource: (url: string) => EventSourcePort = (url) =>
      new EventSource(url, { withCredentials: true }) as unknown as EventSourcePort,
    private readonly onConnectionChange: (state: 'connected' | 'polling') => void = () => {},
  ) {}

  async start() {
    this.stopped = false;
    await this.refresh();
    if (this.stopped) return;
    try {
      this.source = this.createSource(this.url);
    } catch {
      this.timer = setInterval(() => {
        if (!this.stopped) void this.refresh();
      }, 1000);
      this.onConnectionChange('polling');
      return;
    }
    this.source.addEventListener('state-version', () => {
      if (!this.stopped) void this.refresh();
    });
    this.source.onerror = () => {
      if (!this.timer && !this.stopped) {
        this.timer = setInterval(() => {
          void this.refresh();
        }, 1000);
        this.onConnectionChange('polling');
      }
    };
    this.source.onopen = () => {
      this.stopPolling();
      this.onConnectionChange('connected');
      void this.refresh();
    };
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.snapshot()
      .then((state) => {
        const fingerprint = JSON.stringify(state);
        if (
          state.version > this.latestVersion ||
          (state.version === this.latestVersion && fingerprint !== this.latestFingerprint)
        ) {
          this.latestVersion = state.version;
          this.latestFingerprint = fingerprint;
          this.onUpdate(state);
        }
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  stop() {
    this.stopped = true;
    this.stopPolling();
    this.source?.close();
    this.source = undefined;
  }

  private stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
