// 画面の停止・再開、復帰、参加のシナリオ（features/continuation/*-ui.feature、features/game-setup/joining-ui.feature）の
// ステップ定義。業務ロジックを持たず、画面の窓口（support/console-window.mjs）を呼んで、期待値（受入条件）を確かめるだけにする。
import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';

const ROLE_BY_LABEL = {
    小売店: 'RETAILER',
    二次卸: 'WHOLESALER',
    一次卸: 'DISTRIBUTOR',
    工場: 'FACTORY',
};

const roleOf = (label) => {
    const role = ROLE_BY_LABEL[label];
    assert.ok(role, `未知の役割: ${label}`);
    return role;
};

Given('進行役が、キット準拠のゲームを作成している', async function () {
    await this.console.createGame();
});

Given('{word}の参加者が、プレイの画面を開いている', async function (label) {
    await this.console.openPlayAs(roleOf(label));
});

When('進行役が、コンソールで停止する', async function () {
    await this.console.pause();
});

When('進行役が、コンソールで再開する', async function () {
    await this.console.resume();
});

Then('コンソールに、第 {int} 週が{word}であると表示される', async function (week, status) {
    await this.console.consoleStatusShown(week, status);
});

Then('{word}の参加者のプレイの画面に、停止中で入力できない旨が表示される', async function (label) {
    await this.console.playerSeesPaused(roleOf(label));
});

Then('{word}の参加者のプレイの画面で、入力できる', async function (label) {
    await this.console.playerCanInput(roleOf(label));
});

Given('進行役のブラウザセッションが失われている', async function () {
    await this.console.loseFacilitatorSession();
});

Given('進行役のブラウザセッションと復帰資格が失われている', async function () {
    await this.console.loseFacilitatorCredentials();
});

Given('{word}の参加者のブラウザセッションが失われている', async function (label) {
    await this.console.loseParticipantSession(roleOf(label));
});

When('進行役が、進行役のコンソールを開こうとする', async function () {
    await this.console.openConsoleDirectly();
});

Then('権限が無い旨と、参加・復帰の画面への導線が表示される', async function () {
    const { text, href } = await this.console.unauthorizedNoticeWithRecoveryLink();
    assert.match(text, /この画面を開く権限がありません。/);
    assert.equal(href, `/join?gameId=${this.console.gameId}`);
});

When('進行役が、導線から復帰画面を開き、復帰コードを入れずに復帰する', async function () {
    await this.console.recoverViaLink();
});

When(
    '進行役が、復帰画面で、ゲーム ID と作成時に控えた復帰コードを入れて復帰する',
    async function () {
        await this.console.recoverWith(this.console.recoveryCode);
    },
);

When('進行役が、復帰画面で、ゲーム ID と誤った復帰コードを入れて復帰する', async function () {
    await this.console.recoverWith('WRONG-RECOVERY-CODE');
});

Then('同じゲームの進行コンソールが表示される', async function () {
    await this.console.consoleShown();
});

When(
    '{word}の参加者が、プレイの画面を開き直し、導線から復帰画面を開いて復帰する',
    async function (label) {
        const { page } = this.console.players.get(roleOf(label));
        await page.goto(`/games/${this.console.gameId}/play`);
        await this.console.unauthorizedNoticeWithRecoveryLink(page);
        await this.console.recoverViaLink(page);
    },
);

Then('{word}のプレイの画面が表示される', async function (label) {
    await this.console.playShown(roleOf(label), label);
});

Then('「復帰用の資格が無効です。進行役に確認してください。」と表示される', async function () {
    await this.console.textShown('復帰用の資格が無効です。進行役に確認してください。');
});

Then('復帰コードの再発行を進行役に依頼する案内が表示される', async function () {
    await this.console.textShown(
        '復帰コードが分からない場合は、進行役に、復帰コードの再発行を依頼してください。',
    );
});

Then('進行役のコンソールは表示されない', async function () {
    await this.console.consoleNotShown();
});

When('参加者が、画面で、有効な参加コードと表示名「田中」で参加する', async function () {
    await this.console.joinFromScreen('田中');
});

Then('プレイの画面で、進行役が開始するまでお待ちください、と表示される', async function () {
    await this.console.waitingForStartShown();
});

When('進行役が、画面で、小売店の初期在庫を 20、配送の遅延を 3 週に変えて、ゲームを作成する', async function () {
    await this.console.createCustomGameOnScreen();
});

Then('ロビーに、{string}と表示される', async function (text) {
    await this.console.lobbyShowsSettings(text);
});
