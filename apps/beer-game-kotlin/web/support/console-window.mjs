// 進行役のコンソールの「窓口」。ステップ定義（薄い層）から、画面の操作と、実バックエンドへの前提の準備（API）を呼ぶ。
// 業務ロジックは持たない。計算の値は @api が確かめるので、ここは画面の結線だけを確かめる。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'playwright';

const ROLES = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];
const ROLE_LABELS = {
    RETAILER: '小売店',
    WHOLESALER: '二次卸',
    DISTRIBUTOR: '一次卸',
    FACTORY: '工場',
};
const WAIT_MS = 10_000;

/** 前提の準備に使う API の呼び出し。失敗は握りつぶさず、本文つきで投げる。 */
async function call(context, method, path, body, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
    const response = await context.fetch(`/api/v1${path}`, {
        method,
        headers,
        data: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok()) {
        throw new Error(`${method} ${path} が ${response.status()}: ${await response.text()}`);
    }
    return response;
}

const PAUSED_TEXT = '停止中です。進行役の再開を待ってください。';

/** 役割ごとの入力欄の名称（画面の表示）。 */
const decisionLabel = (role) => (role === 'FACTORY' ? '生産要請数' : '発注数');

export class ConsoleWindow {
    constructor({ page, browserContext, browser, baseURL }) {
        this.page = page;
        this.browserContext = browserContext;
        this.browser = browser;
        this.baseURL = baseURL;
        this.participants = new Map(); // role -> { context, participantId }
        this.players = new Map(); // role -> { context, page }（参加者の画面。別のブラウザの文脈）
        this.gameId = undefined;
        this.joinCode = undefined;
        this.recoveryCode = undefined; // 進行役が作成時に控えた復帰コード
    }

    /** ゲームを作成する（進行役の資格は、ブラウザの文脈の Cookie に持たせる）。復帰コードと参加コードを控える。 */
    async createGame() {
        const facilitator = this.browserContext.request;
        const created = await call(facilitator, 'POST', '/games', {
            kind: 'KIT',
            finalWeek: 12,
            demand: Array.from({ length: 12 }, () => 4),
        });
        this.gameId = created
            .headers()
            ['location'].replace(/^.*\/games\//, '')
            .replace(/\/state$/, '');
        this.recoveryCode = (await created.json()).recoveryCode;
        const state = await (await call(facilitator, 'GET', `/games/${this.gameId}/state`)).json();
        this.joinCode = state.joinCode;
        return state;
    }

    /** 進行役の資格は、ブラウザの文脈（Cookie の入れ物）に持たせる。参加者は、別々の入れ物にする。 */
    async seedStartedGame() {
        const facilitator = this.browserContext.request;
        const state = await this.createGame();

        for (const role of ROLES) {
            const context = await request.newContext({ baseURL: this.baseURL });
            await call(context, 'POST', '/participations/join', {
                joinCode: state.joinCode,
                displayName: `${ROLE_LABELS[role]}の担当`,
            });
            const mine = await (await call(context, 'GET', `/games/${this.gameId}/state`)).json();
            await call(
                facilitator,
                'PUT',
                `/games/${this.gameId}/participants/${mine.participantId}/role`,
                { role },
            );
            this.participants.set(role, { context, participantId: mine.participantId });
        }
        await call(facilitator, 'POST', `/games/${this.gameId}/start`);
    }

    async seedDecisions(week, quantities) {
        const byRole = {
            RETAILER: quantities.retailer,
            WHOLESALER: quantities.wholesaler,
            DISTRIBUTOR: quantities.distributor,
            FACTORY: quantities.factory,
        };
        for (const role of ROLES) {
            const { context } = this.participants.get(role);
            await call(context, 'PUT', `/sessions/${this.gameId}/decisions`, {
                week,
                quantity: byRole[role],
            });
        }
    }

    async open() {
        await this.page.goto(`/games/${this.gameId}/console`);
        await this.page
            .getByRole('heading', { name: '進行役のコンソール' })
            .waitFor({ timeout: WAIT_MS });
    }

    /** 「週を確定」を押す。確認ダイアログ（ui-design S06）の「第 N 週を確定」まで押して、確定を送る。 */
    async pressCommitWeek() {
        await this.page.getByRole('button', { name: '週を確定' }).click({ timeout: WAIT_MS });
        const dialog = this.page.getByRole('dialog');
        await dialog.waitFor({ timeout: WAIT_MS });
        await dialog.getByRole('button', { name: /^第 \d+ 週を確定$/ }).click({ timeout: WAIT_MS });
    }

    /** 現在の週の表示（「第 N 週　進行中」）。表示されるまで待つ。 */
    async currentWeekText(week) {
        // Playwright の文字列の照合は空白を正規化するので、全角の空白も \s で受ける
        const locator = this.page.getByText(new RegExp(`^第 ${week} 週\\s+(進行中|停止中|終了)$`));
        await locator.waitFor({ timeout: WAIT_MS });
        return locator.textContent();
    }

    /** 確定した週の結果の一覧（1 行ずつ）。 */
    async resultLines() {
        const region = this.page.getByRole('region', { name: '確定した週の結果' });
        await region.waitFor({ timeout: WAIT_MS });
        return region.getByRole('listitem').allTextContents();
    }

    /** 進行役のコンソールの「停止する」を押し、確認ダイアログの「一時停止する」まで押す。 */
    async pause() {
        await this.page.getByRole('button', { name: '停止する' }).click({ timeout: WAIT_MS });
        const dialog = this.page.getByRole('dialog');
        await dialog.waitFor({ timeout: WAIT_MS });
        await dialog.getByRole('button', { name: '一時停止する' }).click({ timeout: WAIT_MS });
    }

    /** 進行役のコンソールの「再開する」を押し、確認ダイアログの「再開する」まで押す。 */
    async resume() {
        await this.page.getByRole('button', { name: '再開する' }).click({ timeout: WAIT_MS });
        const dialog = this.page.getByRole('dialog');
        await dialog.waitFor({ timeout: WAIT_MS });
        await dialog.getByRole('button', { name: '再開する' }).click({ timeout: WAIT_MS });
    }

    /** コンソールの「第 N 週　<状態>」の表示。表示されるまで待つ。 */
    async consoleStatusShown(week, statusLabel) {
        await this.page
            .getByText(new RegExp(`^第 ${week} 週\\s+${statusLabel}$`))
            .waitFor({ timeout: WAIT_MS });
    }

    /** 参加者の画面（別のブラウザの文脈）を、参加者の資格で開く。 */
    async openPlayAs(role) {
        const { context: apiContext } = this.participants.get(role);
        const context = await this.browser.newContext({
            baseURL: this.baseURL,
            locale: 'ja-JP',
            storageState: await apiContext.storageState(),
        });
        const page = await context.newPage();
        this.players.set(role, { context, page });
        await page.goto(`/games/${this.gameId}/play`);
        await page.getByRole('heading', { name: 'プレイ' }).waitFor({ timeout: WAIT_MS });
        await page.getByLabel(decisionLabel(role)).waitFor({ timeout: WAIT_MS });
    }

    /** 自動更新が無い（手動更新だけ）ので、条件を満たすまで「手動更新」を押して確かめる。 */
    async refreshUntil(role, check) {
        const { page } = this.players.get(role);
        let lastError;
        for (let attempt = 0; attempt < 10; attempt++) {
            await page.getByRole('button', { name: '手動更新' }).click({ timeout: WAIT_MS });
            try {
                await check(page);
                return;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }

    async playerSeesPaused(role) {
        await this.refreshUntil(role, async (page) => {
            await page.getByText(PAUSED_TEXT).waitFor({ timeout: 1_500 });
            assert.equal(await page.getByLabel(decisionLabel(role)).isDisabled(), true);
        });
    }

    async playerCanInput(role) {
        await this.refreshUntil(role, async (page) => {
            await page.getByText(PAUSED_TEXT).waitFor({ state: 'detached', timeout: 1_500 });
            assert.equal(await page.getByLabel(decisionLabel(role)).isEnabled(), true);
        });
    }

    /** ブラウザセッション（Cookie bg_session）だけを失う。復帰資格（bg_recovery）は残る。 */
    async loseFacilitatorSession() {
        await this.browserContext.clearCookies({ name: 'bg_session' });
    }

    /** 端末を替える（ブラウザに保存した資格をすべて失う）。 */
    async loseFacilitatorCredentials() {
        await this.browserContext.clearCookies();
    }

    async loseParticipantSession(role) {
        await this.players.get(role).context.clearCookies({ name: 'bg_session' });
    }

    /** 資格が無いまま、コンソールの URL を直接開く。 */
    async openConsoleDirectly() {
        await this.page.goto(`/games/${this.gameId}/console`);
    }

    async unauthorizedNoticeWithRecoveryLink(page = this.page) {
        const alert = page.getByRole('alert');
        await alert.waitFor({ timeout: WAIT_MS });
        const text = await alert.textContent();
        const link = alert.getByRole('link', { name: '参加・復帰の画面へ' });
        await link.waitFor({ timeout: WAIT_MS });
        return { text, href: await link.getAttribute('href') };
    }

    /** 導線から復帰画面を開き、復帰コードを入れずに（Cookie の復帰資格で）復帰する。ゲーム ID は導線が持たせる。 */
    async recoverViaLink(page = this.page) {
        await page.getByRole('link', { name: '参加・復帰の画面へ' }).click({ timeout: WAIT_MS });
        await page.getByRole('heading', { name: '参加・復帰' }).waitFor({ timeout: WAIT_MS });
        assert.equal(await page.getByLabel('ゲーム ID').inputValue(), this.gameId);
        await page.getByRole('button', { name: '復帰する' }).click({ timeout: WAIT_MS });
    }

    /** 復帰画面で、ゲーム ID と復帰コードを入れて復帰する。 */
    async recoverWith(recoveryCode) {
        await this.page.goto('/join');
        await this.page.getByLabel('ゲーム ID').fill(this.gameId);
        await this.page.getByLabel('復帰コード').fill(recoveryCode);
        await this.page.getByRole('button', { name: '復帰する' }).click({ timeout: WAIT_MS });
    }

    async consoleShown() {
        await this.page
            .getByRole('heading', { name: '進行役のコンソール' })
            .waitFor({ timeout: WAIT_MS });
        assert.match(
            new URL(this.page.url()).pathname,
            new RegExp(`/games/${this.gameId}/console$`),
        );
    }

    async consoleNotShown() {
        assert.equal(
            await this.page.getByRole('heading', { name: '進行役のコンソール' }).count(),
            0,
        );
    }

    async playShown(role, roleLabel) {
        const { page } = this.players.get(role);
        await page.getByRole('heading', { name: 'プレイ' }).waitFor({ timeout: WAIT_MS });
        await page
            .getByText(new RegExp(`^第 \\d+ 週\\s+${roleLabel}$`))
            .waitFor({ timeout: WAIT_MS });
    }

    /** 参加者が、参加の画面で、参加コードと表示名を入れて参加する。 */
    async joinFromScreen(displayName) {
        // 進行役とは別のブラウザ（別の Cookie の入れ物）で参加する
        const context = await this.browser.newContext({ baseURL: this.baseURL, locale: 'ja-JP' });
        const page = await context.newPage();
        this.players.set('JOINER', { context, page });
        await page.goto('/join');
        await page.getByLabel('参加コード').fill(this.joinCode);
        await page.getByLabel('表示名').fill(displayName);
        await page.getByRole('button', { name: '参加する' }).click({ timeout: WAIT_MS });
    }

    async waitingForStartShown() {
        const { page } = this.players.get('JOINER');
        await page.getByRole('heading', { name: 'プレイ' }).waitFor({ timeout: WAIT_MS });
        await page.getByText('進行役が開始するまでお待ちください。').waitFor({ timeout: WAIT_MS });
        assert.match(new URL(page.url()).pathname, new RegExp(`/games/${this.gameId}/play$`));
    }

    async textShown(text, page = this.page) {
        await page.getByText(text).first().waitFor({ timeout: WAIT_MS });
    }

    async dispose() {
        for (const { context } of this.participants.values()) {
            await context.dispose();
        }
        this.participants.clear();
        for (const { context } of this.players.values()) {
            await context.close();
        }
        this.players.clear();
    }
}
