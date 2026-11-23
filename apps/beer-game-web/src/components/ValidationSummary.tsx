import { useEffect, useRef } from 'react';
import type { FieldError } from '../api/types';

export const errorId = (field: string) => `error-${field}`;

export const messageOf = (error: FieldError): string =>
    error.week === undefined ? error.message : `第 ${error.week} 週: ${error.message}`;

/**
 * 入力の誤りの要約。誤りはすべて示し、要約へフォーカスを移して伝える（role="alert" は併用しない）。
 * 各入力欄は aria-describedby で、ここの項目（errorId）を指す。
 */
export function ValidationSummary({ errors }: { errors: FieldError[] }) {
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, [errors]);
    if (errors.length === 0) return null;
    return (
        <section
            ref={ref}
            tabIndex={-1}
            aria-labelledby="validation-summary"
            className="notice notice-error"
        >
            <h2 id="validation-summary">入力に誤りがあります</h2>
            <ul>
                {errors.map((error, index) => (
                    <li
                        key={`${error.field}-${index}`}
                        id={
                            index === firstIndexOf(errors, error.field)
                                ? errorId(error.field)
                                : undefined
                        }
                    >
                        {messageOf(error)}
                    </li>
                ))}
            </ul>
        </section>
    );
}

function firstIndexOf(errors: FieldError[], field: string): number {
    return errors.findIndex((error) => error.field === field);
}

/** 入力欄に渡す属性。誤りがあれば aria-invalid と、要約の項目への aria-describedby。 */
export function fieldProps(errors: FieldError[], field: string, hintId?: string) {
    const invalid = errors.some((error) => error.field === field);
    const describedBy = [hintId, invalid ? errorId(field) : undefined].filter(Boolean).join(' ');
    return {
        'aria-invalid': invalid ? (true as const) : undefined,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
    };
}
