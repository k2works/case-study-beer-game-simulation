import { inspect } from 'node:util';

const MASK = '[秘匿]';

/**
 * 資格情報（参加コード、進行役用コード、復帰用 token）を持つ型（NFR6.3）。
 * 文字列化、JSON 化、検査の出力のいずれも `[秘匿]` を返し、値は reveal() で通信に使うときだけ取り出す。
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}

/** 出力に、秘匿の値が含まれるか。ログと要約に生成した値が漏れていないことの確認に使う。 */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}
