import {
  AppError,
  forbiddenError,
  invalidCredentialError,
  stateError,
  unavailableError,
  validationError,
} from '../errors.js';
import type { Snapshot, Store } from '../session/store.js';
import { renderCsv, renderJson } from './csv.js';
import { buildExportDocument } from './export.js';
import { buildResultsView, type ResultsView } from './results.js';

export type ExportFormat = 'csv' | 'json';

/** 出力の応答の中身。ヘッダの値は入口が付ける。ファイル名にゲーム名や表示名は使わない（BR23.7）。 */
export interface ExportFile {
  body: string;
  contentType: string;
  filename: string;
  /** ログに出す行数（週 × 役割） */
  rows: number;
}

export interface ReportingDeps {
  store: Pick<Store, 'readSnapshot'>;
}

/**
 * Reporting: 終了したゲームの結果と出力（C1）。権限の判定（AccessControl）を通ったあとに呼ぶ。
 * 行を占有せず、読み取り専用のスナップショットを 1 回読んで、純粋な関数で整える（BR21.5、NFR3.3）。
 */
export class Reporting {
  private readonly store: ReportingDeps['store'];

  constructor(deps: ReportingDeps) {
    this.store = deps.store;
  }

  /** 結果（ResultsView）。終了前は拒否し、他役割の値も週の数も含めない（BR21.1）。 */
  async results(gameId: string): Promise<ResultsView> {
    const snapshot = await this.read(gameId);
    if (snapshot.game.status !== 'ended') {
      throw forbiddenError(
        'ゲームが終了するまで、結果は見られません',
        'ゲームが終了してから、もう一度開いてください',
      );
    }
    return buildResultsView(snapshot);
  }

  /** 出力。形式の検証（422）のあとに読み、終了前は 409（BR23.1）。 */
  async exportGame(gameId: string, format: unknown): Promise<ExportFile> {
    if (format !== 'csv' && format !== 'json') {
      throw validationError(
        '出力の形式の指定に誤りがあります',
        'csv または json を指定してください',
        [{ path: 'format', message: 'csv または json を指定してください' }],
      );
    }
    const snapshot = await this.read(gameId);
    if (snapshot.game.status !== 'ended') {
      throw stateError(
        'ゲームが終了していないため出力できません',
        'ゲームを終了してから出力してください',
      );
    }
    const document = buildExportDocument(snapshot);
    return {
      body: format === 'csv' ? renderCsv(document.records) : renderJson(document),
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      filename: `beer-game-${gameId}.${format}`,
      rows: document.records.length,
    };
  }

  /**
   * 行を占有しない 1 回の読み取り。見つからなければ（削除済みを含む）、存在しないゲームと同じ 403 にする。
   * 読み取りに失敗したら、空の結果を返さずに 503 にする（reliability-design.md）。
   */
  private async read(gameId: string): Promise<Snapshot> {
    let snapshot: Snapshot | null;
    try {
      snapshot = await this.store.readSnapshot(gameId);
    } catch (error) {
      throw error instanceof AppError
        ? error
        : unavailableError('結果を読み取れません', 'しばらくして、もう一度操作してください');
    }
    if (!snapshot) {
      throw invalidCredentialError();
    }
    return snapshot;
  }
}
