import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  isApiV1,
  notReadyProblem,
  rateLimitedProblem,
  retryExhaustedProblem,
} from '../../src/adapters/http/problems.js';
import {
  cookieOptions,
  recoveryCookieName,
  sessionCookieName,
  tabIdOf,
} from '../../src/adapters/http/session-cookies.js';
import { idempotencyKeyOf } from '../../src/adapters/http/idempotency-key.js';
import { schemaNames } from '../contract/spec.js';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const headers = (h: Record<string, string | undefined>) => ({ headers: h });
const TAB = 'abcdefgh12345678'; // 16 文字

describe('ErrorCode の一覧（契約との一致）', () => {
  it('契約の ErrorCode と、過不足なく一致する', () => {
    const spec = parse(
      readFileSync(
        new URL('../../../beer-game-contracts/openapi.yaml', import.meta.url),
        'utf8',
      ),
    ) as { components: { schemas: { ErrorCode: { enum: string[] } } } };
    expect([...ERROR_CODES].sort()).toEqual(
      [...spec.components.schemas.ErrorCode.enum].sort(),
    );
    expect(schemaNames()).toContain('ErrorCode');
  });
});

describe('/api/v1 の判定', () => {
  it('接頭辞が /api/v1 の経路だけを、新しい problem の対象にする', () => {
    expect(isApiV1('/api/v1/games')).toBe(true);
    expect(isApiV1('/api/v1')).toBe(true);
    expect(isApiV1('/api/v1?x=1')).toBe(true);
    expect(isApiV1('/api/games')).toBe(false);
    expect(isApiV1('/api/v10/games')).toBe(false);
    expect(isApiV1('/health')).toBe(false);
  });
});

describe('X-Tab-Id と Cookie の名前（ADR-020）', () => {
  it('英数字 16〜64 文字なら、タブ別の名前になる', () => {
    const id = tabIdOf(headers({ 'x-tab-id': TAB }));
    expect(id).toBe(TAB);
    expect(sessionCookieName(id)).toBe(`bg_session_${TAB}`);
    expect(recoveryCookieName(id)).toBe(`bg_recovery_${TAB}`);
  });

  it('ヘッダーが無い・形が不正なら、既定の名前', () => {
    for (const bad of [
      {},
      { 'x-tab-id': 'short' },
      { 'x-tab-id': 'a'.repeat(65) },
      { 'x-tab-id': 'has-hyphen-0123456' },
      { 'x-tab-id': '' },
    ]) {
      const id = tabIdOf(headers(bad));
      expect(id).toBeNull();
      expect(sessionCookieName(id)).toBe('bg_session');
      expect(recoveryCookieName(id)).toBe('bg_recovery');
    }
  });

  it('属性: HttpOnly・SameSite=Strict、セッションは 24 時間、復帰は 30 日で復帰の経路だけ', () => {
    expect(cookieOptions('session', true)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 86_400,
    });
    expect(cookieOptions('recovery', false)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api/v1/participations/recover',
      maxAge: 2_592_000,
    });
  });
});

describe('Idempotency-Key', () => {
  it('1〜200 文字の、表示できる ASCII を受ける', () => {
    expect(idempotencyKeyOf(headers({ 'idempotency-key': 'k-1' }))).toBe('k-1');
    const longest = 'a'.repeat(200);
    expect(idempotencyKeyOf(headers({ 'idempotency-key': longest }))).toBe(
      longest,
    );
  });

  it('無い・空・長すぎる・空白や非 ASCII を含むものは 400（validation.invalid_input）', () => {
    for (const bad of [
      {},
      { 'idempotency-key': '' },
      { 'idempotency-key': 'a'.repeat(201) },
      { 'idempotency-key': 'has space' },
      { 'idempotency-key': 'キー' },
    ]) {
      expect(() => idempotencyKeyOf(headers(bad))).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'validation.invalid_input',
        }),
      );
    }
  });
});

describe('problem の既定', () => {
  it('Retry-After は、再試行の上限（1 秒）と、レート制限（窓の残り秒数）にだけ付く', () => {
    expect(retryExhaustedProblem().retryAfterSeconds).toBe(1);
    expect(rateLimitedProblem(42).retryAfterSeconds).toBe(42);
    expect(
      notReadyProblem({ database: false, notifier: true }).retryAfterSeconds,
    ).toBeUndefined();
  });
});
