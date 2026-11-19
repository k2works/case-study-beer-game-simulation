/**
 * 接続先の検査（TargetGuard。security-design.md）。
 * 試験のスクリプトが組み立てた最終の接続設定を、通信の前に 1 度だけ検査し、`localhost` 以外を、
 * 許可（VERIFY_ALLOW_REMOTE=1）がない限り拒否する。結果の理由には URL の値を出さず、検査した項目名だけを出す。
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface GuardInput {
  /** アプリケーションの URL（外部接続のモードだけが指定する） */
  appUrl?: string | undefined;
  /** データベースの接続文字列 */
  databaseUrl?: string | undefined;
  /** 許可の設定（VERIFY_ALLOW_REMOTE=1） */
  allowRemote?: boolean | undefined;
  /** 検査と接続を行う親のプロセスの環境（PGHOST、PGHOSTADDR、PGSERVICE を検査する）。呼び出しは process.env を渡す */
  env?: Record<string, string | undefined> | undefined;
}

export type GuardResult =
  | {
      ok: true;
      /** 外部の接続先を許可して実行するか。要約に「外部接続で実行」と記録する */
      external: boolean;
      /** トレース、画面の画像などの成果物を保存してよいか。外部接続では常に false */
      artifactsEnabled: boolean;
      /** 検査した項目名 */
      checked: string[];
    }
  | {
      ok: false;
      exitCode: 2;
      /** 検査に通らなかった項目名（値は出さない） */
      item: 'appUrl' | 'databaseHost';
      reason: string;
    };

/** ホスト名が localhost、127.0.0.1、::1 のいずれかか（角括弧つきの ::1 も含む）。 */
export function isLocalHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return LOCAL_HOSTS.has(bare.toLowerCase());
}

/** データベースの接続先の判定。Unix ドメインソケット（パスが / で始まる）は通る。 */
function isLocalDatabaseHost(host: string): boolean {
  return host === '' || host.startsWith('/') || isLocalHost(host);
}

/**
 * 接続文字列が接続しうるホストをすべて返す。解析できない、または最終の接続先を 1 つに決められない
 * （複数ホスト）ときは null。WHATWG の URL は「資格情報あり、host が空」（Unix ソケットの形）を
 * 失敗にするため、自前で分解する。
 */
function databaseHostsOf(connectionString: string): string[] | null {
  const match = /^postgres(?:ql)?:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(connectionString);
  if (!match) {
    return null;
  }
  const authority = match[1] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.includes(',')) {
    // 複数ホストの指定は、最終の接続先を 1 つに決められないため拒否する
    return null;
  }
  let host: string;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) {
      return null;
    }
    host = hostPort.slice(0, close + 1);
  } else {
    host = hostPort.split(':')[0] ?? '';
  }
  let hosts: string[];
  try {
    // URL の host が空（`postgres:///db`）のとき、接続先は実行環境の PGHOST で決まりうるため、
    // host= または hostaddr= の明示がなければ最終の接続先を決められず、拒否する（null）
    const urlHost = decodeURIComponent(host);
    hosts = urlHost === '' ? [] : [urlHost];
    // host= と hostaddr= の指定は、URL の host を上書きするため、すべて検査する
    const params = new URLSearchParams(match[3] ?? '');
    for (const name of ['host', 'hostaddr']) {
      for (const value of params.getAll(name)) {
        if (value.includes(',')) {
          return null;
        }
        hosts.push(value);
      }
    }
  } catch {
    return null;
  }
  return hosts.length === 0 ? null : hosts;
}

/**
 * 検査と接続を行う親のプロセスの環境の PG*（pg は接続文字列に無い項目を環境から補う）が、
 * 外部を指さないか。PGSERVICE は接続先を設定ファイルから決めるため、指定があれば拒否する。
 */
function environmentIsLocal(env: Record<string, string | undefined>): boolean {
  const host = env['PGHOST'];
  if (host !== undefined && host !== '' && !isLocalDatabaseHost(host)) {
    return false;
  }
  const hostaddr = env['PGHOSTADDR'];
  if (hostaddr !== undefined && hostaddr !== '' && !isLocalHost(hostaddr)) {
    return false;
  }
  const service = env['PGSERVICE'];
  return service === undefined || service === '';
}

const FAILED_APP: GuardResult = {
  ok: false,
  exitCode: 2,
  item: 'appUrl',
  reason: '接続先が試験用でない（アプリケーションの URL）',
};
const FAILED_DB: GuardResult = {
  ok: false,
  exitCode: 2,
  item: 'databaseHost',
  reason: '接続先が試験用でない（データベースのホスト）',
};

export function checkTarget(input: GuardInput): GuardResult {
  const checked: string[] = [];
  let external = false;

  if (input.appUrl !== undefined) {
    checked.push('appUrl');
    let host: string | null;
    try {
      host = new URL(input.appUrl).hostname;
    } catch {
      host = null;
    }
    if (host === null || !isLocalHost(host)) {
      if (!input.allowRemote) {
        return FAILED_APP;
      }
      external = true;
    }
  }

  if (input.databaseUrl !== undefined) {
    checked.push('databaseHost');
    const hosts = databaseHostsOf(input.databaseUrl);
    const env = input.env ?? {};
    if (hosts === null || !hosts.every(isLocalDatabaseHost) || !environmentIsLocal(env)) {
      if (!input.allowRemote) {
        return FAILED_DB;
      }
      external = true;
    }
  }

  return { ok: true, external, artifactsEnabled: !external, checked };
}
