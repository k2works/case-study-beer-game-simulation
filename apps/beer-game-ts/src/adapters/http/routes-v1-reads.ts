import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Application } from '../../application/index.js';
import { ROLES } from '../../domain/role.js';
import { API_V1 } from './problems.js';
import { idParam, tokenOf } from './v1-support.js';

/**
 * 共有の API の契約（/api/v1）の、読み取りの経路。ルールは持たず、ユースケースを呼ぶだけ。
 * 資格は、Cookie `bg_session`（`X-Tab-Id` があれば `bg_session_<X-Tab-Id>`）。無い・無効・別のゲーム・存在しないゲームは、
 * すべて同じ 403（`app.unauthorized`）。経路の ID が UUID でなければ 404。
 */

const stateQuery = z.object({ role: z.enum(ROLES).optional() });
const exportQuery = z.object({ format: z.enum(['csv', 'json']) });

export function registerApiV1Reads(server: FastifyInstance, app: Application) {
  server.get(`${API_V1}/games/:gameId/state`, async (request) =>
    app.getGameState({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
    }),
  );

  // sessionId は、このゲームでは gameId と同じ
  server.get(`${API_V1}/sessions/:sessionId/state`, async (request) => {
    const query = stateQuery.parse(request.query);
    return app.getSessionState({
      token: tokenOf(request),
      gameId: idParam(request, 'sessionId'),
      ...(query.role ? { role: query.role } : {}),
    });
  });

  server.get(`${API_V1}/games/:gameId/lobby`, async (request) =>
    app.getLobby({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
    }),
  );

  server.get(`${API_V1}/games/:gameId/observation`, async (request) =>
    app.getObservation({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
    }),
  );

  server.get(`${API_V1}/games/:gameId/review`, async (request) =>
    app.getReview({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
    }),
  );

  server.get(`${API_V1}/games/:gameId/retention`, async (request) =>
    app.getRetention({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
    }),
  );

  // 出力（進行役・終了後）。全体を組み立ててから送る。本文（UTF-8 のバイト列）の SHA-256 をヘッダーで返す
  server.get(`${API_V1}/games/:gameId/exports`, async (request, reply) => {
    const { format } = exportQuery.parse(request.query);
    const out = await app.getExport({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
      format,
    });
    return reply
      .type(out.contentType)
      .header('content-disposition', `attachment; filename="${out.filename}"`)
      .header('cache-control', 'no-store')
      .header(
        'x-export-checksum',
        `sha256-${createHash('sha256').update(out.body, 'utf8').digest('hex')}`,
      )
      .header('x-export-schema-version', out.schemaVersion)
      .send(out.body);
  });
}
