import type { Role, RoleWeekResult } from '../../api/types';
import { ROLE_LABELS, ROLE_ORDER } from '../../labels';

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

/** 新しい週を上に、同じ週は小売店から工場の順。 */
const sortedResults = (results: readonly RoleWeekResult[]) =>
    [...results].sort(
        (a, b) => b.week - a.week || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
    );

const roleLabel = (role: Role) => ROLE_LABELS[role];

/**
 * 確定した週の結果の表（S06）。1 行が、1 つの週の 1 つの役割。役割は行見出し。
 * 幅が足りない画面では、表の中だけを横にスクロールする（ページは横にスクロールさせない）。
 */
export function ResultsTable({ results }: { results: readonly RoleWeekResult[] }) {
    return (
        <div className="table-scroll">
            <table className="results-table" aria-label="確定した週の結果の表">
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
                    {sortedResults(results).map((result) => (
                        <tr key={`${result.week}-${result.role}`}>
                            <td>{result.week}</td>
                            <th scope="row">{roleLabel(result.role)}</th>
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
