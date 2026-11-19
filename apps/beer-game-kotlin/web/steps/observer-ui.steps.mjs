// 画面で観察者を招き、観察するシナリオ（features/observation/observer-ui.feature）のステップ定義。
// 業務ロジックを持たず、画面の窓口（support/console-window.mjs）を呼んで、期待値（受入条件）を確かめるだけにする。
import { Given, When, Then } from '@cucumber/cucumber';

Given('第 {int} 週が、各役割 {int} の入力で確定されている', async function (week, quantity) {
    await this.console.commitSeededWeek(week, quantity);
});

When('進行役が、ロビーで観察用の招待を発行する', async function () {
    await this.console.issueInvitationOnLobby();
});

When('進行役が、ロビーでその招待を失効させる', async function () {
    await this.console.revokeInvitationOnLobby();
});

When('観察者が、画面で、招待コードと表示名「{word}」で参加する', async function (name) {
    await this.console.joinAsObserverOnScreen(name);
});

Then(
    '観察画面に、第 {int} 週と、第 {int} 週のチーム合計（注文 {int}）が表示される',
    async function (currentWeek, week, order) {
        await this.console.observationShows(currentWeek, week, order);
    },
);

Then('観察画面に、役割別の値や入力の操作は表示されない', async function () {
    await this.console.observationReadOnly();
});

Then(
    '観察者の参加の画面に、「招待が無効です（失効または期限切れ）。進行役に確認してください。」と表示される',
    async function () {
        await this.console.textShown(
            '招待が無効です（失効または期限切れ）。進行役に確認してください。',
            this.console.observerPage,
        );
    },
);
