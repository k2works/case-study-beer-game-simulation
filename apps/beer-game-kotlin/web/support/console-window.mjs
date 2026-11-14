// 進行役のコンソールの「窓口」。ステップ定義（薄い層）から、画面の操作と、実バックエンドへの前提の準備（API）を呼ぶ。
// 業務ロジックは持たない。計算の値は @api が確かめるので、ここは画面の結線だけを確かめる。
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

export class ConsoleWindow {
    constructor({ page, browserContext, baseURL }) {
        this.page = page;
        this.browserContext = browserContext;
        this.baseURL = baseURL;
        this.participants = new Map(); // role -> { context, participantId }
        this.gameId = undefined;
    }

    /** 進行役の資格は、ブラウザの文脈（Cookie の入れ物）に持たせる。参加者は、別々の入れ物にする。 */
    async seedStartedGame() {
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
        const state = await (await call(facilitator, 'GET', `/games/${this.gameId}/state`)).json();

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

    async dispose() {
        for (const { context } of this.participants.values()) {
            await context.dispose();
        }
        this.participants.clear();
    }
}
