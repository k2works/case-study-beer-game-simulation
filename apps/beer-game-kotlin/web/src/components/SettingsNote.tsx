import { settingsText } from '../labels';
import type { SettingsField, SettingsKind } from '../api/types';

/** ゲームの設定の種別（キット準拠かカスタムか）と、変更した項目（S04・S06）。 */
export function SettingsNote({
    kind,
    changed,
}: {
    kind: SettingsKind;
    changed: readonly SettingsField[];
}) {
    return <p>{`条件: ${settingsText(kind, changed)}`}</p>;
}
