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
async function startTable(browser: Browser, weeks = 2) {
  const facContext = await browser.newContext();
  const fac = await facContext.newPage();
  await fac.goto('/new');
  await fac.getByLabel('週数').fill(String(weeks));
  // 進行役が確定する流れを検証するため、自動確定をオフにする
  await fac.getByLabel('全員が保存したら自動で次の週に進む').uncheck();
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
  for (const role of ROLES) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/join');
    await page.getByLabel('参加コード').fill(joinCode);
    await page.getByLabel('表示名').fill(`${role.label}担当`);
    await page.getByRole('button', { name: '参加する' }).click();
    await expect(page.getByText('開始を待っています')).toBeVisible();
    players.push({
      context,
      page,
      name: `${role.label}担当`,
      role,
      recoveryCode: await recoveryCodeOn(page),
    });
  }
  for (const [i, role] of ROLES.entries()) {
    await fac
      .getByLabel(`${players[i]!.name} の役割`)
      .selectOption({ label: role.label });
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
