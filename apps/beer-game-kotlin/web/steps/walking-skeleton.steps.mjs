// 画面のウォーキングスケルトンのシナリオ（features/weekly-play/walking-skeleton-ui.feature）のステップ定義。
// 業務ロジックを持たず、画面の窓口（console）を呼んで、期待値（受入条件）を確かめるだけにする。
// まだ画面と API が無いので、窓口は何もしないスタブ（unwiredConsole）。Given・When は通り、Then のアサーションで失敗する（Red）。
// Step 10・11 で、Playwright で実 Ktor サーバーの画面を操作する実物に差し替える（ブラウザの導入もそのとき）。
import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';

const unwiredConsole = {
  seedStartedGame() {},
  seedDecisions() {},
  open() {},
  pressCommitWeek() {},
  text() {
    return '';
  },
};

Given('4 役割に参加者が割り当てられ、開始されたゲームがある', function () {
  this.console = unwiredConsole;
  this.console.seedStartedGame();
});

Given('第 {int} 週の入力が、小売店 {int}、二次卸 {int}、一次卸 {int}、工場 {int} でそろっている', function (week, retailer, wholesaler, distributor, factory) {
  this.console.seedDecisions(week, { retailer, wholesaler, distributor, factory });
});

Given('進行役が、進行役のコンソールを開いている', function () {
  this.console.open();
});

When('進行役が「週を確定」を押す', function () {
  this.console.pressCommitWeek();
});

Then('コンソールに第 {int} 週と表示される', function (week) {
  assert.match(this.console.text(), new RegExp(`第 ${week} 週`));
});

Then('コンソールに、{int} 役割のそれぞれの第 {int} 週の結果が表示される', function (roles, week) {
  for (const label of ['小売店', '二次卸', '一次卸', '工場']) {
    assert.match(this.console.text(), new RegExp(`${label}.*第 ${week} 週の結果`));
  }
  assert.equal(roles, 4);
});
