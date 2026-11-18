// 進行役のコンソールの「窓口」。ステップ定義（薄い層）から、画面の操作と、実バックエンドへの前提の準備（API）を呼ぶ。
// 業務ロジックは持たない。計算の値は @api が確かめるので、ここは画面の結線だけを確かめる。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

    /** 作成の画面（S02）で、カスタム条件を入れてゲームを作成し、ロビーへ進む（features/game-setup/custom-conditions-ui.feature）。 */
    async createCustomGameOnScreen() {
        await this.page.goto('/new');
        await this.page.getByLabel('条件').selectOption('CUSTOM');
        await this.page.getByLabel('小売店の初期在庫').fill('20');
        await this.page.getByLabel('配送の遅延（週）').fill('3');
        await this.page.getByRole('button', { name: 'ゲームを作成' }).click({ timeout: WAIT_MS });
        await this.page.getByRole('link', { name: 'ロビーへ' }).click({ timeout: WAIT_MS });
        await this.page.getByRole('heading', { name: 'ロビー' }).waitFor({ timeout: WAIT_MS });
    }

    /** ロビーに、設定の種別（「条件: …」）が示される。 */
    async lobbyShowsSettings(text) {
        await this.page.getByText(`条件: ${text}`).waitFor({ timeout: WAIT_MS });
    }

    /** 進行役の資格は、ブラウザの文脈（Cookie の入れ物）に持たせる。参加者は、別々の入れ物にする。 */
    async seedStartedGame({ retailerCoHolder = false } = {}) {
        const facilitator = this.browserContext.request;
        const state = await this.createGame();

        for (const role of ROLES) {
            await this.joinAndAssign(
                facilitator,
                state.joinCode,
                role,
                role,
                `${ROLE_LABELS[role]}の担当`,
            );
        }
        // 共同担当は、準備中に小売店へ割り当てる（開始後の追加は範囲外）。画面の窓口のキーは RETAILER_CO
        if (retailerCoHolder) {
            await this.joinAndAssign(
                facilitator,
                state.joinCode,
                'RETAILER_CO',
                'RETAILER',
                `${ROLE_LABELS.RETAILER}の共同担当`,
            );
        }
        await call(facilitator, 'POST', `/games/${this.gameId}/start`);
    }

    /** 全週を、各役割 4 で入力・確定して、ゲームを終了させる（前提の準備。確定は、版 1 を根拠にする）。 */
    async finishAllWeeks(finalWeek = 12) {
        const facilitator = this.browserContext.request;
        for (let week = 1; week <= finalWeek; week++) {
            await this.seedDecisions(week, {
                retailer: 4,
                wholesaler: 4,
                distributor: 4,
                factory: 4,
            });
            const basis = Object.fromEntries(ROLES.map((role) => [role, 1]));
            await call(facilitator, 'POST', `/sessions/${this.gameId}/weeks/${week}/commit`, {
                requestedWeek: week,
                basis,
            });
        }
    }

    /** 参加者の画面（プレイ）の「振り返りを見る」から、振り返りを開く。 */
    async openReviewFromPlay(key) {
        const { context: apiContext } = this.participants.get(key);
        const context = await this.browser.newContext({
            baseURL: this.baseURL,
            locale: 'ja-JP',
            storageState: await apiContext.storageState(),
        });
        const page = await context.newPage();
        this.players.set(key, { context, page });
        await page.goto(`/games/${this.gameId}/play`);
        await page.getByRole('link', { name: '振り返りを見る' }).click({ timeout: WAIT_MS });
        await page.getByRole('heading', { name: '振り返り' }).waitFor({ timeout: WAIT_MS });
        this.reviewPage = page;
    }

    /** 進行役のコンソールの「振り返りを見る」から、振り返りを開く（B10。進行役の資格は、ブラウザの文脈の Cookie）。 */
    async openReviewFromConsole() {
        await this.open();
        await this.page.getByRole('link', { name: '振り返りを見る' }).click({ timeout: WAIT_MS });
        await this.page.getByRole('heading', { name: '振り返り' }).waitFor({ timeout: WAIT_MS });
        this.reviewPage = this.page;
    }

    /** 振り返りの画面で、出力のボタン（「CSV を出力」など）を押し、ダウンロードされたファイルを控える。 */
    async pressExport(label) {
        const downloading = this.reviewPage.waitForEvent('download', { timeout: WAIT_MS });
        await this.reviewPage.getByRole('button', { name: label }).click({ timeout: WAIT_MS });
        this.downloaded = await downloading;
    }

    /** ダウンロードされたファイルの名前と本文。 */
    async downloadedFile() {
        assert.ok(this.downloaded, 'ダウンロードされていない');
        const path = await this.downloaded.path();
        return {
            filename: this.downloaded.suggestedFilename(),
            text: await readFile(path, 'utf8'),
        };
    }

    /** 進行役のコンソールの「保持状態を見る」から、保持状態（S09）を開く（B11）。 */
    async openRetentionFromConsole() {
        await this.open();
        await this.page.getByRole('link', { name: '保持状態を見る' }).click({ timeout: WAIT_MS });
        await this.page.getByRole('heading', { name: '保持状態' }).waitFor({ timeout: WAIT_MS });
        this.retentionPage = this.page;
    }

    /** 保持状態の本文（削除予定日・保持期間・バックアップの注記）。 */
    async retentionText() {
        await this.retentionPage.getByText(/^削除予定日:/).waitFor({ timeout: WAIT_MS });
        return this.retentionPage.locator('main').innerText();
    }

    /** 振り返りの本文。削除予定日の注記（進行役にだけ。取得してから示す）を待つ。 */
    async reviewText() {
        await this.reviewPage.getByText(/^削除予定日:/).waitFor({ timeout: WAIT_MS });
        return this.reviewPage.locator('main').innerText();
    }

    /** 振り返りの表の列見出し。 */
    async reviewColumns() {
        const table = this.reviewPage.getByRole('table', { name: '週次推移の表' });
        await table.waitFor({ timeout: WAIT_MS });
        return table.getByRole('columnheader').allTextContents();
    }

    /** 振り返りの指標を切り替える。 */
    async switchReviewMetric(label) {
        await this.reviewPage.getByRole('radio', { name: label }).check({ timeout: WAIT_MS });
    }

    /** 振り返りの表の見出し（「<指標>の週次推移（グラフと同じ値）」）。 */
    async reviewCaption() {
        const caption = this.reviewPage.locator('table caption');
        await caption.waitFor({ timeout: WAIT_MS });
        return caption.innerText();
    }

    /** 第 [week] 週を、各役割 [quantity] で入力・確定する（前提の準備。確定は、版 1 を根拠にする）。 */
    async commitSeededWeek(week, quantity) {
        const facilitator = this.browserContext.request;
        await this.seedDecisions(week, {
            retailer: quantity,
            wholesaler: quantity,
            distributor: quantity,
            factory: quantity,
        });
        const basis = Object.fromEntries(ROLES.map((role) => [role, 1]));
        await call(facilitator, 'POST', `/sessions/${this.gameId}/weeks/${week}/commit`, {
            requestedWeek: week,
            basis,
        });
    }

    /** ロビーで、観察用の招待を発行し、一度だけ示される招待コードを控える（進行役の画面）。 */
    async issueInvitationOnLobby() {
        await this.page.goto(`/games/${this.gameId}/lobby`);
        await this.page
            .getByRole('button', { name: '観察用の招待を発行' })
            .click({ timeout: WAIT_MS });
        const issued = this.page.getByRole('status').filter({ hasText: '招待コード:' });
        await issued.waitFor({ timeout: WAIT_MS });
        const match = /v\d+\.[A-Za-z0-9_-]+/.exec(await issued.innerText());
        assert.ok(match, '招待コードが表示されていない');
        this.invitationCode = match[0];
    }

    /** ロビーで、控えた招待を失効させる（確認のダイアログで「失効させる」を選ぶ）。 */
    async revokeInvitationOnLobby() {
        await this.page.getByRole('button', { name: '招待 1を失効' }).click({ timeout: WAIT_MS });
        await this.page
            .getByRole('dialog')
            .getByRole('button', { name: '失効させる' })
            .click({ timeout: WAIT_MS });
        await this.page.getByText(/招待 1: 失効/).waitFor({ timeout: WAIT_MS });
    }

    /** 観察者が、別のブラウザで、観察者の参加の画面（S10）から、控えた招待コードで参加する。 */
    async joinAsObserverOnScreen(displayName) {
        const context = await this.browser.newContext({ baseURL: this.baseURL, locale: 'ja-JP' });
        const page = await context.newPage();
        this.players.set('OBSERVER', { context, page });
        this.observerPage = page;
        await page.goto('/observe');
        await page.getByLabel('観察用の招待コード').fill(this.invitationCode);
        await page.getByLabel('表示名（任意）').fill(displayName);
        await page.getByRole('button', { name: '参加する' }).click({ timeout: WAIT_MS });
    }

    /** 観察の画面に、現在週と、[week] 週のチーム合計の注文が示される。 */
    async observationShows(currentWeek, week, order) {
        const page = this.observerPage;
        await page.getByRole('heading', { name: '観察' }).waitFor({ timeout: WAIT_MS });
        await page.getByText(new RegExp(`^第 ${currentWeek} 週`)).waitFor({ timeout: WAIT_MS });
        const table = page.getByRole('table', { name: 'チーム合計の表' });
        await table.waitFor({ timeout: WAIT_MS });
        const cells = await table
            .getByRole('row')
            .filter({ has: page.getByRole('cell', { name: String(week), exact: true }) })
            .getByRole('cell')
            .allTextContents();
        assert.equal(cells[1], String(order), `週 ${week} の注文の合計: ${JSON.stringify(cells)}`);
    }

    /** 観察の画面に、役割別の語も、操作のボタンも無い（読み取り専用）。 */
    async observationReadOnly() {
        const page = this.observerPage;
        assert.equal(await page.getByText(/小売店|二次卸|一次卸|工場/).count(), 0);
        assert.equal(await page.getByRole('button').count(), 0);
    }

    /** 別の Cookie の入れ物で参加し、進行役が [role] に割り当てる。窓口では [key] で引く。 */
    async joinAndAssign(facilitator, joinCode, key, role, displayName) {
        const context = await request.newContext({ baseURL: this.baseURL });
        await call(context, 'POST', '/participations/join', { joinCode, displayName });
        const mine = await (await call(context, 'GET', `/games/${this.gameId}/state`)).json();
        await call(
            facilitator,
            'PUT',
            `/games/${this.gameId}/participants/${mine.participantId}/role`,
            { role },
        );
        this.participants.set(key, {
            context,
            participantId: mine.participantId,
            role,
            displayName,
        });
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

    /** 確定した週の結果の表の行（週と役割の組）。 */
    async resultRows() {
        const region = this.page.getByRole('region', { name: '確定した週の結果' });
        await region.waitFor({ timeout: WAIT_MS });
        const rows = region.getByRole('table').locator('tbody tr');
        const count = await rows.count();
        const result = [];
        for (let index = 0; index < count; index++) {
            const row = rows.nth(index);
            result.push({
                week: (await row.locator('td').first().innerText()).trim(),
                role: (await row.locator('th').innerText()).trim(),
            });
        }
        return result;
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

    /** 進行役のコンソールで、自動確定を有効にする。 */
    async enableAutoCommit() {
        await this.page
            .getByRole('button', { name: '自動確定を有効にする' })
            .click({ timeout: WAIT_MS });
    }

    /** コンソールの「自動確定: 有効／無効」の表示。表示されるまで待つ。 */
    async autoCommitShown(label) {
        await this.page.getByText(`自動確定: ${label}`).waitFor({ timeout: WAIT_MS });
    }

    /** コンソールの「第 N 週　<状態>」の表示。表示されるまで待つ。 */
    async consoleStatusShown(week, statusLabel) {
        await this.page
            .getByText(new RegExp(`^第 ${week} 週\\s+${statusLabel}$`))
            .waitFor({ timeout: WAIT_MS });
    }

    /** 参加者の画面（別のブラウザの文脈）を、参加者の資格で開く。 */
    async openPlayAs(key) {
        const { context: apiContext, role: assigned } = this.participants.get(key);
        const role = assigned ?? key;
        const context = await this.browser.newContext({
            baseURL: this.baseURL,
            locale: 'ja-JP',
            storageState: await apiContext.storageState(),
        });
        const page = await context.newPage();
        this.players.set(key, { context, page });
        await page.goto(`/games/${this.gameId}/play`);
        await page.getByRole('heading', { name: 'プレイ' }).waitFor({ timeout: WAIT_MS });
        await page.getByLabel(decisionLabel(role)).waitFor({ timeout: WAIT_MS });
    }

    // ---- 共同入力（features/weekly-play/co-input-ui.feature）。窓口のキーは、1 人目が RETAILER、2 人目が RETAILER_CO ----

    /** 入力欄に数量を入れて、保存を押す。 */
    async savePlay(key, quantity) {
        const { page } = this.players.get(key);
        await page.getByLabel(decisionLabel('RETAILER')).fill(String(quantity));
        await page.getByRole('button', { name: '発注を保存' }).click({ timeout: WAIT_MS });
    }

    /** 自分の保存が反映された（「現在の入力」が、自分の保存として示される）。 */
    async savedAsSelf(key, quantity) {
        const { page } = this.players.get(key);
        await page
            .getByText(new RegExp(`^現在の入力: ${quantity}（あなたが \\d{2}:\\d{2} に保存）$`))
            .waitFor({ timeout: WAIT_MS });
    }

    /** 競合の通知: 見出し、最新の値、保存者（[savedBy] の表示名。時刻つき）。版は出ない。 */
    async conflictShown(key, latest, savedBy) {
        const { page } = this.players.get(key);
        const notice = page.getByRole('region', { name: '他の人が先に保存しました。' });
        await notice.waitFor({ timeout: WAIT_MS });
        await notice.getByText(`最新の入力: ${latest}`).waitFor({ timeout: WAIT_MS });
        await notice
            .getByText(new RegExp(`^保存者: ${savedBy}さん（\\d{2}:\\d{2}）$`))
            .waitFor({ timeout: WAIT_MS });
        assert.doesNotMatch((await notice.textContent()) ?? '', /版/);
    }

    /** 入力した値が、入力欄にも通知にも残っている。 */
    async inputKept(key, value) {
        const { page } = this.players.get(key);
        assert.equal(await page.getByLabel(decisionLabel('RETAILER')).inputValue(), String(value));
        await page
            .getByText(`あなたの入力: ${value}（未保存。保持しています）`)
            .waitFor({ timeout: WAIT_MS });
    }

    async resave(key) {
        const { page } = this.players.get(key);
        await page.getByRole('button', { name: 'この値で保存し直す' }).click({ timeout: WAIT_MS });
    }

    /** 表示名（窓口が参加させたときの名前）。 */
    displayNameOf(key) {
        return this.participants.get(key).displayName;
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

    /** ブラウザセッション（Cookie bg_session、タブ名つきの bg_session_<識別子> を含む）だけを失う。復帰資格（bg_recovery）は残る。 */
    async loseFacilitatorSession() {
        await this.browserContext.clearCookies({ name: /^bg_session/ });
    }

    /** 端末を替える（ブラウザに保存した資格をすべて失う）。 */
    async loseFacilitatorCredentials() {
        await this.browserContext.clearCookies();
    }

    async loseParticipantSession(role) {
        await this.players.get(role).context.clearCookies({ name: /^bg_session/ });
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
