import type { RoleStatus } from '../../api/types';

/**
 * 今週の状況の表（S05）。見出し行に項目、値の行に数値を並べる。顧客需要は小売店だけが持つので、あるときだけ列を足す。
 * 幅が足りない画面では、表の中だけを横にスクロールする。
 */
export function StatusTable({ roleStatus }: { roleStatus: RoleStatus }) {
    const columns: { name: string; value: number }[] = [
        { name: '在庫', value: roleStatus.inventory },
        { name: '受注残', value: roleStatus.backlog },
        { name: '入荷', value: roleStatus.arrivals },
        { name: '受注', value: roleStatus.orders },
        ...(roleStatus.customerDemand === undefined
            ? []
            : [{ name: '顧客需要', value: roleStatus.customerDemand }]),
    ];
    return (
        <div className="table-scroll">
            <table className="results-table status-table" aria-label="今週の状況の表">
                <thead>
                    <tr>
                        {columns.map((column) => (
                            <th key={column.name} scope="col">
                                {column.name}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        {columns.map((column) => (
                            <td key={column.name}>{column.value}</td>
                        ))}
                    </tr>
                </tbody>
            </table>
        </div>
    );
}
