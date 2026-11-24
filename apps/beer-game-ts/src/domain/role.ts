/** 4 つの役割。供給の流れの上流から並ぶ（工場 → 一次卸 → 二次卸 → 小売店）。 */
export const ROLES = [
  'FACTORY',
  'DISTRIBUTOR',
  'WHOLESALER',
  'RETAILER',
] as const;
/**
 * @term 役割 | サプライチェーン上の位置。工場・一次卸・二次卸・小売店の 4 つで、上流から下流の順に並ぶ | ドメインモデル ユビキタス言語
 */
export type Role = (typeof ROLES)[number];

/** 役割の表示名（利用者に示す文言用） */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  FACTORY: '工場',
  DISTRIBUTOR: '一次卸',
  WHOLESALER: '二次卸',
  RETAILER: '小売店',
};

export function isRole(value: unknown): value is Role {
  return (
    typeof value === 'string' && (ROLES as readonly string[]).includes(value)
  );
}

/** 出荷先（下流）。小売店の下流は顧客で、役割ではない。 */
export function downstreamOf(role: Role): Role | null {
  const i = ROLES.indexOf(role);
  return ROLES[i + 1] ?? null;
}

/** 発注先（上流）。工場の上流は生産で、役割ではない。 */
export function upstreamOf(role: Role): Role | null {
  const i = ROLES.indexOf(role);
  return i > 0 ? (ROLES[i - 1] ?? null) : null;
}
