import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildChildEnv, UnsafeEnvError } from '../../../verification/shared/child-env.js';
import { Secret, containsSecret } from '../../../verification/shared/secret.js';
import { checkTarget, isLocalHost } from '../../../verification/shared/target-guard.js';

// 機能: 検証の仕組みが、本番や staging を傷つけず、資格情報を漏らさない（NFR6.1、NFR6.3、NFR7.2）

describe('シナリオ: 接続先の検査（TargetGuard）', () => {
  it('Given localhost の URL と localhost のデータベース When 検査する Then 通り、成果物の保存が有効', () => {
    const result = checkTarget({
      appUrl: 'http://localhost:3999',
      databaseUrl: 'postgres://postgres:postgres@localhost:55432/bg3_verify_1',
    });
    expect(result).toMatchObject({ ok: true, external: false, artifactsEnabled: true });
  });

  it.each(['http://127.0.0.1:4000/', 'http://[::1]:4000/'])(
    'Given %s When 検査する Then 通る',
    (appUrl) => {
      expect(checkTarget({ appUrl })).toMatchObject({ ok: true, artifactsEnabled: true });
    },
  );

  it('Given Unix ドメインソケットのデータベース When 検査する Then 通る', () => {
    expect(
      checkTarget({ databaseUrl: 'postgres://postgres@/bg3_verify_1?host=/var/run/postgresql' }),
    ).toMatchObject({ ok: true });
  });

  it('Given 外部のホストのアプリケーション When 許可なしで検査する Then 終了コード 2 で、URL の値を出さず項目名だけを出す', () => {
    const result = checkTarget({ appUrl: 'https://staging.example.com/' });
    expect(result).toMatchObject({ ok: false, exitCode: 2, item: 'appUrl' });
    expect(JSON.stringify(result)).not.toContain('staging.example.com');
  });

  it('Given 外部のホストのデータベース When 許可なしで検査する Then 終了コード 2', () => {
    const result = checkTarget({
      databaseUrl: 'postgres://app:pw@db.prod.example.com:5432/beer_game3',
    });
    expect(result).toMatchObject({ ok: false, exitCode: 2, item: 'databaseHost' });
    expect(JSON.stringify(result)).not.toContain('db.prod.example.com');
    expect(JSON.stringify(result)).not.toContain('pw');
  });

  it('Given host= パラメーターで外部を指す接続文字列 When 検査する Then 拒否する（URL の host が localhost でも）', () => {
    expect(
      checkTarget({ databaseUrl: 'postgres://postgres@localhost/db?host=db.prod.example.com' }),
    ).toMatchObject({ ok: false, exitCode: 2, item: 'databaseHost' });
    expect(
      checkTarget({ databaseUrl: 'postgres://postgres@localhost/db?hostaddr=203.0.113.9' }),
    ).toMatchObject({ ok: false, exitCode: 2, item: 'databaseHost' });
  });

  it('Given 解析できない接続文字列 When 検査する Then 拒否する（複数ホストを含む）', () => {
    expect(checkTarget({ databaseUrl: 'not a url' })).toMatchObject({ ok: false, exitCode: 2 });
    expect(checkTarget({ databaseUrl: 'postgres://localhost,db.example.com/db' })).toMatchObject({
      ok: false,
      exitCode: 2,
    });
  });

  it('Given 外部のホスト When 許可（allowRemote）つきで検査する Then 通るが、成果物の保存は無効で、外部接続と記録する', () => {
    const result = checkTarget({ appUrl: 'https://staging.example.com/', allowRemote: true });
    expect(result).toMatchObject({ ok: true, external: true, artifactsEnabled: false });
  });

  it('isLocalHost は localhost、127.0.0.1、::1 だけを許す', () => {
    expect(['localhost', '127.0.0.1', '::1', '[::1]'].every(isLocalHost)).toBe(true);
    expect(
      ['example.com', '10.0.0.1', '0.0.0.0', 'localhost.example.com', ''].some(isLocalHost),
    ).toBe(false);
  });
});

describe('シナリオ: 子プロセスの環境は空から組み立てる', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    PGHOST: 'db.prod.example.com',
    PGPASSWORD: 'prod-secret',
    DATABASE_URL: 'postgres://prod/db',
    AWS_SECRET_ACCESS_KEY: 'aws',
    CODE_ENC_KEY: 'inherited',
    NODE_OPTIONS: '--inspect',
  };

  it('Given 外部の接続情報を持つ親の環境 When 子の環境を組み立てる Then PG*、DATABASE_URL、鍵、不明な変数を継承しない', () => {
    const env = buildChildEnv(parent, { HOST: '127.0.0.1' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOST).toBe('127.0.0.1');
    for (const name of [
      'PGHOST',
      'PGPASSWORD',
      'DATABASE_URL',
      'AWS_SECRET_ACCESS_KEY',
      'CODE_ENC_KEY',
      'NODE_OPTIONS',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('Given 明示した DATABASE_URL When 組み立てる Then 明示した値だけが入る', () => {
    const env = buildChildEnv(parent, {
      DATABASE_URL: 'postgres://postgres@localhost/bg3_verify_1',
    });
    expect(env.DATABASE_URL).toBe('postgres://postgres@localhost/bg3_verify_1');
  });

  it('Given PG* を明示で渡そうとする When 組み立てる Then 拒否する', () => {
    expect(() => buildChildEnv(parent, { PGHOST: 'localhost' })).toThrow(UnsafeEnvError);
  });
});

describe('シナリオ: 資格情報の型（Secret）', () => {
  const secret = new Secret('JOIN-ABCD-1234');

  it('Given Secret When 文字列化、JSON 化、検査の出力をする Then いずれも [秘匿] で、値を含まない', () => {
    expect(String(secret)).toBe('[秘匿]');
    expect(`${secret}`).toBe('[秘匿]');
    expect(JSON.stringify({ code: secret })).toBe('{"code":"[秘匿]"}');
    expect(inspect(secret)).toBe('[秘匿]');
    expect(inspect({ nested: { secret } })).not.toContain('JOIN-ABCD-1234');
  });

  it('Given Secret When reveal する Then 値を取り出せる（通信に使うときだけ）', () => {
    expect(secret.reveal()).toBe('JOIN-ABCD-1234');
  });

  it('containsSecret は出力に秘匿の値が含まれるかを調べる', () => {
    expect(containsSecret('hello JOIN-ABCD-1234', ['JOIN-ABCD-1234'])).toBe(true);
    expect(containsSecret('hello [秘匿]', ['JOIN-ABCD-1234'])).toBe(false);
  });
});
