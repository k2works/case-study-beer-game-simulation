/**
 * キーボード試験の、プログラムによる選択（selectOption）への切り替えを許す環境。
 * macOS の選択欄は、矢印キーで OS 標準の一覧が開き、自動操作のキー入力が届かないため、macOS に限って許す。
 * Linux と Windows では許さず、矢印キーで値が変わらなければ失敗させる（キー操作の退行を試験が隠さない）。
 */
export function allowsProgrammaticSelect(platform: string): boolean {
  return platform === 'darwin';
}
