// Cucumber-JS の起動・終了。
// - 画面は、Vite の開発サーバーを、専用のポート（既定 5273）で起動する（人の開発サーバーの 3000・5173 は使わない）。
// - バックエンドは、起動済みのものを使う（既定 3100）。起動していなければ、手順つきで失敗する。
// - 起動したものは、終了時に必ず止める。
import {
    After,
    AfterAll,
    Before,
    BeforeAll,
    setDefaultTimeout,
    setWorldConstructor,
} from '@cucumber/cucumber';
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'vite';
import { ConsoleWindow } from './console-window.mjs';

process.env.UI_PORT ??= '5273';
process.env.API_PORT ??= '3100';
// ブラウザ行列（NF-U4。B15）: 環境変数 BROWSER（chromium・firefox・webkit。既定は chromium）で、実行するブラウザを選ぶ。
// Edge・Chrome の実機（チャンネル）と、実機の Safari は、この設定では実行しない。
const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.BROWSER ?? 'chromium';
const engine = ENGINES[engineName];
if (engine === undefined) {
    throw new Error(`BROWSER は chromium・firefox・webkit のいずれか（指定: ${engineName}）`);
}
const uiUrl = `http://localhost:${process.env.UI_PORT}`;
const apiUrl = `http://localhost:${process.env.API_PORT}`;

setDefaultTimeout(60_000);

let vite;
let browser;

class World {}
setWorldConstructor(World);

BeforeAll(async function () {
    const ready = await fetch(`${apiUrl}/api/v1/ready`).catch((cause) => {
        throw new Error(
            `バックエンドに接続できません（${apiUrl}）。先に起動してください: ` +
                'cd apps/beer-game-kotlin && APP_ENV=local DB_KIND=h2 PORT=' +
                process.env.API_PORT +
                ` ALLOWED_ORIGINS=${uiUrl} ./gradlew :app:run` +
                '（画面の Origin を許可するため、ALLOWED_ORIGINS が要る）',
            { cause },
        );
    });
    if (!ready.ok) throw new Error(`バックエンドが準備できていません（/ready が ${ready.status}）`);

    vite = await createServer({
        configFile: new URL('../vite.config.ts', import.meta.url).pathname,
        logLevel: 'warn',
    });
    await vite.listen();
    browser = await engine.launch();
});

AfterAll(async function () {
    await browser?.close();
    await vite?.close();
});

Before(async function () {
    this.browserContext = await browser.newContext({ baseURL: uiUrl, locale: 'ja-JP' });
    this.page = await this.browserContext.newPage();
    this.console = new ConsoleWindow({
        page: this.page,
        browserContext: this.browserContext,
        browser,
        baseURL: uiUrl,
    });
});

After(async function () {
    await this.console?.dispose();
    await this.browserContext?.close();
});
