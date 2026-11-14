import type { BrokenItem } from '../shared/summary.js';
import { ROLES } from '../shared/roles.js';
import type { LedgerEntry } from './recorder.js';
import { openReadOnlySession } from './read-only.js';
import { readGames, readWeekRecords, type GameRow, type WeekRow } from './schema-adapter.js';

export { openReadOnlySession } from './read-only.js';
export type { ReadOnlySession } from './read-only.js';
export type { GameRow, WeekRow } from './schema-adapter.js';

export interface ConsistencyResult {
  checkedGames: number;
  broken: BrokenItem[];
}

/**
 * 整合性の分析（純粋な関数。NFR2.1）。各ゲームについて次を確かめる。
 * (1) 確定済みの週が 1 から欠けず連続し、各 4 役割がそろっている。(2) 同じ週が二重に確定されていない。
 * (3) current_week が最後の確定の週 + 1（終了後は week_count）に合う。
 * (4) 成功応答で返した入力の値（台帳）が保存されている。台帳にない保存は異常と扱わない。
 */
export function analyzeConsistency(
  games: readonly GameRow[],
  records: readonly WeekRow[],
  ledger: readonly LedgerEntry[],
): ConsistencyResult {
  const broken: BrokenItem[] = [];
  const byGame = new Map<string, WeekRow[]>();
  for (const record of records) {
    const list = byGame.get(record.gameId) ?? [];
    list.push(record);
    byGame.set(record.gameId, list);
  }

  for (const game of games) {
    const rows = byGame.get(game.gameId) ?? [];
    const confirmed = rows.filter((row) => row.isConfirmed);
    const maxConfirmed = confirmed.reduce((max, row) => Math.max(max, row.week), 0);

    for (let week = 1; week <= maxConfirmed; week += 1) {
      const weekRows = confirmed.filter((row) => row.week === week);
      const roleCounts = new Map<string, number>();
      for (const row of weekRows) {
        roleCounts.set(row.role, (roleCounts.get(row.role) ?? 0) + 1);
      }
      if (weekRows.length === 0) {
        broken.push({ gameId: game.gameId, week, kind: 'missing_week' });
      } else if ([...roleCounts.values()].some((count) => count > 1)) {
        broken.push({ gameId: game.gameId, week, kind: 'duplicate_week' });
      } else if (ROLES.some((role) => !roleCounts.has(role))) {
        broken.push({ gameId: game.gameId, week, kind: 'incomplete_week' });
      }
    }

    const expectedCurrent = game.status === 'ended' ? game.weekCount : maxConfirmed + 1;
    if (game.currentWeek !== expectedCurrent) {
      broken.push({ gameId: game.gameId, week: game.currentWeek, kind: 'current_week_mismatch' });
    }

    for (const entry of ledger.filter((e) => e.gameId === game.gameId)) {
      const stored = rows.find((row) => row.week === entry.week && row.role === entry.role);
      if (!stored || stored.decision === null) {
        broken.push({ gameId: game.gameId, week: entry.week, kind: 'missing_value' });
      } else if (stored.decision !== entry.quantity) {
        broken.push({ gameId: game.gameId, week: entry.week, kind: 'value_mismatch' });
      }
    }
  }
  return { checkedGames: games.length, broken };
}

/** 読み取り専用の接続で全ゲームを検査する（SELECT のみ）。 */
export async function checkConsistency(
  databaseUrl: string,
  ledger: readonly LedgerEntry[],
): Promise<ConsistencyResult> {
  const session = await openReadOnlySession(databaseUrl);
  try {
    return await session.readTransaction(async (tx) => {
      const games = await readGames(tx);
      const records = await readWeekRecords(tx);
      return analyzeConsistency(games, records, ledger);
    });
  } finally {
    await session.close();
  }
}
