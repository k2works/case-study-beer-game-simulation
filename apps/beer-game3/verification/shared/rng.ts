import { ROLES, type Role } from './roles.js';

/** 32 ビットの状態を持つ擬似乱数生成器（mulberry32）。依存を増やさない。[0, 1) の値を返す。 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 複数の整数から 1 つの 32 ビットの種を作る（順序に依存しない生成のため）。 */
function mix(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0x5bd1e995);
  }
  return hash >>> 0;
}

export interface PlanItem {
  team: number;
  week: number;
  role: Role;
  quantity: number;
}

/** 発注数の上限（要求の列の値の範囲は 0〜MAX_QUANTITY）。 */
export const MAX_QUANTITY = 12;

/**
 * 種付きの要求の列（SeededPlan）。時刻や応答に依存しない項目（チーム、週、役割、意思決定の値）だけで定義し、
 * 同じ種と設定から、生成の順序に関わらず同じ値を返す。チームごとに別の列になり、互いに影響しない。
 */
export class SeededPlan {
  constructor(private readonly seed: number) {}

  quantity(team: number, week: number, role: Role): number {
    const roleIndex = ROLES.indexOf(role);
    const rng = createRng(mix(this.seed, team, week, roleIndex));
    return Math.floor(rng() * (MAX_QUANTITY + 1));
  }

  /** 1 チームの第 1 週から weeks 週までの要求の列（週、役割の順）。 */
  sequence(team: number, weeks: number): PlanItem[] {
    const items: PlanItem[] = [];
    for (let week = 1; week <= weeks; week += 1) {
      for (const role of ROLES) {
        items.push({ team, week, role, quantity: this.quantity(team, week, role) });
      }
    }
    return items;
  }
}

/** 試験用の架空の表示名（例: 「試験チーム 03 工場」）。実在の個人や組織を指す語を使わない（NFR7.1）。 */
export function displayNameFor(team: number, label: string): string {
  return `試験チーム ${String(team + 1).padStart(2, '0')} ${label}`;
}
