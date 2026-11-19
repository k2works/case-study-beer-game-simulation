/**
 * 検証の部品が使う役割の一覧。アプリケーションの内部を import せず、公開の面（HTTP）の語彙だけを持つ。
 * 値は API の役割の値（供給の流れの上流から下流の順）。
 */
export const ROLES = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const;

export type Role = (typeof ROLES)[number];

/** 表示名に使う、役割の日本語の呼び名。 */
export const ROLE_LABELS: Record<Role, string> = {
  factory: '工場',
  wholesaler1: '一次卸',
  wholesaler2: '二次卸',
  retailer: '小売店',
};
