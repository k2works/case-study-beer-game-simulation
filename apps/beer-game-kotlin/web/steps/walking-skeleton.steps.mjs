// 画面のウォーキングスケルトンのシナリオ（features/weekly-play/walking-skeleton-ui.feature）のステップ定義。
// 業務ロジックを持たず、画面の窓口（support/console-window.mjs）を呼んで、期待値（受入条件）を確かめるだけにする。
// 窓口は、実 Ktor サーバーと、Playwright のブラウザ（実際の画面）を通す。
import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';

const ROLE_LABELS = ['小売店', '二次卸', '一次卸', '工場'];

Given('4 役割に参加者が割り当てられ、開始されたゲームがある', async function () {
    await this.console.seedStartedGame();
});

Given(
    '第 {int} 週の入力が、小売店 {int}、二次卸 {int}、一次卸 {int}、工場 {int} でそろっている',
    async function (week, retailer, wholesaler, distributor, factory) {
        await this.console.seedDecisions(week, { retailer, wholesaler, distributor, factory });
    },
);

Given('進行役が、進行役のコンソールを開いている', async function () {
    await this.console.open();
});

When('進行役が「週を確定」を押す', async function () {
    await this.console.pressCommitWeek();
});

Then('コンソールに第 {int} 週と表示される', async function (week) {
    assert.match(await this.console.currentWeekText(week), new RegExp(`^第 ${week} 週`));
});

Then(
    'コンソールに、{int} 役割のそれぞれの第 {int} 週の結果が表示される',
    async function (roles, week) {
        assert.equal(roles, ROLE_LABELS.length);
        const lines = await this.console.resultLines();
        for (const label of ROLE_LABELS) {
            assert.ok(
                lines.some((line) => new RegExp(`^${label} 第 ${week} 週の結果`).test(line)),
                `${label} の第 ${week} 週の結果が無い: ${JSON.stringify(lines)}`,
            );
        }
    },
);
