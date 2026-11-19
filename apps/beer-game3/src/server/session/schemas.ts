import { z } from 'zod';
import {
  DISPLAY_NAME_MAX,
  MAX_DECISION,
  MAX_DEMAND_VALUE,
  MAX_INITIAL_QUANTITY,
  MAX_UNIT_COST,
  MAX_WEEK_COUNT,
  MIN_WEEK_COUNT,
  isRole,
  type Role,
} from '../domain/types.js';
import { validationError, type FieldProblem } from '../errors.js';

/** 既定の設定（キットの既定値。金額は整数の最小単位＝セント）。 */
export const DEFAULTS = {
  initialInventory: 12,
  initialPipelineQuantity: 4,
  inventoryUnitCost: 50,
  backlogUnitCost: 100,
} as const;

export const NAME_MAX = 60;
export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 128;

/** 0 以上 max 以下の整数（BR8.1）。上限は、確定が必ず成功する範囲。メッセージに上限を含める。 */
const boundedInt = (label: string, max: number) =>
  z
    .int({ error: `${label}は 0 以上 ${max} 以下の整数で入力してください` })
    .min(0, { error: `${label}は 0 以上 ${max} 以下の整数で入力してください` })
    .max(max, { error: `${label}は 0 以上 ${max} 以下の整数で入力してください` });

const codePointLength = (value: string): number => [...value].length;

const createGameSchema = z
  .strictObject(
    {
      name: z
        .string({ error: 'ゲーム名を入力してください' })
        .trim()
        .refine((v) => codePointLength(v) >= 1, { error: 'ゲーム名を入力してください' })
        .refine((v) => codePointLength(v) <= NAME_MAX, {
          error: `ゲーム名は ${NAME_MAX} 文字以内で入力してください`,
        }),
      weekCount: z
        .int({ error: '週数は 1〜50 の整数で入力してください' })
        .min(MIN_WEEK_COUNT, { error: '週数は 1〜50 の整数で入力してください' })
        .max(MAX_WEEK_COUNT, { error: '週数は 1〜50 の整数で入力してください' }),
      demandSeries: z
        .array(boundedInt('需要系列の値', MAX_DEMAND_VALUE), {
          error: '需要系列は 0 以上の整数の並びで入力してください',
        })
        .optional(),
      initialInventory: boundedInt('初期在庫', MAX_INITIAL_QUANTITY).optional(),
      initialPipelineQuantity: boundedInt('初期パイプライン数量', MAX_INITIAL_QUANTITY).optional(),
      inventoryUnitCost: boundedInt('在庫単価', MAX_UNIT_COST).optional(),
      backlogUnitCost: boundedInt('受注残単価', MAX_UNIT_COST).optional(),
    },
    { error: 'ゲームの設定を入力してください' },
  )
  .superRefine((value, ctx) => {
    if (value.demandSeries && value.demandSeries.length !== value.weekCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['demandSeries'],
        message: `需要系列の長さ（${value.demandSeries.length}）が週数（${value.weekCount}）と一致しません`,
      });
    }
  });

export type CreateGameInput = z.infer<typeof createGameSchema>;

/**
 * 表示名の先頭に使えない文字（BR23.10、NFR6.8）。表計算ソフトが式として実行しうる = + - @ と、
 * 正規化（前後の空白の除去）の定義が将来変わっても防ぎが外れないよう、タブと復帰も含める。
 */
export const FORBIDDEN_DISPLAY_NAME_STARTS: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];

export const DISPLAY_NAME_FORBIDDEN_START_REASON = '表示名の先頭に使えない文字があります';
export const DISPLAY_NAME_FORBIDDEN_START_HINT = '= + - @ 以外の文字で始まる名前にしてください';

/**
 * 参加者の表示名（1〜40 文字）。参加（join）と担当者の入れ替え（replace）が、この 1 つの定義を使う。
 * 先頭の判定は、保存する値と同じ正規化（前後の空白の除去）をしたあとの値に対して行う。したがって
 * 「 =1+1」や「\t=1」も、正規化後に = で始まるため拒否される。
 */
export const displayName = z
  .string({ error: '表示名を入力してください' })
  .trim()
  .refine((v) => codePointLength(v) >= 1, { error: '表示名を入力してください' })
  .refine((v) => codePointLength(v) <= DISPLAY_NAME_MAX, {
    error: `表示名は ${DISPLAY_NAME_MAX} 文字以内で入力してください`,
  })
  .refine((v) => !FORBIDDEN_DISPLAY_NAME_STARTS.some((start) => v.startsWith(start)), {
    error: DISPLAY_NAME_FORBIDDEN_START_REASON,
  });

const joinSchema = z.strictObject(
  {
    joinCode: z
      .string({ error: '参加コードを入力してください' })
      .min(1, { error: '参加コードを入力してください' }),
    displayName,
  },
  { error: '参加コードと表示名を入力してください' },
);

const replacementSchema = z.strictObject(
  {
    participantId: z.uuid({ error: '入れ替える担当者を指定してください' }),
    displayName,
  },
  { error: '入れ替える担当者と新しい担当者の表示名を指定してください' },
);

const decisionSchema = z.strictObject(
  {
    quantity: z
      .int({ error: `発注数は 0 以上 ${MAX_DECISION} 以下の整数で入力してください` })
      .min(0, { error: `発注数は 0 以上 ${MAX_DECISION} 以下の整数で入力してください` })
      .max(MAX_DECISION, { error: `発注数は 0 以上 ${MAX_DECISION} 以下の整数で入力してください` }),
  },
  { error: `発注数を 0 以上 ${MAX_DECISION} 以下の整数で入力してください` },
);

/** zod の誤りを、項目ごとの日本語の理由にする（最初の誤りを項目ごとに 1 つ）。 */
function toFields(error: z.ZodError): FieldProblem[] {
  const fields = new Map<string, string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        fields.set(key, 'この項目は設定できません（遅延の週数などは固定です）');
      }
      continue;
    }
    const path = typeof issue.path[0] === 'string' ? issue.path[0] : '';
    if (!fields.has(path)) {
      fields.set(path, issue.message);
    }
  }
  return [...fields].map(([path, message]) => ({ path, message }));
}

function parse<T>(schema: z.ZodType<T>, body: unknown, reason: string, hint: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = toFields(result.error);
    // 表示名の先頭の文字の拒否は、直し方を具体的に示す（BR23.10）
    const forbiddenStart = fields.some((f) => f.message === DISPLAY_NAME_FORBIDDEN_START_REASON);
    throw validationError(
      `${reason}（${fields.map((f) => f.message).join('、')}）`,
      forbiddenStart ? DISPLAY_NAME_FORBIDDEN_START_HINT : hint,
      fields,
    );
  }
  return result.data;
}

export function parseCreateGame(body: unknown): CreateGameInput {
  return parse(
    createGameSchema,
    body,
    'ゲームの設定に誤りがあります',
    `週数は 1〜50、各値は 0 以上の整数で入力してください（初期在庫・初期パイプライン数量・需要系列の各値は ${MAX_INITIAL_QUANTITY} 以下、単価は ${MAX_UNIT_COST} 以下のセント）。需要系列は週数と同じ長さにしてください`,
  );
}

export function parseJoin(body: unknown): z.infer<typeof joinSchema> {
  return parse(
    joinSchema,
    body,
    '参加の入力に誤りがあります',
    '参加コードと 1〜40 文字の表示名を入力してください',
  );
}

export function parseReplacement(body: unknown): z.infer<typeof replacementSchema> {
  return parse(
    replacementSchema,
    body,
    '担当者の入れ替えの入力に誤りがあります',
    '入れ替える担当者の識別子と、1〜40 文字の新しい表示名を指定してください',
  );
}

export function parseDecision(body: unknown): z.infer<typeof decisionSchema> {
  return parse(
    decisionSchema,
    body,
    '発注数に誤りがあります',
    `0 以上 ${MAX_DECISION} 以下の整数を入力してください（0 も入力できます）`,
  );
}

export function parseRoleAssignment(body: unknown): Role | null {
  const role =
    typeof body === 'object' && body !== null ? (body as { role?: unknown }).role : undefined;
  if (role === null) {
    return null;
  }
  if (!isRole(role)) {
    throw validationError(
      '役割の指定に誤りがあります',
      '工場・一次卸・二次卸・小売店のいずれかを指定してください',
      [{ path: 'role', message: '役割を指定してください' }],
    );
  }
  return role;
}

/** Idempotency-Key の検査。認可のあと、再送の照合の前に行う（NFR6.7）。 */
export function requireIdempotencyKey(key: string | undefined): string {
  if (
    typeof key !== 'string' ||
    key.length < IDEMPOTENCY_KEY_MIN ||
    key.length > IDEMPOTENCY_KEY_MAX
  ) {
    throw validationError(
      'Idempotency-Key が必要です',
      `${IDEMPOTENCY_KEY_MIN}〜${IDEMPOTENCY_KEY_MAX} 文字の識別子を付けてください`,
      [
        {
          path: 'Idempotency-Key',
          message: `${IDEMPOTENCY_KEY_MIN}〜${IDEMPOTENCY_KEY_MAX} 文字で指定してください`,
        },
      ],
    );
  }
  return key;
}
