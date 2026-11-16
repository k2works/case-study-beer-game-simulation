import { ROLE_LABELS, ROLE_ORDER } from '../../labels';
import { fieldProps } from '../../components/ValidationSummary';
import type { CustomConditionsInput, FieldError, Role } from '../../api/types';

/** カスタム条件の入力欄の値（画面では文字列。空欄は「キットの値のまま」）。 */
export interface ConditionDraft {
    inventory: Record<Role, string>;
    initialFlow: string;
    orderDelayWeeks: string;
    shipmentDelayWeeks: string;
    productionDelayWeeks: string;
    holdingCostMinor: string;
    backlogCostMinor: string;
    disclosurePolicy: string;
}

export const EMPTY_DRAFT: ConditionDraft = {
    inventory: { RETAILER: '', WHOLESALER: '', DISTRIBUTOR: '', FACTORY: '' },
    initialFlow: '',
    orderDelayWeeks: '',
    shipmentDelayWeeks: '',
    productionDelayWeeks: '',
    holdingCostMinor: '',
    backlogCostMinor: '',
    disclosurePolicy: '',
};

/** 整数に読める入力は数にし、読めない入力は文字列のまま送る（サーバーの検証が、誤りを集めて返す）。 */
const toNumberOrRaw = (text: string): number | string => {
    const trimmed = text.trim();
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
};

const filled = (text: string): boolean => text.trim() !== '';

/** 入力のある項目だけを、作成の要求の `conditions` にする。 */
export function toConditions(draft: ConditionDraft): CustomConditionsInput {
    const inventory = ROLE_ORDER.filter((role) => filled(draft.inventory[role]));
    const numbers = (
        [
            'initialFlow',
            'orderDelayWeeks',
            'shipmentDelayWeeks',
            'productionDelayWeeks',
            'holdingCostMinor',
            'backlogCostMinor',
        ] as const
    ).filter((name) => filled(draft[name]));
    return {
        ...(inventory.length > 0
            ? {
                  initialInventory: Object.fromEntries(
                      inventory.map((role) => [role, toNumberOrRaw(draft.inventory[role])]),
                  ),
              }
            : {}),
        ...Object.fromEntries(numbers.map((name) => [name, toNumberOrRaw(draft[name])])),
        ...(draft.disclosurePolicy === ''
            ? {}
            : {
                  disclosurePolicy: draft.disclosurePolicy as 'TEAM_TOTAL' | 'NONE',
              }),
    };
}

interface NumberField {
    name: Exclude<keyof ConditionDraft, 'inventory' | 'disclosurePolicy'>;
    label: string;
    hint: string;
}

const NUMBER_FIELDS: readonly NumberField[] = [
    { name: 'initialFlow', label: '初期の流れ', hint: '0〜1000（空欄はキットの値 4）' },
    { name: 'orderDelayWeeks', label: '注文の遅延（週）', hint: '1〜8（空欄は 2）' },
    { name: 'shipmentDelayWeeks', label: '配送の遅延（週）', hint: '1〜8（空欄は 2）' },
    { name: 'productionDelayWeeks', label: '生産の遅延（週）', hint: '1〜8（空欄は 2）' },
    { name: 'holdingCostMinor', label: '在庫の単価', hint: '0〜100000（最小単位。空欄は 50）' },
    { name: 'backlogCostMinor', label: '受注残の単価', hint: '0〜100000（最小単位。空欄は 100）' },
];

export function CustomConditionsFields({
    draft,
    onChange,
    errors,
}: {
    draft: ConditionDraft;
    onChange: (next: ConditionDraft) => void;
    errors: FieldError[];
}) {
    return (
        <fieldset>
            <legend>カスタム条件（空欄はキットの値のまま）</legend>
            {ROLE_ORDER.map((role) => {
                const field = `conditions.initialInventory.${role}`;
                return (
                    <div className="field" key={role}>
                        <label
                            htmlFor={`inventory-${role}`}
                        >{`${ROLE_LABELS[role]}の初期在庫`}</label>
                        <input
                            id={`inventory-${role}`}
                            inputMode="numeric"
                            value={draft.inventory[role]}
                            onChange={(event) =>
                                onChange({
                                    ...draft,
                                    inventory: { ...draft.inventory, [role]: event.target.value },
                                })
                            }
                            {...fieldProps(errors, field, `inventory-${role}-hint`)}
                        />
                        <span id={`inventory-${role}-hint`} className="muted">
                            0〜1000（空欄は 12）
                        </span>
                    </div>
                );
            })}
            {NUMBER_FIELDS.map(({ name, label, hint }) => (
                <div className="field" key={name}>
                    <label htmlFor={name}>{label}</label>
                    <input
                        id={name}
                        inputMode="numeric"
                        value={draft[name]}
                        onChange={(event) => onChange({ ...draft, [name]: event.target.value })}
                        {...fieldProps(errors, `conditions.${name}`, `${name}-hint`)}
                    />
                    <span id={`${name}-hint`} className="muted">
                        {hint}
                    </span>
                </div>
            ))}
            <div className="field">
                <label htmlFor="disclosurePolicy">公開範囲</label>
                <select
                    id="disclosurePolicy"
                    value={draft.disclosurePolicy}
                    onChange={(event) =>
                        onChange({ ...draft, disclosurePolicy: event.target.value })
                    }
                    {...fieldProps(errors, 'conditions.disclosurePolicy')}
                >
                    <option value="">キットの値（チーム合計）</option>
                    <option value="TEAM_TOTAL">チーム合計</option>
                    <option value="NONE">なし</option>
                </select>
            </div>
        </fieldset>
    );
}
