import type { StreamVersions } from './types';

export interface CatchUpOptions {
    /** 取得の回数の上限（最初の取得を含む）。 */
    attempts: number;
    /** 再取得の間隔（ミリ秒）。 */
    intervalMs: number;
}

export const DEFAULT_CATCH_UP: CatchUpOptions = { attempts: 5, intervalMs: 300 };

export interface CaughtUp<T> {
    snapshot: T;
    /** 取得したスナップショットの版が、応答の versions 以上になったか。 */
    caughtUp: boolean;
}

function reached(actual: StreamVersions, target: StreamVersions): boolean {
    return (['game', 'session'] as const).every((stream) => {
        const wanted = target[stream];
        if (wanted === null) return true; // そのコマンドが追記しなかったストリームは比べない
        const got = actual[stream];
        return got !== null && got >= wanted;
    });
}

/**
 * コマンドの応答の versions に、取得したスナップショットが追いつくまで待つ（ui-design「保存直後の表示」）。
 * 表示は応答から作らず、必ずこの取得の結果から作る。上限までに追いつかなければ caughtUp: false で最後の取得を返す。
 * 取得の失敗は握りつぶさず、そのまま投げる。
 */
export async function fetchCaughtUp<T extends { versions: StreamVersions }>(
    load: () => Promise<T>,
    target: StreamVersions,
    options: CatchUpOptions = DEFAULT_CATCH_UP,
): Promise<CaughtUp<T>> {
    let snapshot = await load();
    for (let attempt = 1; !reached(snapshot.versions, target); attempt++) {
        if (attempt >= options.attempts) return { snapshot, caughtUp: false };
        await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs));
        snapshot = await load();
    }
    return { snapshot, caughtUp: true };
}
