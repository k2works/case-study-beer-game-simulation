import { ROLES, type Role } from '../../../src/server/domain/types.js';
import type { ResultsView } from '../../../src/web/api.js';

/** 結果の応答（週ごと・役割ごとの値が、役割と週から決まる）。 */
export function makeView(weeks = 3, overrides: Partial<ResultsView> = {}): ResultsView {
  const roles = ROLES.map((role, r) => {
    let cumulative = 0;
    return {
      role,
      weeks: Array.from({ length: weeks }, (_, index) => {
        const week = index + 1;
        const inventory = 10 + r * 3 + week;
        const backlog = r * week;
        const weeklyCost = inventory * 50 + backlog * 100;
        cumulative += weeklyCost;
        return {
          week,
          receipt: 4 + r,
          ordersReceived: 4 + r + week,
          shipped: 3 + r + (week % 2),
          inventory,
          backlog,
          decision: 2 + r * 2 + week,
          weeklyCost,
          cumulativeCost: cumulative,
        };
      }),
    };
  });
  return {
    gameId: 'g1',
    setupKind: 'custom',
    weekCount: Math.max(weeks, 3),
    confirmedWeeks: weeks,
    customerDemand: Array.from({ length: weeks }, (_, i) => 4 + (i % 3)),
    roles,
    teamCumulativeCost: roles.reduce((sum, r) => sum + (r.weeks.at(-1)?.cumulativeCost ?? 0), 0),
    ...overrides,
  };
}

export const roleValues = (
  view: ResultsView,
  role: Role,
  pick: (week: ResultsView['roles'][number]['weeks'][number]) => number,
): number[] => view.roles.find((r) => r.role === role)!.weeks.map(pick);

/** WCAG のコントラスト比（相対輝度から）。 */
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = channels.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
