// 画面から保持状態と削除予定日を確かめるシナリオ（apps/beer-game-features/retention/retention-ui.feature）のステップ定義。
// 業務ロジックを持たず、画面の窓口（support/console-window.mjs）を呼んで、期待値（受入条件）を確かめるだけにする。
// 削除の動作・状態の遷移・認可は @api（retention.feature）が確かめる。ここは導線と表示だけ。
import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';

When('進行役が、コンソールから保持状態を開く', async function () {
    await this.console.openRetentionFromConsole();
});

Then('保持状態に、削除予定日と保持期間 {int} 日が示される', async function (days) {
    const table = await this.console.retentionTable();
    // 作成の時刻から保持日数後（UTC の暦日）。ゲームの作成から数秒なので、日付の境界をまたがない限り、今日 + 保持日数
    const expected = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.match(table['削除予定日'], new RegExp(`^(\\d{4}-\\d{2}-\\d{2})（あと ${days} 日）$`));
    const shown = /^(\d{4}-\d{2}-\d{2})/.exec(table['削除予定日'])[1];
    // 実行が UTC の日付の境界をまたぐときだけ、1 日ずれうる
    const gap = Math.abs(new Date(shown).getTime() - new Date(expected).getTime());
    assert.ok(
        gap <= 24 * 60 * 60 * 1000,
        `削除予定日が保持日数と合わない: ${shown}（期待 ${expected}）`,
    );
    assert.equal(table['保持期間'], `${days} 日`);
});

Then('保持状態に、バックアップには削除後も最大 {int} 日残ることが示される', async function (days) {
    const table = await this.console.retentionTable();
    assert.match(table['バックアップ'], new RegExp(`^削除後も最大 ${days} 日残ります`));
});

Then('振り返りの見出しの近くに、削除予定日が示される', async function () {
    const text = await this.console.reviewText();
    assert.match(text, /削除予定日: \d{4}-\d{2}-\d{2}（あと \d+ 日）/);
});
