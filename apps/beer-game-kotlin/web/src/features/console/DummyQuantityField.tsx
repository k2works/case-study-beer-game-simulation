import type { Role } from '../../api/types';
import { ROLE_LABELS } from '../../labels';

/** 開発用の代理入力の数量の欄（役割ごと）。範囲外のときは、その欄に範囲を案内する。 */
export function DummyQuantityField({
    role,
    value,
    invalid,
    onChange,
}: {
    role: Role;
    value: string;
    invalid: boolean;
    onChange: (text: string) => void;
}) {
    const id = `dummy-quantity-${role}`;
    const errorId = `${id}-error`;
    return (
        <div className="field">
            <label htmlFor={id}>{`${ROLE_LABELS[role]}の代理入力の数量`}</label>
            <input
                id={id}
                inputMode="numeric"
                value={value}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(event) => onChange(event.target.value)}
            />
            {invalid ? (
                <span id={errorId} className="field-error">
                    数量は 0〜1000 の整数で入力してください。
                </span>
            ) : null}
        </div>
    );
}
