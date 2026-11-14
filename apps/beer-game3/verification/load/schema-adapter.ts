/**
 * 整合性の検査が読むテーブルの構造への依存を、この 1 部品に閉じ込める（reliability-design.md「構造への依存」）。
 * 移行でテーブルの構造が変わったら、この部品だけを更新する。SELECT だけを行う。
 */
import type { ReadOnlySession } from './read-only.js';
import type { Role } from '../shared/roles.js';

export interface GameRow {
  gameId: string;
  status: string;
  currentWeek: number;
  weekCount: number;
}

export interface WeekRow {
  gameId: string;
  week: number;
  role: Role;
  decision: number | null;
  isConfirmed: boolean;
}

export async function readGames(session: ReadOnlySession): Promise<GameRow[]> {
  const result = await session.query<{
    game_id: string;
    status: string;
    current_week: number;
    week_count: number;
  }>('select game_id, status, current_week, week_count from games');
  return result.rows.map((row) => ({
    gameId: row.game_id,
    status: row.status,
    currentWeek: row.current_week,
    weekCount: row.week_count,
  }));
}

export async function readWeekRecords(session: ReadOnlySession): Promise<WeekRow[]> {
  const result = await session.query<{
    game_id: string;
    week: number;
    role: Role;
    decision: number | null;
    is_confirmed: boolean;
  }>('select game_id, week, role, decision, is_confirmed from week_records');
  return result.rows.map((row) => ({
    gameId: row.game_id,
    week: row.week,
    role: row.role,
    decision: row.decision,
    isConfirmed: row.is_confirmed,
  }));
}
