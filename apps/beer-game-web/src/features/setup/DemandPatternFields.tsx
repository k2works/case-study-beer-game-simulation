import { useState } from 'react';
import { DEMAND_PATTERN_LABELS, buildDemand, type DemandPattern } from './demandPattern';

const MAX_DEMAND = 1000;
const MAX_FINAL_WEEK = 50;

/** 0 以上 [max] 以下の整数に読む。読めなければ null。 */
function parseInteger(text: string, min: number, max: number): number | null {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return value >= min && value <= max ? value : null;
}

/**
 * 需要系列を、一定・増加・減少で作る入力。開始値と増分値を指定して、最終週までの系列を作り、需要系列の欄に入れる。
 * 作ったあとも、欄は直接編集できる。
 */
export function DemandPatternFields({
    finalWeek,
    onGenerate,
}: {
    finalWeek: string;
    onGenerate: (values: number[]) => void;
}) {
    const [pattern, setPattern] = useState<DemandPattern>('CONSTANT');
    const [start, setStart] = useState('4');
    const [step, setStep] = useState('');
    const [invalid, setInvalid] = useState(false);
    const usesStep = pattern !== 'CONSTANT';

    function generate() {
        const weeks = parseInteger(finalWeek, 1, MAX_FINAL_WEEK);
        const first = parseInteger(start, 0, MAX_DEMAND);
        const delta = usesStep ? parseInteger(step, 0, MAX_DEMAND) : 0;
        const ok = weeks !== null && first !== null && delta !== null;
        setInvalid(!ok);
        if (ok) onGenerate(buildDemand(pattern, first, delta, weeks));
    }

    return (
        <fieldset className="field">
            <legend>需要系列の作成</legend>
            <label htmlFor="demandPattern">系列の作り方</label>
            <select
                id="demandPattern"
                value={pattern}
                onChange={(event) => setPattern(event.target.value as DemandPattern)}
            >
                {Object.entries(DEMAND_PATTERN_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                        {label}
                    </option>
                ))}
            </select>
            <label htmlFor="demandStart">開始値</label>
            <input
                id="demandStart"
                inputMode="numeric"
                value={start}
                onChange={(event) => setStart(event.target.value)}
            />
            {usesStep ? (
                <>
                    <label htmlFor="demandStep">増分値</label>
                    <input
                        id="demandStep"
                        inputMode="numeric"
                        value={step}
                        onChange={(event) => setStep(event.target.value)}
                    />
                </>
            ) : null}
            <button type="button" onClick={generate}>
                最終週まで系列を作る
            </button>
            {invalid ? (
                <span className="field-error">
                    開始値と増分値は 0〜1000、最終週は 1〜50 の整数で入力してください。
                </span>
            ) : null}
        </fieldset>
    );
}
