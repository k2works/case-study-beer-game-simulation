// 画面から結果を出力するシナリオ（features/export/export-ui.feature）のステップ定義。
// 業務ロジックを持たず、画面の窓口（support/console-window.mjs）を呼んで、期待値（受入条件）を確かめるだけにする。
// 列・値の中身と形式の一致は @api（export.feature）が確かめるので、ここは、導線とダウンロードの結線だけ。
import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';

When('進行役が、コンソールから振り返りを開く', async function () {
    await this.console.openReviewFromConsole();
});

When('進行役が、振り返りの画面で「{}」を押す', async function (label) {
    await this.console.pressExport(label);
});

Then('結果の CSV がダウンロードされ、設定の種別と全週の行が含まれる', async function () {
    const { filename, text } = await this.console.downloadedFile();
    assert.match(filename, /^beer-game-.+\.csv$/);
    const lines = text.split('\r\n').filter((line) => line !== '');
    assert.match(lines[0], /^schema_version,game_id,settings_kind,/);
    // 見出し + 12 週 × 4 役割
    assert.equal(lines.length, 1 + 12 * 4);
    assert.ok(lines.slice(1).every((line) => line.split(',')[2] === 'KIT'));
});
