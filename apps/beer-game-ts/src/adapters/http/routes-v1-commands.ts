import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Application } from '../../application/index.js';
import type { ConditionsInput } from '../../domain/conditions.js';
import { ROLES } from '../../domain/role.js';
import { idempotencyKeyOf } from './idempotency-key.js';
import { API_V1, rateLimitedProblem, validationProblem } from './problems.js';
import {
  idParam,
  ifMatchVersionOf,
  issueCookies,
  recoveryTokenOf,
  tokenOf,
} from './v1-support.js';

/**
 * 共有の API の契約（/api/v1）の、変更系（コマンド）の経路。ルールは持たず、ユースケースを呼ぶだけ。
 * 変更系は、Origin と `Idempotency-Key` の形を、入口（server.ts の onRequest）で検査済み。
 * 応答は、追記後の版（`versions`）。資格の失敗は、すべて同じ 403（`app.unauthorized`）。
 */
export interface CommandRoutesContext {
  app: Application;
  /** 参加・復帰などの専用のレート制限。超えたら `ApiProblem`（429＋`Retry-After`） */
  limit: (request: FastifyRequest, bucket: string) => Promise<void>;
  /** 資格の Cookie に `Secure` を付けるか */
  secureCookies: boolean;
}

/** レート制限の窓（秒）。超えたときの `Retry-After` は、窓の長さ（上限）を返す */
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const rateLimited = () => rateLimitedProblem(RATE_LIMIT_WINDOW_SECONDS);

const roleSchema = z.enum(ROLES);

/** 契約の `CustomConditions`。省略した項目は、キットの値。未知の項目は拒否する */
const conditionsSchema = z.strictObject({
  initialInventory: z
    .strictObject({
      FACTORY: z.number().optional(),
      DISTRIBUTOR: z.number().optional(),
      WHOLESALER: z.number().optional(),
      RETAILER: z.number().optional(),
    })
    .optional(),
  initialFlow: z.number().optional(),
  orderDelayWeeks: z.number().optional(),
  shipmentDelayWeeks: z.number().optional(),
  productionDelayWeeks: z.number().optional(),
  holdingCostMinor: z.number().optional(),
  backlogCostMinor: z.number().optional(),
  disclosurePolicy: z.enum(['TEAM_TOTAL', 'NONE']).optional(),
});

/** 数値でない需要は、非数にして、ドメインに「対象の週つき」で拒否させる（AC1.1.2） */
const demandSchema = z
  .array(z.unknown())
  .transform((values) =>
    values.map((v) => (typeof v === 'number' ? v : Number.NaN)),
  );

const createGameSchema = z.object({
  kind: z.enum(['KIT', 'CUSTOM']),
  finalWeek: z.number(),
  demand: demandSchema,
  conditions: conditionsSchema.optional(),
  commitMode: z.enum(['MANUAL', 'AUTO']).optional(),
  retentionDays: z.number().optional(),
});

/** 契約の条件を、ドメインの入力へ。公開範囲の呼び名（`NONE`）は、内部の `PROGRESS_ONLY` に写す */
function conditionsInputOf(
  c: z.infer<typeof conditionsSchema>,
): ConditionsInput {
  const { disclosurePolicy, initialInventory, ...rest } = c;
  const defined = <T extends object>(o: T) =>
    Object.fromEntries(
      Object.entries(o).filter(([, v]) => v !== undefined),
    ) as Partial<T>;
  return {
    ...defined(rest),
    ...(initialInventory
      ? { initialInventory: defined(initialInventory) }
      : {}),
    ...(disclosurePolicy
      ? {
          disclosure:
            disclosurePolicy === 'NONE' ? 'PROGRESS_ONLY' : 'TEAM_TOTAL',
        }
      : {}),
  };
}

const joinSchema = z.object({
  joinCode: z.string(),
  displayName: z.string(),
});
const assignSchema = z.object({ role: roleSchema });
const recoverSchema = z.object({
  gameId: z.uuid(),
  recoveryCode: z.string().optional(),
});
const joinObserverSchema = z.object({
  invitationCode: z.string(),
  displayName: z.string(),
});
const weekSchema = z.number().int().min(1).max(50);
const versionSchema = z.number().int().min(0);
const saveDecisionSchema = z.object({ week: weekSchema, quantity: z.number() });
const commitWeekSchema = z.object({
  requestedWeek: weekSchema,
  basis: z.strictObject({
    FACTORY: versionSchema,
    DISTRIBUTOR: versionSchema,
    WHOLESALER: versionSchema,
    RETAILER: versionSchema,
  }),
});
const setCommitModeSchema = z.object({
  commitMode: z.enum(['MANUAL', 'AUTO']),
});
const proxyDecisionSchema = z.object({
  requestedWeek: weekSchema,
  quantity: z.number(),
});
const credentialSubjectSchema = z.object({
  subject: z.object({ kind: z.literal('PARTICIPANT'), id: z.uuid() }),
});

export function registerApiV1Commands(
  server: FastifyInstance,
  ctx: CommandRoutesContext,
) {
  const { app } = ctx;

  // ゲームの作成（匿名）。進行役の資格（ブラウザセッションと復帰資格）を発行し、復帰コードを一度だけ示す
  server.post(`${API_V1}/games`, async (request, reply) => {
    const body = createGameSchema.parse(request.body);
    if (body.kind === 'KIT' && body.conditions !== undefined)
      throw validationProblem([
        {
          field: 'conditions',
          message:
            'キット準拠のゲームには、条件を付けられません。カスタムで作成してください',
        },
      ]);
    const created = await app.createGame({
      weeks: body.finalWeek,
      demand: body.demand,
      ...(body.commitMode ? { commitMode: body.commitMode } : {}),
      ...(body.retentionDays !== undefined
        ? { retentionDays: body.retentionDays }
        : {}),
      ...(body.conditions
        ? { conditions: conditionsInputOf(body.conditions) }
        : {}),
      idempotencyKey: idempotencyKeyOf(request),
    });
    issueCookies(
      request,
      reply,
      { session: created.facilitatorToken, recovery: created.recoveryCode },
      ctx.secureCookies,
    );
    return reply
      .code(201)
      .header('location', `${API_V1}/games/${created.gameId}/state`)
      .send({ versions: created.versions, recoveryCode: created.recoveryCode });
  });

  // 参加コードで参加する（認可は参加コード）。復帰資格も発行する
  server.post(`${API_V1}/participations/join`, async (request, reply) => {
    await ctx.limit(request, 'join');
    const body = joinSchema.parse(request.body);
    const joined = await app.joinGame({
      ...body,
      idempotencyKey: idempotencyKeyOf(request),
    });
    issueCookies(
      request,
      reply,
      { session: joined.token, recovery: joined.recoveryCode },
      ctx.secureCookies,
    );
    return { versions: joined.versions, gameId: joined.gameId };
  });

  // 復帰資格（本文の復帰コード、または Cookie `bg_recovery`）で、同じゲームと役割へ戻る。新しいブラウザセッションを発行する
  server.post(`${API_V1}/participations/recover`, async (request, reply) => {
    await ctx.limit(request, 'recover');
    const body = recoverSchema.parse(request.body);
    const code = body.recoveryCode ?? recoveryTokenOf(request) ?? '';
    const back = await app.recover({
      code,
      gameId: body.gameId,
      idempotencyKey: idempotencyKeyOf(request),
    });
    issueCookies(
      request,
      reply,
      { session: back.token, recovery: code },
      ctx.secureCookies,
    );
    return {
      versions: back.versions,
      gameId: back.gameId,
      kind: back.kind,
      ...(back.role ? { role: back.role } : {}),
    };
  });

  // 観察用の招待（進行役）。招待コードは、この応答で一度だけ示す
  server.post(
    `${API_V1}/games/:gameId/observer-invitations`,
    async (request) => {
      const issued = await app.issueObserverInvitation({
        token: tokenOf(request),
        gameId: idParam(request, 'gameId'),
        idempotencyKey: idempotencyKeyOf(request),
      });
      return {
        versions: issued.versions,
        invitationId: issued.invitationId,
        invitationCode: issued.code,
        expiresAt: issued.expiresAt,
      };
    },
  );

  server.post(
    `${API_V1}/games/:gameId/observer-invitations/:invitationId/revoke`,
    async (request) =>
      app.revokeObserverInvitation({
        token: tokenOf(request),
        gameId: idParam(request, 'gameId'),
        invitationId: idParam(request, 'invitationId'),
        idempotencyKey: idempotencyKeyOf(request),
      }),
  );

  // 観察者の参加（認可は招待コード）。ブラウザセッションだけを発行する（復帰資格は発行しない）
  server.post(`${API_V1}/participations/observe`, async (request, reply) => {
    await ctx.limit(request, 'observe');
    const body = joinObserverSchema.parse(request.body);
    const joined = await app.joinAsObserver({
      code: body.invitationCode,
      displayName: body.displayName,
      idempotencyKey: idempotencyKeyOf(request),
    });
    issueCookies(request, reply, { session: joined.token }, ctx.secureCookies);
    return {
      versions: joined.versions,
      gameId: joined.gameId,
      kind: 'OBSERVER' as const,
    };
  });

  // 参加者の資格の失効と再発行（進行役）。再発行の応答で、新しい復帰コードを一度だけ示す
  server.post(`${API_V1}/games/:gameId/credentials/revoke`, async (request) => {
    const body = credentialSubjectSchema.parse(request.body);
    return app.revokeParticipantCredential({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
      participantId: body.subject.id,
      idempotencyKey: idempotencyKeyOf(request),
    });
  });

  server.post(
    `${API_V1}/games/:gameId/credentials/reissue`,
    async (request) => {
      const body = credentialSubjectSchema.parse(request.body);
      return app.reissueParticipantCredential({
        token: tokenOf(request),
        gameId: idParam(request, 'gameId'),
        participantId: body.subject.id,
        idempotencyKey: idempotencyKeyOf(request),
      });
    },
  );

  server.post(`${API_V1}/games/:gameId/start`, async (request) =>
    app.startGame({
      token: tokenOf(request),
      gameId: idParam(request, 'gameId'),
      idempotencyKey: idempotencyKeyOf(request),
    }),
  );

  server.put(
    `${API_V1}/games/:gameId/participants/:participantId/role`,
    async (request) => {
      const body = assignSchema.parse(request.body);
      return app.assignRole({
        token: tokenOf(request),
        gameId: idParam(request, 'gameId'),
        participantId: idParam(request, 'participantId'),
        role: body.role,
        idempotencyKey: idempotencyKeyOf(request),
      });
    },
  );

  // 進行中のコマンド（sessionId は gameId と同じ）。入力の保存の役割は資格から決まり、版は `If-Match`
  server.put(`${API_V1}/sessions/:sessionId/decisions`, async (request) => {
    const body = saveDecisionSchema.parse(request.body);
    return app.saveOwnDecision({
      token: tokenOf(request),
      gameId: idParam(request, 'sessionId'),
      week: body.week,
      quantity: body.quantity,
      expectedVersion: ifMatchVersionOf(request),
      idempotencyKey: idempotencyKeyOf(request),
    });
  });

  server.post(
    `${API_V1}/sessions/:sessionId/weeks/:week/commit`,
    async (request) => {
      const body = commitWeekSchema.parse(request.body);
      const week = pathWeekOf(request);
      if (week !== body.requestedWeek)
        throw validationProblem([
          {
            field: 'requestedWeek',
            message: '経路の週と、本文の requestedWeek を同じにしてください',
          },
        ]);
      return app.commitWeekWithBasis({
        token: tokenOf(request),
        gameId: idParam(request, 'sessionId'),
        requestedWeek: body.requestedWeek,
        basis: body.basis,
        idempotencyKey: idempotencyKeyOf(request),
      });
    },
  );

  server.post(`${API_V1}/sessions/:sessionId/pause`, async (request) =>
    app.pause({
      token: tokenOf(request),
      gameId: idParam(request, 'sessionId'),
      idempotencyKey: idempotencyKeyOf(request),
    }),
  );

  server.post(`${API_V1}/sessions/:sessionId/resume`, async (request) =>
    app.resume({
      token: tokenOf(request),
      gameId: idParam(request, 'sessionId'),
      idempotencyKey: idempotencyKeyOf(request),
    }),
  );

  server.put(`${API_V1}/sessions/:sessionId/commit-mode`, async (request) => {
    const body = setCommitModeSchema.parse(request.body);
    return app.setCommitMode({
      token: tokenOf(request),
      gameId: idParam(request, 'sessionId'),
      commitMode: body.commitMode,
      idempotencyKey: idempotencyKeyOf(request),
    });
  });

  server.put(
    `${API_V1}/sessions/:sessionId/proxy-decisions/:role`,
    async (request) => {
      const body = proxyDecisionSchema.parse(request.body);
      const role = roleSchema.safeParse(
        (request.params as { role: string }).role,
      );
      if (!role.success)
        throw validationProblem([
          { field: 'role', message: '役割を指定してください' },
        ]);
      return app.submitProxyDecision({
        token: tokenOf(request),
        gameId: idParam(request, 'sessionId'),
        role: role.data,
        requestedWeek: body.requestedWeek,
        quantity: body.quantity,
        idempotencyKey: idempotencyKeyOf(request),
      });
    },
  );
}

/** 経路の週（1〜50 の整数）。そうでなければ 422（field は week） */
function pathWeekOf(request: FastifyRequest): number {
  const raw = (request.params as { week: string }).week;
  const week = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(week) || week < 1 || week > 50)
    throw validationProblem([
      { field: 'week', message: '週は 1〜50 の整数にしてください' },
    ]);
  return week;
}
