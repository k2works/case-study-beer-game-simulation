import { ApiError, type ApiClient } from './types.js';

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.detail ?? '要求を処理できませんでした',
      data.issues ?? [],
      data.latest,
    );
  return data as T;
}

export function createHttpClient(): ApiClient {
  const g = (id: string) => `/api/games/${encodeURIComponent(id)}`;
  return {
    createGame: (input) => call('POST', '/api/games', input),
    join: (input) => call('POST', '/api/join', input),
    recover: (code) => call('POST', '/api/recover', { code }),
    pause: (id) => call('POST', `${g(id)}/pause`, {}),
    changeCommitMode: (id, commitMode) =>
      call('PUT', `${g(id)}/commit-mode`, { commitMode }),
    resume: (id) => call('POST', `${g(id)}/resume`, {}),
    proxyDecision: (id, role, quantity, version) =>
      call(
        'PUT',
        `${g(id)}/proxy-decision`,
        { role, quantity },
        { 'if-match': `"${version}"` },
      ),
    reissue: (id, target) =>
      call(
        'POST',
        `${g(id)}/credentials/reissue`,
        target.kind === 'FACILITATOR'
          ? { target: 'FACILITATOR' }
          : { target: 'PARTICIPANT', participantId: target.participantId },
      ),
    lobby: (id) => call('GET', `${g(id)}/lobby`),
    assign: (id, participantId, role) =>
      call('POST', `${g(id)}/assignments`, { participantId, role }),
    unassign: (id, participantId) =>
      call(
        'DELETE',
        `${g(id)}/assignments/${encodeURIComponent(participantId)}`,
      ),
    start: (id) => call('POST', `${g(id)}/start`, {}),
    review: (id) => call('GET', `${g(id)}/review`),
    me: (id) => call('GET', `${g(id)}/me`),
    console: (id) => call('GET', `${g(id)}/console`),
    saveDecision: (id, role, quantity, version) =>
      call(
        'PUT',
        `${g(id)}/decision`,
        { role, quantity },
        { 'if-match': `"${version}"` },
      ),
    commit: (id, week, version, key) =>
      call(
        'POST',
        `${g(id)}/commit`,
        { week },
        { 'if-match': `"${version}"`, 'idempotency-key': key },
      ),
    subscribe: (id, onChange) => {
      if (typeof EventSource === 'undefined') return () => {};
      const source = new EventSource(`${g(id)}/stream`);
      source.addEventListener('changed', onChange);
      return () => source.close();
    },
  };
}
