/** 4 つの役割。顧客に近い順ではなく、出荷（モノ）の上流から下流の順に並べる。 */
export const ROLES = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  factory: '工場',
  wholesaler1: '一次卸',
  wholesaler2: '二次卸',
  retailer: '小売店',
};

/** 出荷の向き（工場 → 一次卸 → 二次卸 → 小売店）で見た、1 つ上流の役割。工場は null。 */
export const UPSTREAM: Record<Role, Role | null> = {
  factory: null,
  wholesaler1: 'factory',
  wholesaler2: 'wholesaler1',
  retailer: 'wholesaler2',
};

/** 発注の向き（小売店 → 二次卸 → 一次卸 → 工場）で見た、1 つ下流の役割。小売店は null。 */
export const DOWNSTREAM: Record<Role, Role | null> = {
  factory: 'wholesaler1',
  wholesaler1: 'wholesaler2',
  wholesaler2: 'retailer',
  retailer: null,
};

export type Decisions = Record<Role, number>;

export type GameStatus = 'preparing' | 'running' | 'paused' | 'ended';
/** 終了の理由（BR9.4）。autoEnd は U5 の自動終了が使う。 */
export type EndReason = 'facilitator' | 'finalWeek' | 'autoEnd';
export type SlotKind = 'delivery' | 'order' | 'production';
export type SetupKind = 'kit' | 'custom';

/** 参加者の表示名の最大の文字数（BR2.5）。入力の検証と、画面の説明の両方が使う。 */
export const DISPLAY_NAME_MAX = 40;

/** 発注数（工場は生産要請数）の上限（Functional Design Q1）。 */
export const MAX_DECISION = 9999;
export const MIN_WEEK_COUNT = 1;
export const MAX_WEEK_COUNT = 50;
/**
 * 設定値の上限（BR8.1）。上限の内側なら、50 週の確定が必ず成功し、
 * 費用が 64 ビット整数と JavaScript の安全な整数に収まる（BR8.2）。
 */
export const MAX_INITIAL_QUANTITY = 9999;
export const MAX_DEMAND_VALUE = 9999;
/** 単価の上限（最小単位＝セント。$100.00）。 */
export const MAX_UNIT_COST = 10000;
/** 遅延の週数は固定で、設定項目にしない（BR1.3）。 */
export const FIXED_DELAY_WEEKS = 2;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
