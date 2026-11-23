import { ROLES, type Role } from './role.js';
import type { Session } from './session.js';

/** 当週の段階 */
export type Step = 'INPUT' | 'AWAITING_COMMIT' | 'PAUSED' | 'ENDED';

/** 1 ゲームの観察者の上限（仮の値。未決事項 4） */
export const OBSERVER_LIMIT = 20;

/** 合計を示すのに必要な寄与者の数。1 役割だけの合計は、個別の値そのものになる */
export const MIN_CONTRIBUTORS = 2;

/**
 * 観察（プレイ中に観察者へ見せる、逆算できない投影）。役割別の値と需要は含めない。
 * 合計は、公開範囲が「進行状況だけ」なら null。寄与者が足りない合計は null（非表示）。
 */
export interface Observation {
  status: Session['status'];
  week: number;
  step: Step;
  /** 完了状況（どの役割が入力済みか。値は含めない） */
  submitted: Record<Role, boolean>;
  totals: {
    /** 在庫・受注残の合計の対象の週。未確定なら null */
    lastCommittedWeek: number | null;
    inventory: number | null;
    backlog: number | null;
    /** 当週の入力済みの役割の注文の合計 */
    orders: number | null;
  } | null;
}

const sumIfSafe = (values: readonly number[]) =>
  values.length >= MIN_CONTRIBUTORS ? values.reduce((a, v) => a + v, 0) : null;

function stepOf(session: Session): Step {
  if (session.status === 'ENDED') return 'ENDED';
  if (session.status === 'PAUSED') return 'PAUSED';
  return ROLES.every((r) => session.decisions[r] !== undefined)
    ? 'AWAITING_COMMIT'
    : 'INPUT';
}

/**
 * 開示の判定（DisclosurePolicy）。公開範囲と寄与者の数だけから、観察に出してよい集計を決める（純粋関数）。
 *
 * @landmark 観察者への開示の判定。役割別の値と需要を出さず、合計は寄与者が 2 役割以上のときだけ出す。参加者には開かせない（自分の値から相手の値を逆算できるため）。
 */
export function observe(session: Session): Observation {
  const submitted = Object.fromEntries(
    ROLES.map((r) => [r, session.decisions[r] !== undefined]),
  ) as Record<Role, boolean>;
  const base = {
    status: session.status,
    week: session.week,
    step: stepOf(session),
    submitted,
  };
  if (session.settings.disclosure === 'PROGRESS_ONLY')
    return { ...base, totals: null };
  const last = session.history.at(-1);
  const orders = ROLES.flatMap((r) => {
    const d = session.decisions[r];
    return d ? [d.quantity] : [];
  });
  return {
    ...base,
    totals: {
      lastCommittedWeek: last?.week ?? null,
      inventory: last
        ? sumIfSafe(ROLES.map((r) => last.roles[r].endingInventory))
        : null,
      backlog: last
        ? sumIfSafe(ROLES.map((r) => last.roles[r].endingBacklog))
        : null,
      orders: sumIfSafe(orders),
    },
  };
}
