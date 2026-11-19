// 画面のアクセシビリティ・拡大・狭い画面の案内・ヘルプのシナリオ（features/cross-cutting/accessibility-ui.feature。X-1）のステップ定義。
// 業務ロジックを持たない。ブラウザの実際の描画（キーボードのフォーカス、表示領域の幅、横スクロール）だけを確かめる。
import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';

const WAIT_MS = 10_000;
const DEFAULT_HEIGHT = 800;
const ZOOM_200_WIDTH = 640; // 幅 1280px の 200% に当たる表示領域
const MAX_TABS = 40;
// macOS の WebKit は、Safari の既定の設定（Tab でリンクとボタンへ移らない）に従う。Option+Tab が、すべての操作部品へ移るキー。
const MAC_WEBKIT = process.env.BROWSER === 'webkit' && process.platform === 'darwin';
const TAB = MAC_WEBKIT ? 'Alt+Tab' : 'Tab';
const SHIFT_TAB = MAC_WEBKIT ? 'Alt+Shift+Tab' : 'Shift+Tab';

const SCREENS = {
    はじめる: { path: '/', heading: 'ビールゲーム' },
    ヘルプ: { path: '/help', heading: 'ヘルプ' },
    ゲーム作成: { path: '/new', heading: 'ゲームを作成' },
    '参加・復帰': { path: '/join', heading: '参加・復帰' },
};

Given('画面の幅は {int}px である', async function (width) {
    await this.page.setViewportSize({ width, height: DEFAULT_HEIGHT });
});

Given('画面で、{word}を開いている', async function (screenName) {
    const screen = SCREENS[screenName];
    assert.ok(screen, `未定義の画面: ${screenName}`);
    await this.page.goto(screen.path);
    this.heading = screen.heading;
    await this.page.getByRole('heading', { level: 1, name: screen.heading }).waitFor({
        timeout: WAIT_MS,
    });
});

When('キーボードの Tab だけで、「ゲームを作成」のボタンへフォーカスを移す', async function () {
    for (let pressed = 0; pressed < MAX_TABS; pressed++) {
        await this.page.keyboard.press(TAB);
        const name = await this.page.evaluate(
            () => document.activeElement?.textContent?.trim() ?? '',
        );
        if (name === 'ゲームを作成') return;
    }
    assert.fail(`Tab を ${MAX_TABS} 回押しても、「ゲームを作成」のボタンにフォーカスが移らない`);
});

When('Enter を押す', async function () {
    await this.page.keyboard.press('Enter');
});

Then('ゲームが作成され、「ロビーへ」の導線が表示される', async function () {
    await this.page.getByRole('link', { name: 'ロビーへ' }).waitFor({ timeout: WAIT_MS });
});

When('Tab を {int} 回押す', async function (times) {
    for (let pressed = 0; pressed < times; pressed++) await this.page.keyboard.press(TAB);
});

Then('フォーカスは見出しにある', async function () {
    const tag = await this.page.evaluate(() => document.activeElement?.tagName);
    assert.equal(tag, 'H1');
});

When('Shift+Tab を {int} 回押す', async function (times) {
    for (let pressed = 0; pressed < times; pressed++) await this.page.keyboard.press(SHIFT_TAB);
});

Then('フォーカスは「本文へスキップ」にある', async function () {
    const name = await this.page.evaluate(() => document.activeElement?.textContent?.trim());
    assert.equal(name, '本文へスキップ');
});

Then('次のフォーカスは、本文の領域の中にある', async function () {
    // スキップのリンクは #main へ移す。次に Tab を押すと、見出しの後ろの本文の操作部品へ進む（ヘッダーのリンクへは戻らない）
    await this.page.keyboard.press(TAB);
    const inMain = await this.page.evaluate(() => {
        const main = document.getElementById('main');
        const active = document.activeElement;
        return main !== null && active !== null && main.contains(active);
    });
    assert.ok(inMain, '次のフォーカスが、本文の領域の外にある');
});

Then('フォーカスされた操作部品の枠線の太さは {int}px 以上である', async function (px) {
    const width = await this.page.evaluate(() => {
        const element = document.activeElement;
        return element ? Number.parseFloat(getComputedStyle(element).outlineWidth) : 0;
    });
    assert.ok(width >= px, `枠線の太さが ${width}px（${px}px 以上が必要）`);
});

When('画面を 200% に拡大する', async function () {
    await this.page.setViewportSize({ width: ZOOM_200_WIDTH, height: DEFAULT_HEIGHT / 2 });
});

Then('横スクロールは発生しない', async function () {
    const { scrollWidth, clientWidth } = await this.page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    assert.ok(
        scrollWidth <= clientWidth,
        `横スクロールが発生する: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`,
    );
});

Then('ページの見出しが見える', async function () {
    const heading = this.page.getByRole('heading', { level: 1 });
    await heading.waitFor({ state: 'visible', timeout: WAIT_MS });
    assert.ok(await heading.isVisible());
});

Then('「1024px 以上」の幅での利用を想定している旨の案内が表示される', async function () {
    const note = this.page.getByRole('note', { name: '画面の大きさについて' });
    await note.waitFor({ timeout: WAIT_MS });
    assert.match(await note.innerText(), /1024px 以上/);
});

When('案内を閉じる', async function () {
    await this.page.getByRole('button', { name: '案内を閉じる' }).click({ timeout: WAIT_MS });
});

Then('案内は表示されない', async function () {
    assert.equal(await this.page.getByRole('note').count(), 0);
});

When('「ヘルプ」を開く', async function () {
    await this.page.getByRole('link', { name: 'ヘルプ' }).click({ timeout: WAIT_MS });
    await this.page.getByRole('heading', { level: 1, name: 'ヘルプ' }).waitFor({
        timeout: WAIT_MS,
    });
});

Then(
    'ヘルプに、「遊び方」「1 週に起きること」「4 つの役割」「データの扱い」の節が示される',
    async function () {
        const headings = await this.page.getByRole('heading', { level: 2 }).allInnerTexts();
        assert.deepEqual(headings, ['遊び方', '1 週に起きること', '4 つの役割', 'データの扱い']);
    },
);

Then('「1 週に起きること」に、入荷・出荷・費用の手順が示される', async function () {
    const text = await this.page.getByRole('region', { name: '1 週に起きること' }).innerText();
    for (const word of ['入荷', '出荷', '費用']) {
        assert.ok(text.includes(word), `「${word}」が無い: ${text}`);
    }
});
