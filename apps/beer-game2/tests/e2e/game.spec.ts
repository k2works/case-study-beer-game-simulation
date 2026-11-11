import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const ROLES = [
  { key: 'FACTORY', label: '工場', input: '生産要請数' },
  { key: 'DISTRIBUTOR', label: '一次卸', input: '発注数' },
  { key: 'WHOLESALER', label: '二次卸', input: '発注数' },
  { key: 'RETAILER', label: '小売店', input: '発注数' },
] as const;

interface Player {
  context: BrowserContext;
  page: Page;
  name: string;
  role: (typeof ROLES)[number];
  /** 参加の直後にロビーで示された復帰コード */
  recoveryCode: string;
}

const recoveryCodeOn = async (page: Page) =>
  (
    await page
      .getByRole('note', { name: '復帰コード' })
      .locator('strong')
      .innerText()
  ).trim();

/** 進行役が作成し、4 人が参加し、役割を割り当てて開始するまで */
const startTable = (browser: Browser, weeks = 2) =>
  startTableWith(browser, { weeks });

/** `coRetailer` なら、小売店に 2 人目（共同担当）を加える */
async function startTableWith(
  browser: Browser,
  {
    weeks = 2,
    coRetailer = false,
    conditions,
  }: {
    weeks?: number;
    coRetailer?: boolean;
    /** 作成の画面で、条件の欄を入力する */
    conditions?: Record<string, string>;
  },
) {
  const facContext = await browser.newContext();
  const fac = await facContext.newPage();
  await fac.goto('/new');
  await fac.getByLabel('週数').fill(String(weeks));
  // 進行役が確定する流れを検証するため、自動確定をオフにする
  await fac.getByLabel('全員が保存したら自動で次の週に進む').uncheck();
  for (const [label, value] of Object.entries(conditions ?? {}))
    await fac.getByLabel(label).fill(value);
  await fac.getByRole('button', { name: '作成する' }).click();
  await expect(fac.getByRole('heading', { name: 'ロビー' })).toBeVisible();
  const facRecoveryCode = await recoveryCodeOn(fac);
  // 参加コード（復帰コードと区別するため、文言で探す）
  const joinCode = (
    await fac
      .getByText(/^参加コード:/)
      .locator('strong')
      .innerText()
  ).trim();

  const players: Player[] = [];
  const seats = coRetailer ? [...ROLES, ROLES[3]] : [...ROLES];
  for (const [n, role] of seats.entries()) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/join');
    await page.getByLabel('参加コード').fill(joinCode);
    const name = n < ROLES.length ? `${role.label}担当` : `${role.label}担当2`;
    await page.getByLabel('表示名').fill(name);
    await page.getByRole('button', { name: '参加する' }).click();
    await expect(page.getByText('開始を待っています')).toBeVisible();
    players.push({
      context,
      page,
      name,
      role,
      recoveryCode: await recoveryCodeOn(page),
    });
  }
  for (const p of players) {
    await fac.getByLabel(`${p.name} の役割`).selectOption(p.role.key); // 共同担当の表示名が付くため、値で選ぶ
  }
  await expect(fac.getByRole('button', { name: '開始する' })).toBeEnabled();
  await fac.getByRole('button', { name: '開始する' }).click();
  await expect(
    fac.getByRole('heading', { name: '進行役コンソール' }),
  ).toBeVisible();
  return { fac, facContext, players, facRecoveryCode };
}

async function enterOrders(players: Player[], quantity: number) {
  for (const player of players) {
    const { role, page } = player;
    await expect(
      page.getByRole('heading', { name: `${role.label}の画面` }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await page.getByLabel(role.input).fill(String(quantity));
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByText('保存しました')).toBeVisible();
  }
}

async function commit(fac: Page) {
  await expect(fac.getByRole('button', { name: '週を確定する' })).toBeEnabled({
    timeout: 15_000,
  });
  await fac.getByRole('button', { name: '週を確定する' }).click();
  await fac
    .getByRole('dialog')
    .getByRole('button', { name: '確定する' })
    .click();
}

test('[US2.3/AC2.3.1] 作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の更新', async ({
  browser,
}) => {
  const { fac, facContext, players } = await startTable(browser);

  // 情報の制約: 小売店だけが顧客需要を見る
  await expect(players[3]!.page.getByText('今週の顧客需要')).toBeVisible({
    timeout: 15_000,
  });
  await expect(players[0]!.page.getByText('今週の顧客需要')).toHaveCount(0);

  await enterOrders(players, 4);
  await commit(fac);

  // 週が進み、役割別の結果が履歴に載る
  for (const [i] of ROLES.entries()) {
    const page = players[i]!.page;
    await expect(page.getByText('2 週目')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('table', { name: '週ごとの結果' }).getByRole('row'),
    ).toHaveCount(2);
  }
  await expect(
    players[3]!.page
      .getByRole('table', { name: '週ごとの結果' })
      .getByText('$6.00')
      .first(),
  ).toBeVisible();

  // 最終週まで進めると終了する
  await enterOrders(players, 4);
  await commit(fac);
  await expect(fac.getByText('ゲームは終了しました。')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    players[3]!.page.getByText('ゲームは終了しました。'),
  ).toBeVisible({ timeout: 15_000 });

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US2.1] 通知（SSE）を遮断しても、ポーリングで追いつく', async ({
  browser,
}) => {
  const { fac, facContext, players } = await startTable(browser);
  const retailer = players[3]!;
  // SSE を遮断してから、画面を開き直す
  await retailer.page.route('**/stream', (route) => route.abort());
  await retailer.page.reload();
  await expect(
    retailer.page.getByRole('heading', { name: '小売店の画面' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await enterOrders(players.slice(0, 3), 4);
  await retailer.page.getByLabel('発注数').fill('4');
  await retailer.page.getByRole('button', { name: '保存する' }).click();
  await commit(fac);
  await expect(retailer.page.getByText('2 週目')).toBeVisible({
    timeout: 15_000,
  });

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US2.1] 資格が無ければ、参加へ誘導される', async ({ page }) => {
  await page.goto('/games/00000000-0000-0000-0000-000000000000/lobby');
  await expect(page.getByRole('heading', { name: '参加する' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('参加または復帰');
});

test('[US3.1/AC3.1.2] 停止 → 代理入力 → 再開 → 確定。停止中は参加者が保存できない', async ({
  browser,
}) => {
  const { fac, facContext, players } = await startTable(browser);
  const retailer = players[3]!.page;
  await expect(
    retailer.getByRole('heading', { name: '小売店の画面' }),
  ).toBeVisible({ timeout: 15_000 });

  await fac.getByRole('button', { name: '停止する' }).click();
  await fac
    .getByRole('dialog', { name: '停止の確認' })
    .getByRole('button', { name: '停止する' })
    .click();
  await expect(
    retailer.getByText('停止中です。進行役の再開を待ってください。'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    retailer.getByRole('button', { name: '保存する' }),
  ).toBeDisabled();

  // 二次卸の担当が不在として、進行役が代理入力する
  const proxy = fac.getByRole('form', { name: '代理入力' });
  await proxy.getByLabel('役割').selectOption({ label: '二次卸' });
  await proxy.getByLabel('数量').fill('4');
  await proxy.getByRole('button', { name: '代理入力を確認' }).click();
  await fac
    .getByRole('dialog', { name: '代理入力の確認' })
    .getByRole('button', { name: '代理入力する' })
    .click();
  await expect(
    fac.getByRole('table', { name: '入力状況' }).getByRole('row', {
      name: /二次卸 入力済み/,
    }),
  ).toBeVisible();

  await fac.getByRole('button', { name: '再開する' }).click();
  await fac
    .getByRole('dialog', { name: '再開の確認' })
    .getByRole('button', { name: '再開する' })
    .click();
  await enterOrders(
    players.filter((p) => p.role.key !== 'WHOLESALER'),
    4,
  );
  await commit(fac);
  await expect(retailer.getByText('2 週目')).toBeVisible({ timeout: 15_000 });

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US3.2/AC3.2.1] 参加者は Cookie を失っても、復帰コードで同じ役割の画面に戻れる', async ({
  browser,
}) => {
  const { facContext, players } = await startTable(browser);
  const retailer = players[3]!;
  await retailer.context.clearCookies();
  await retailer.page.reload();
  // 資格が無いので、参加・復帰の画面へ誘導される
  await expect(
    retailer.page.getByRole('heading', { name: '参加する' }),
  ).toBeVisible({ timeout: 15_000 });
  await retailer.page.getByLabel('復帰コード').fill(retailer.recoveryCode);
  await retailer.page.getByRole('button', { name: '復帰する' }).click();
  await expect(
    retailer.page.getByRole('heading', { name: '小売店の画面' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(retailer.page.getByText('1 週目')).toBeVisible();

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US3.2/AC3.2.4] 進行役は別のブラウザでも、復帰コードで進行役コンソールへ戻れる。再発行で古い資格は使えない', async ({
  browser,
}) => {
  const { fac, facContext, players, facRecoveryCode } =
    await startTable(browser);
  const other = await browser.newContext();
  const page = await other.newPage();
  await page.goto('/join');
  await page.getByLabel('復帰コード').fill(facRecoveryCode);
  await page.getByRole('button', { name: '復帰する' }).click();
  await expect(
    page.getByRole('heading', { name: '進行役コンソール' }),
  ).toBeVisible({ timeout: 15_000 });

  // 漏れた想定で、進行役自身の資格を再発行する。もとのブラウザの資格は使えなくなる
  const form = page.getByRole('form', { name: '資格の再発行' });
  await form.getByLabel('対象').selectOption({ label: '進行役（あなた）' });
  await form.getByRole('button', { name: '失効して再発行' }).click();
  await page
    .getByRole('dialog', { name: '再発行の確認' })
    .getByRole('button', { name: '失効して再発行' })
    .click();
  await expect(
    page.getByRole('note', { name: '新しい復帰コード' }),
  ).toBeVisible();
  await fac.reload();
  await expect(fac.getByRole('heading', { name: '参加する' })).toBeVisible({
    timeout: 15_000,
  });
  // 再発行した側は、新しい資格で操作を続けられる
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '進行役コンソール' }),
  ).toBeVisible();

  await other.close();
  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US2.2/AC2.2.3] 共同担当: 一方の保存が他方に反映され、同じ版からの保存は競合として示される', async ({
  browser,
}) => {
  const { facContext, players } = await startTableWith(browser, {
    coRetailer: true,
  });
  const [hanako, taro] = players.filter((p) => p.role.key === 'RETAILER');
  for (const p of [hanako!, taro!]) {
    await expect(
      p.page.getByRole('heading', { name: '小売店の画面' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      p.page.getByText(`共同担当: ${hanako!.name}、${taro!.name}`),
    ).toBeVisible();
  }

  // AC2.2.4: 花子の保存が、太郎の画面に同じ値・版・保存者で出る
  await hanako!.page.getByLabel('発注数').fill('6');
  await hanako!.page.getByRole('button', { name: '保存する' }).click();
  const shown = `現在の入力: 6（${hanako!.name}さんが保存、版 1）`;
  await expect(taro!.page.getByText(shown)).toBeVisible({ timeout: 15_000 });

  // 太郎の画面を版 1 のまま止める（通知と再取得に、古い状況を返す）
  const stale = await (
    await taro!.page.request.get(
      taro!.page
        .url()
        .replace('/play', '/me')
        .replace('/games/', '/api/games/'),
    )
  ).text();
  await taro!.page.route('**/stream', (route) => route.abort());
  await taro!.page.route('**/api/games/*/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: stale,
    }),
  );

  await hanako!.page.getByLabel('発注数').fill('7');
  await hanako!.page.getByRole('button', { name: '保存する' }).click();
  await expect(hanako!.page.getByText('保存しました')).toBeVisible();

  await taro!.page.getByLabel('発注数').fill('10');
  await taro!.page.getByRole('button', { name: '保存する' }).click();
  const conflict = taro!.page.getByRole('alert', { name: '入力の競合' });
  await expect(conflict).toContainText('他の人が先に保存しました');
  await expect(conflict).toContainText(
    `最新の入力: 7（${hanako!.name}さん、版 2）`,
  );
  await expect(conflict).toContainText('あなたの入力: 10（未保存）');

  await taro!.page.unroute('**/api/games/*/me');
  await conflict.getByRole('button', { name: 'この値で保存し直す' }).click();
  await expect(taro!.page.getByText('保存しました')).toBeVisible();
  await expect(
    hanako!.page.getByText(`現在の入力: 10（${taro!.name}さんが保存、版 3）`),
  ).toBeVisible({ timeout: 15_000 });

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US1.1/AC1.1.3] カスタム条件で作ると、ロビーに「カスタム」と変更項目が出て、その条件で始まる', async ({
  browser,
}) => {
  const { fac, facContext, players } = await startTableWith(browser, {
    conditions: { 初期在庫: '20', '注文の遅延（週）': '1' },
  });
  await expect(
    fac.getByText('条件: カスタム（変更: 初期在庫、注文の遅延）'),
  ).toBeVisible();
  const retailer = players[3]!.page;
  await expect(
    retailer.getByRole('heading', { name: '小売店の画面' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    retailer.getByRole('definition').filter({ hasText: /^20$/ }).first(),
  ).toBeVisible();

  await facContext.close();
  for (const p of players) await p.context.close();
});
