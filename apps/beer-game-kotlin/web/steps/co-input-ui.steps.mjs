// 画面の共同入力の競合のシナリオ（features/weekly-play/co-input-ui.feature）のステップ定義。
// 業務ロジックを持たず、画面の窓口（support/console-window.mjs）を呼んで、期待値（受入条件）を確かめるだけにする。
// 窓口のキーは、小売店の 1 人目が RETAILER、2 人目（共同担当）が RETAILER_CO。
import { Given, When, Then } from '@cucumber/cucumber';

const KEY_BY_ORDER = { 1: 'RETAILER', 2: 'RETAILER_CO' };

Given('小売店に共同担当がいる、開始されたゲームがある', async function () {
    await this.console.seedStartedGame({ retailerCoHolder: true });
});

Given('小売店の 2 人の共同担当が、それぞれプレイの画面を開いている', async function () {
    await this.console.openPlayAs(KEY_BY_ORDER[1]);
    await this.console.openPlayAs(KEY_BY_ORDER[2]);
});

When('小売店の {int} 人目が、{int} を保存する', async function (order, quantity) {
    const key = KEY_BY_ORDER[order];
    await this.console.savePlay(key, quantity);
    // 1 人目の保存は、反映されてから 2 人目が保存する（競合を確実に作る）。2 人目の保存は、競合の表示を次のステップで確かめる
    if (order === 1) await this.console.savedAsSelf(key, quantity);
});

Then(
    '小売店の 2 人目の画面に、他の人が先に保存した旨と、最新の値 {int} と、1 人目の保存者の表示が示される',
    async function (latest) {
        await this.console.conflictShown(
            KEY_BY_ORDER[2],
            latest,
            this.console.displayNameOf(KEY_BY_ORDER[1]),
        );
    },
);

Then('小売店の 2 人目の画面に、入力した値 {int} が保持されている', async function (value) {
    await this.console.inputKept(KEY_BY_ORDER[2], value);
});

When('小売店の 2 人目が、この値で保存し直す', async function () {
    await this.console.resave(KEY_BY_ORDER[2]);
});

Then(
    '小売店の 2 人目の画面に、現在の入力 {int} が、自分の保存として表示される',
    async function (value) {
        await this.console.savedAsSelf(KEY_BY_ORDER[2], value);
    },
);
