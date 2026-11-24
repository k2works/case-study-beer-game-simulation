import type { RoleWeekResult } from '../api/types';
import { ROLE_LABELS, ROLE_ORDER } from '../labels';

const COLUMNS = [
    '週',
    '役割',
    '受注',
    '発注',
    '在庫',
    '受注残',
    '出荷',
    '費用',
    '累計費用',
] as const;

/** 同じ週は小売店から工場の順。週は、新しい順（既定）か、古い順。 */
const sortedResults = (results: readonly RoleWeekResult[], newestFirst: boolean) =>
    [...results].sort(
        (a, b) =>
            (newestFirst ? b.week - a.week : a.week - b.week) ||
            ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
    );

/**
 * 週ごと・役割ごとの結果の表（S06 コンソール・S08 振り返り）。1 行が、1 つの週の 1 つの役割。役割は行見出し。
 * 幅が足りない画面では、表の中だけを横にスクロールする（ページは横にスクロールさせない）。
 * [label] は表の名前（画面ごとに変える）。[newestFirst] は、進行中の確認は新しい週を上、振り返りは古い週を上にするため。
 */
export function ResultsTable({
    results,
    label = '確定した週の結果の表',
    newestFirst = true,
}: {
    results: readonly RoleWeekResult[];
    label?: string;
    newestFirst?: boolean;
}) {
    return (
        <div className="table-scroll">
            <table className="results-table" aria-label={label}>
                <thead>
                    <tr>
                        {COLUMNS.map((name) => (
                            <th key={name} scope="col">
                                {name}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sortedResults(results, newestFirst).map((result) => (
                        <tr key={`${result.week}-${result.role}`}>
                            <td>{result.week}</td>
                            <th scope="row">{ROLE_LABELS[result.role]}</th>
                            <td>{result.orders}</td>
                            <td>{result.order}</td>
                            <td>{result.inventory}</td>
                            <td>{result.backlog}</td>
                            <td>{result.shipment}</td>
                            <td>{result.cost}</td>
                            <td>{result.cumulativeCost}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
