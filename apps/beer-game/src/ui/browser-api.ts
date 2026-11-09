export type Role = 'RETAILER' | 'WHOLESALER' | 'DISTRIBUTOR' | 'FACTORY';

export interface LobbyState {
  gameId: string;
  sessionId: string;
  week: number;
  status: string;
  version: number;
  joinCode?: string;
  participants: { participantId: string; displayName: string; role?: Role }[];
  decisions?: Record<Role, { complete: boolean; version: number }>;
}

export interface RoleState {
  sessionId: string;
  week: number;
  status: string;
  version: number;
  decisionComplete: boolean;
  decisionVersion: number;
  own: { role: Role; inventory: number; backlog: number; arrivals: number; order: number };
}

export class BrowserApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

type Fetcher = typeof fetch;

export class BrowserApi {
  constructor(private readonly fetcher: Fetcher = (...args) => globalThis.fetch(...args)) {}

  private async json<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
    version?: number,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    if (version !== undefined) headers['If-Match'] = String(version);
    const response = await this.fetcher(`/api/v1${path}`, {
      method,
      credentials: 'include',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      try {
        const problem = (await response.json()) as { title?: string };
        if (typeof problem.title === 'string') code = problem.title;
      } catch {
        /* malformed problem details are still an HTTP failure */
      }
      throw new BrowserApiError(response.status, code);
    }
    return response.json() as Promise<T>;
  }

  createGame(input: { finalWeek: number; demand: number[]; retentionDays: number }, key: string) {
    return this.json<{ gameId: string; sessionId: string; joinCode: string; version: number }>(
      '/games',
      'POST',
      input,
      key,
    );
  }
  join(joinCode: string, displayName: string, key: string) {
    return this.json<{ gameId: string; sessionId: string; participantId: string }>(
      '/participations/join',
      'POST',
      { joinCode, displayName },
      key,
    );
  }
  lobby(gameId: string) {
    return this.json<LobbyState>(`/games/${encodeURIComponent(gameId)}/lobby`);
  }
  recover() {
    return this.json<{ gameId: string; state: RoleState }>('/participations/recover', 'POST');
  }
  assignRole(gameId: string, participantId: string, role: Role, version: number, key: string) {
    return this.json<{ participantId: string; role: Role; version: number }>(
      `/games/${encodeURIComponent(gameId)}/participants/${encodeURIComponent(participantId)}/role`,
      'PUT',
      { role },
      key,
      version,
    );
  }
  lifecycle(
    sessionId: string,
    action: 'start' | 'pause' | 'resume' | 'end',
    version: number,
    key: string,
  ) {
    return this.json<{ status: string; version: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/${action}`,
      'POST',
      undefined,
      key,
      version,
    );
  }
  state(sessionId: string) {
    return this.json<RoleState>(`/sessions/${encodeURIComponent(sessionId)}/state`);
  }
  decision(sessionId: string, quantity: number, version: number, key: string) {
    return this.json<{ version: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/decisions`,
      'PUT',
      { quantity },
      key,
      version,
    );
  }
  proxyDecision(sessionId: string, role: Role, quantity: number, version: number, key: string) {
    return this.json<{ version: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/proxy-decisions/${role}`,
      'PUT',
      { quantity, expectedVersion: version },
      key,
      version,
    );
  }
  commit(sessionId: string, week: number, version: number, key: string) {
    return this.json<{ version: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/weeks/${week}/commit`,
      'POST',
      undefined,
      key,
      version,
    );
  }
  observation(gameId: string) {
    return this.json<Record<string, unknown>>(`/games/${encodeURIComponent(gameId)}/observation`);
  }
  review(gameId: string) {
    return this.json<{
      sourceVersion: number;
      weeklySeries: {
        week: number;
        inventory: number;
        backlog: number;
        orders: number;
        demand: number;
        shipments: number;
        costMinor: number;
      }[];
    }>(`/games/${encodeURIComponent(gameId)}/review`);
  }
  createExport(gameId: string, key: string) {
    return this.json<{ exportId: string; status: string; schemaVersion: string }>(
      `/games/${encodeURIComponent(gameId)}/exports`,
      'POST',
      undefined,
      key,
    );
  }
  exportStatus(gameId: string, exportId: string) {
    return this.json<{ exportId: string; status: string; schemaVersion: string }>(
      `/games/${encodeURIComponent(gameId)}/exports/${encodeURIComponent(exportId)}`,
    );
  }
  exportUrl(gameId: string, exportId: string, format: 'csv' | 'json') {
    return `/api/v1/games/${encodeURIComponent(gameId)}/exports/${encodeURIComponent(exportId)}/download?format=${format}`;
  }
  retention(gameId: string) {
    return this.json<Record<string, unknown>>(`/games/${encodeURIComponent(gameId)}/retention`);
  }
  retryRetention(gameId: string, version: number, key: string) {
    return this.json<Record<string, unknown>>(
      `/games/${encodeURIComponent(gameId)}/retention/retry`,
      'POST',
      undefined,
      key,
      version,
    );
  }
}
