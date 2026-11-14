import { performance } from 'node:perf_hooks';
import type { Secret } from '../shared/secret.js';
import { REQUEST_TIMEOUT_MS } from '../shared/stats.js';
import type { Outcome } from './recorder.js';

export interface CallOptions {
  /** 資格情報（Authorization: Bearer で送る） */
  token?: Secret;
  body?: unknown;
  /** 16〜128 文字の冪等性の識別子 */
  idempotencyKey?: string;
  /** 応答時間の始点（performance.now()）。既定は送信の直前。取り直しは予定時刻を渡す */
  startedAt?: number;
  timeoutMs?: number;
}

export interface CallResult {
  outcome: Outcome;
  /** 応答の本文（JSON）。読めなかったときは undefined */
  json: unknown;
  /** 応答を受け取った時刻（performance.now()） */
  receivedAt: number;
}

/**
 * 公開の面（HTTP）への 1 回の要求。標準の fetch を使い、依存を増やさない。
 * タイムアウト（既定 5 秒）と接続の失敗は、例外にせず結果として返す（標本から落とさないため）。
 */
export async function call(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const sentAt = performance.now();
  const startedAt = options.startedAt ?? sentAt;
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.authorization = `Bearer ${options.token.reveal()}`;
  }
  if (options.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    const receivedAt = performance.now();
    return {
      outcome: { kind: 'ok', durationMs: receivedAt - startedAt, status: response.status },
      json,
      receivedAt,
    };
  } catch (error) {
    const receivedAt = performance.now();
    const name = error instanceof Error ? error.name : '';
    return {
      outcome:
        name === 'TimeoutError' || name === 'AbortError'
          ? { kind: 'timeout' }
          : { kind: 'connect' },
      json: undefined,
      receivedAt,
    };
  }
}

export function isSuccess(outcome: Outcome): boolean {
  return outcome.kind === 'ok' && outcome.status >= 200 && outcome.status < 300;
}
