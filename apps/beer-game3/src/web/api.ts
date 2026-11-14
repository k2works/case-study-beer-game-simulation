import type { Role } from '../server/domain/types.js';
import type { Problem, ProblemKind } from '../server/errors.js';
import type {
  CreatedGame,
  DecisionResult,
  JoinResult,
  ReplacementResult,
  WeekResult,
} from '../server/session/game-session.js';
import type { ResultsView } from '../server/reporting/results.js';
import type { HistoryEntryView, HistoryView } from '../server/session/history.js';
import type { GameStateView, ObserverView } from '../server/session/projection.js';

export type {
  CreatedGame,
  DecisionResult,
  GameStateView,
  HistoryEntryView,
  HistoryView,
  JoinResult,
  ObserverView,
  ReplacementResult,
  ResultsView,
  WeekResult,
};

export type ExportFormat = 'csv' | 'json';

/** 出力のファイル。画面が Blob としてダウンロードする（資格情報は URL に載せない、NFR6.6）。 */
export interface ExportedFile {
  blob: Blob;
  filename: string;
}

/** 資格情報。参加者の token、進行役用コード、観察者用コード。 */
export interface Credential {
  kind: 'participant' | 'facilitator' | 'observer';
  secret: string;
  gameId: string;
}

export interface Me {
  kind: 'participant' | 'facilitator' | 'observer';
  gameId: string;
  participantId?: string;
  role?: Role | null;
}

/** 通信できなかったとき（ネットワークの断・想定外の応答）は kind が network。 */
export class ApiError extends Error {
  readonly kind: ProblemKind | 'network';
  readonly problem: Problem | null;

  constructor(kind: ProblemKind | 'network', problem: Problem | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.problem = problem;
  }

  /** 項目ごとの理由（なければ undefined） */
  fieldMessage(path: string): string | undefined {
    return this.problem?.fields?.find((field) => field.path === path)?.message;
  }
}

export interface ApiClient {
  createGame(body: Record<string, unknown>): Promise<CreatedGame>;
  join(body: { joinCode: string; displayName: string }): Promise<JoinResult>;
  me(secret: string): Promise<Me>;
  /** 観察者には ObserverView（viewerKind が observer）が返る */
  getState(credential: Credential): Promise<GameStateView | ObserverView>;
  getCodes(credential: Credential): Promise<{ joinCode: string; observerCode: string }>;
  assign(credential: Credential, participantId: string, role: Role | null): Promise<void>;
  start(credential: Credential): Promise<void>;
  submitDecision(
    credential: Credential,
    week: number,
    role: Role,
    quantity: number,
    idempotencyKey: string,
  ): Promise<DecisionResult>;
  confirmWeek(credential: Credential, week: number, idempotencyKey: string): Promise<WeekResult>;
  pause(credential: Credential): Promise<GameStateView>;
  resume(credential: Credential): Promise<GameStateView>;
  end(credential: Credential): Promise<GameStateView>;
  /** 担当者の入れ替え。新しい復帰用 token の平文は、この応答でだけ返る */
  replaceAssignee(
    credential: Credential,
    role: Role,
    participantId: string,
    displayName: string,
  ): Promise<ReplacementResult>;
  getHistory(credential: Credential): Promise<HistoryView>;
  /** 終了後の結果（参加者と進行役）。終了前は 403 */
  getResults(credential: Credential): Promise<ResultsView>;
  /** 結果の出力（進行役だけ）。ヘッダ付きで取得して Blob にする */
  exportGame(credential: Credential, format: ExportFormat): Promise<ExportedFile>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 画面が呼ぶ API の薄い層。資格情報は Authorization ヘッダで送り、URL には載せない（NFR6.6）。 */
export function createApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): ApiClient {
  async function call<T>(
    method: string,
    url: string,
    options: { secret?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.secret) {
      headers.authorization = `Bearer ${options.secret}`;
    }
    if (options.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      throw new ApiError('network', null, '通信できませんでした');
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw problemError(payload);
    }
    return payload as T;
  }

  /** 出力: JSON ではなくファイルとして受け取る。失敗は他の API と同じ Problem で返る。 */
  async function download(
    url: string,
    secret: string,
    fallbackName: string,
  ): Promise<ExportedFile> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${secret}` },
      });
    } catch {
      throw new ApiError('network', null, '通信できませんでした');
    }
    if (!response.ok) {
      throw problemError(await readJson(response));
    }
    return {
      blob: await response.blob(),
      filename: filenameOf(response.headers.get('content-disposition')) ?? fallbackName,
    };
  }

  const base = (gameId: string): string => `/api/games/${encodeURIComponent(gameId)}`;

  return {
    createGame: (body) => call('POST', '/api/games', { body }),
    join: (body) => call('POST', '/api/games/join', { body }),
    me: (secret) => call('GET', '/api/me', { secret }),
    getState: (c) => call('GET', `${base(c.gameId)}/state`, { secret: c.secret }),
    getCodes: (c) => call('GET', `${base(c.gameId)}/codes`, { secret: c.secret }),
    assign: async (c, participantId, role) => {
      await call('PUT', `${base(c.gameId)}/assignments/${encodeURIComponent(participantId)}`, {
        secret: c.secret,
        body: { role },
      });
    },
    start: async (c) => {
      await call('POST', `${base(c.gameId)}/start`, { secret: c.secret });
    },
    submitDecision: (c, week, role, quantity, idempotencyKey) =>
      call('PUT', `${base(c.gameId)}/weeks/${week}/decisions/${role}`, {
        secret: c.secret,
        body: { quantity },
        idempotencyKey,
      }),
    confirmWeek: (c, week, idempotencyKey) =>
      call('POST', `${base(c.gameId)}/weeks/${week}/confirm`, { secret: c.secret, idempotencyKey }),
    pause: (c) => call('POST', `${base(c.gameId)}/pause`, { secret: c.secret }),
    resume: (c) => call('POST', `${base(c.gameId)}/resume`, { secret: c.secret }),
    end: (c) => call('POST', `${base(c.gameId)}/end`, { secret: c.secret }),
    replaceAssignee: (c, role, participantId, displayName) =>
      call('POST', `${base(c.gameId)}/roles/${encodeURIComponent(role)}/replacement`, {
        secret: c.secret,
        body: { participantId, displayName },
      }),
    getHistory: (c) => call('GET', `${base(c.gameId)}/history`, { secret: c.secret }),
    getResults: (c) => call('GET', `${base(c.gameId)}/results`, { secret: c.secret }),
    exportGame: (c, format) =>
      download(`${base(c.gameId)}/export?format=${format}`, c.secret, `beer-game.${format}`),
  };
}

/** 失敗の応答から ApiError を作る。Problem の形でなければ、想定外の応答として扱う。 */
function problemError(payload: unknown): ApiError {
  const problem = isProblem(payload) ? payload : null;
  return new ApiError(problem?.kind ?? 'internal', problem, problem?.reason ?? '想定外の応答です');
}

/** Content-Disposition のファイル名（attachment; filename="..."）。無ければ null。 */
function filenameOf(header: string | null): string | null {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Problem).kind === 'string' &&
    typeof (value as Problem).reason === 'string'
  );
}

/** Idempotency-Key（16〜128 文字）。ブラウザの乱数から作る。 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
