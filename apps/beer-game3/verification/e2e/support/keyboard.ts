import { expect, type Locator, type Page } from '@playwright/test';
import { allowsProgrammaticSelect } from '../../shared/platform.js';

/** 対象の要素が、いまフォーカスを持っているか。 */
async function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((element) => element === document.activeElement);
}

/**
 * Tab キーだけで、対象の要素までフォーカスを進める（マウスもプログラムによるフォーカスも使わない）。
 * 到達できなければ失敗する（キーボードで操作できない要素の検出）。
 */
export async function tabTo(page: Page, target: Locator, maxPresses = 120): Promise<void> {
  // 先に進む方向（Tab）、届かなければ戻る方向（Shift+Tab）。ページの外（ブラウザの部品）へ出ても戻れる
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let pressed = 0; pressed <= maxPresses; pressed += 1) {
      if (await isFocused(target)) {
        return;
      }
      await page.keyboard.press(key);
    }
  }
  throw new Error('Tab キーだけでは、対象の要素にフォーカスが届きませんでした');
}

/** 対象へ Tab で進み、キーを押す。 */
export async function pressOn(page: Page, target: Locator, key: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

/** 対象の入力欄へ Tab で進み、既存の内容を選択して、キー入力で文字を入れる。 */
export async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

/**
 * 選択欄（select）へ Tab で進み、矢印キーで、表示が label の選択肢になるまで進める。
 * 選択肢は先頭が「未割当て」で、下矢印で 1 つずつ進む。
 */
export async function chooseOption(page: Page, select: Locator, label: string): Promise<void> {
  await tabTo(page, select);
  const selectedLabel = () =>
    select.evaluate(
      (element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent ?? '',
    );
  const labels = await select.evaluate((element) =>
    [...(element as HTMLSelectElement).options].map((option) => option.textContent ?? ''),
  );
  const target = labels.indexOf(label);
  if (target < 0) {
    throw new Error('目的の選択肢がありません');
  }
  const start = labels.indexOf(await selectedLabel());
  const steps = target - start;
  if (steps <= 0) {
    return;
  }
  // 選択を保存して画面が更新されるまで、表示された選択肢が変わるのを待つ（固定の待ちを使わない）
  const shows = async (expected: string | undefined): Promise<boolean> => {
    try {
      await expect.poll(selectedLabel, { timeout: 2000 }).toBe(expected);
      return true;
    } catch {
      return false;
    }
  };
  await page.keyboard.press('ArrowDown');
  if (await shows(labels[start + 1])) {
    // 矢印キーで、閉じた選択欄の値がそのまま変わる環境（Windows、Linux）
    for (let step = 1; step < steps; step += 1) {
      await page.keyboard.press('ArrowDown');
      await expect.poll(selectedLabel).toBe(labels[start + step + 1]);
    }
    return;
  }
  // 矢印キーで値が変わらなかった。macOS に限り、OS 標準の一覧が開いて自動操作のキー入力が届かないため、
  // Tab でフォーカスを当てたこの欄の選択の確定だけを selectOption で代える。Linux と Windows では代えず失敗させる
  // （キー操作の退行を隠さない。AC5.5.1、NFR8.1）
  if (!allowsProgrammaticSelect(process.platform)) {
    throw new Error('矢印キーで選択欄の値が変わりませんでした（キーボードだけでは選べません）');
  }
  await page.keyboard.press('Escape');
  await select.selectOption({ label });
  await expect.poll(selectedLabel).toBe(label);
}
