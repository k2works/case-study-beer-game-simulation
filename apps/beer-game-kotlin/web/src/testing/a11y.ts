import { expect } from 'vitest';

/**
 * WCAG 2.2 AA のうち、DOM の構造だけで機械的に確かめられる項目の検査（コンポーネントのテスト用）。
 * axe-core の代わりではない（axe は依存の追加になるため、導入は人の判断）。確かめるのは次の項目だけで、
 * コントラスト比・200% 拡大・キーボード操作の順序・スクリーンリーダーの読み上げは、ここでは確かめない（手動・B15）。
 *
 * - 1.3.1 / 4.1.2: 入力欄・ボタン・リンクが名前を持つ。aria-labelledby・aria-describedby の参照先がある。
 * - 4.1.1 相当: id が重複しない。
 * - 2.4.2 / 2.4.6: 題名（document.title）と、見出し（h1）が 1 つだけある。
 * - 4.1.2: ダイアログは aria-modal と名前を持つ。
 */
function accessibleNameOf(element: Element): string {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
        return labelledBy
            .split(/\s+/)
            .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        const fromLabels = Array.from(element.labels ?? [])
            .map((label) => label.textContent ?? '')
            .join(' ')
            .trim();
        if (fromLabels !== '') return fromLabels;
    }
    return (element.textContent ?? '').trim();
}

export function expectNoStructuralA11yViolations(container: HTMLElement = document.body): void {
    const unnamed: string[] = [];
    for (const element of container.querySelectorAll('input, select, textarea, button, a[href]')) {
        if (element instanceof HTMLInputElement && element.type === 'hidden') continue;
        if (accessibleNameOf(element) === '') unnamed.push(element.outerHTML);
    }
    expect(unnamed, '名前の無い操作部品').toEqual([]);

    const brokenReferences: string[] = [];
    for (const element of container.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
        for (const attribute of ['aria-labelledby', 'aria-describedby']) {
            const value = element.getAttribute(attribute);
            if (value === null) continue;
            for (const id of value.split(/\s+/)) {
                if (container.ownerDocument.getElementById(id) === null) {
                    brokenReferences.push(`${attribute}="${id}"`);
                }
            }
        }
    }
    expect(brokenReferences, '参照先の無い aria 属性').toEqual([]);

    const ids = Array.from(container.querySelectorAll('[id]')).map((element) => element.id);
    expect(
        ids.filter((id, index) => ids.indexOf(id) !== index),
        '重複した id',
    ).toEqual([]);

    expect(container.querySelectorAll('h1'), 'h1 は 1 つ').toHaveLength(1);
    expect(document.title, '題名').not.toBe('');

    for (const dialog of container.querySelectorAll('[role="dialog"]')) {
        expect(dialog.getAttribute('aria-modal'), 'ダイアログの aria-modal').toBe('true');
        expect(accessibleNameOf(dialog), 'ダイアログの名前').not.toBe('');
    }
}
