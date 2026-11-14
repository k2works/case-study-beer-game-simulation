import { DISPLAY_NAME_MAX, type Role } from '../server/domain/types.js';

/**
 * 結果画面と出力の日本語の文言の一覧（NFR11.1）。画面の試験が文言を確かめる。
 * 出力の列名と役割の値は、読み戻すための識別子として英語のまま出す（NFR11.2）。ここにあるのは、その説明。
 */

/** 表示名の入力欄の近くに示す制限（BR23.10）。参加と担当者の入れ替えで同じ文言を使う。 */
export const DISPLAY_NAME_RULE = `表示名は ${DISPLAY_NAME_MAX} 文字以内です。先頭に = + - @ は使えません`;

/** 出力ボタンの近くに常に示す注意（BR23.9）。折りたたまない。 */
export const EXPORT_NOTICE =
  '表計算ソフトで CSV を開くとき、表示名が式として実行されないよう注意してください。信頼できない表示名があるときは、テキストとして読み込んでください';

export interface ExportColumnHelp {
  name: string;
  meaning: string;
  unit: string;
}

/** 出力の列名の意味と単位。並びは出力の列と同じ。 */
export const EXPORT_COLUMN_HELP: readonly ExportColumnHelp[] = [
  { name: 'gameId', meaning: 'ゲームの識別子', unit: '—' },
  { name: 'setupKind', meaning: 'キット準拠（kit）かカスタム（custom）か', unit: '—' },
  { name: 'week', meaning: '週（第 1 週から）', unit: '週' },
  { name: 'role', meaning: '役割（値は下の対応表）', unit: '—' },
  { name: 'customerDemand', meaning: 'その週の顧客需要', unit: '個' },
  { name: 'receipt', meaning: '入荷', unit: '個' },
  { name: 'ordersReceived', meaning: '受注', unit: '個' },
  { name: 'shipped', meaning: '出荷', unit: '個' },
  { name: 'inventory', meaning: '週末の在庫', unit: '個' },
  { name: 'backlog', meaning: '週末の受注残', unit: '個' },
  { name: 'decision', meaning: '発注（工場は生産要請）', unit: '個' },
  { name: 'weeklyCostCents', meaning: '当週の費用', unit: 'セント（整数）' },
  { name: 'cumulativeCostCents', meaning: '累積の費用', unit: 'セント（整数）' },
  {
    name: 'decidedByKind',
    meaning:
      '発注を最後に保存した主体（participant: 参加者、facilitator: 進行役。空は以前の版の記録）',
    unit: '—',
  },
  {
    name: 'decidedByDisplayName',
    meaning: '参加者の表示名（入れ替え済みの参加者も含む。値は元のまま）',
    unit: '—',
  },
];

/** 役割の値と日本語の役割名の対応（出力の role 列）。 */
export const EXPORT_ROLE_HELP: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'factory', label: '工場' },
  { value: 'wholesaler1', label: '卸売店 1' },
  { value: 'wholesaler2', label: '卸売店 2' },
  { value: 'retailer', label: '小売店' },
];

export const RESULTS_MESSAGES = {
  title: '結果',
  loading: '結果を読み込んでいます',
  empty: 'まだ確定した週がありません。確定した週ができると、ここに時系列が出ます',
  back: 'ゲームの画面へ戻る',
  open: '結果を見る',
  metricGroup: '指標',
  costGroup: '費用の表示',
} as const;
