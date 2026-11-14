import { describe, expect, it } from 'vitest';
import {
  analyzeConsistency,
  type GameRow,
  type WeekRow,
} from '../../../verification/load/consistency.js';
import { ROLES } from '../../../verification/shared/roles.js';

// 機能: 負荷の後にデータが壊れていない（NFR2.1）。純粋な分析の部分

const game = (over: Partial<GameRow> = {}): GameRow => ({
  gameId: 'g1',
  status: 'running',
  currentWeek: 3,
  weekCount: 10,
  ...over,
});

const confirmedWeek = (week: number, quantity = 4): WeekRow[] =>
  ROLES.map((role) => ({ gameId: 'g1', week, role, decision: quantity, isConfirmed: true }));

describe('シナリオ: 整合性の分析', () => {
  it('Given 週 1〜2 が各 4 役割で確定し current_week が 3 When 分析する Then 崩れなし', () => {
    const result = analyzeConsistency([game()], [...confirmedWeek(1), ...confirmedWeek(2)], []);
    expect(result).toEqual({ checkedGames: 1, broken: [] });
  });

  it('Given 週の欠け（1 と 3 だけ確定）When 分析する Then missing_week を週つきで返す', () => {
    const result = analyzeConsistency(
      [game({ currentWeek: 4 })],
      [...confirmedWeek(1), ...confirmedWeek(3)],
      [],
    );
    expect(result.broken).toContainEqual({ gameId: 'g1', week: 2, kind: 'missing_week' });
  });

  it('Given 週が 3 役割しか確定していない When 分析する Then incomplete_week', () => {
    const rows = confirmedWeek(1).slice(0, 3);
    const result = analyzeConsistency([game({ currentWeek: 2 })], rows, []);
    expect(result.broken).toContainEqual({ gameId: 'g1', week: 1, kind: 'incomplete_week' });
  });

  it('Given 同じ週が 2 回確定（役割の行が重なる）When 分析する Then duplicate_week', () => {
    const rows = [...confirmedWeek(1), ...confirmedWeek(1)];
    const result = analyzeConsistency([game({ currentWeek: 2 })], rows, []);
    expect(result.broken).toContainEqual({ gameId: 'g1', week: 1, kind: 'duplicate_week' });
  });

  it('Given current_week が最後の確定の週 + 1 と合わない When 分析する Then current_week_mismatch', () => {
    const result = analyzeConsistency([game({ currentWeek: 5 })], confirmedWeek(1), []);
    expect(result.broken).toContainEqual({ gameId: 'g1', week: 5, kind: 'current_week_mismatch' });
  });

  it('Given 終了後（ended）で current_week が week_count When 分析する Then 合う', () => {
    const rows = [1, 2, 3].flatMap((w) => confirmedWeek(w));
    const result = analyzeConsistency(
      [game({ status: 'ended', currentWeek: 3, weekCount: 3 })],
      rows,
      [],
    );
    expect(result.broken).toEqual([]);
  });

  it('Given 準備中（確定なし）で current_week が 1 When 分析する Then 合う', () => {
    expect(
      analyzeConsistency([game({ status: 'preparing', currentWeek: 1 })], [], []).broken,
    ).toEqual([]);
  });

  it('Given 成功応答の値が保存されていない When 台帳と突き合わせる Then missing_value', () => {
    const ledger = [{ gameId: 'g1', week: 1, role: 'factory' as const, quantity: 9 }];
    const result = analyzeConsistency([game({ currentWeek: 1 })], [], ledger);
    expect(result.broken).toContainEqual({ gameId: 'g1', week: 1, kind: 'missing_value' });
  });

  it('Given 保存された値が成功応答の値と違う When 突き合わせる Then value_mismatch', () => {
    const rows = confirmedWeek(1, 4);
    const ledger = [{ gameId: 'g1', week: 1, role: 'factory' as const, quantity: 9 }];
    const result = analyzeConsistency([game({ currentWeek: 2 })], rows, ledger);
    expect(result.broken).toContainEqual({ gameId: 'g1', week: 1, kind: 'value_mismatch' });
  });

  it('Given 台帳にない保存（応答前に切れた要求）When 突き合わせる Then 異常と扱わない', () => {
    const result = analyzeConsistency([game({ currentWeek: 2 })], confirmedWeek(1), []);
    expect(result.broken).toEqual([]);
  });
});
