import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/**
 * 共有する API の契約（apps/beer-game-contracts/openapi.yaml。Kotlin 版・Rust 版・共有 UI と同じ）を読み、
 * 実際の応答を、契約のスキーマで検証する。Rust 版の contract.rs と同じ方式（components を合成して $ref を解決する）。
 * 契約は、この版（TypeScript）からは変更しない。
 */
const SPEC_URL = new URL(
  '../../../beer-game-contracts/openapi.yaml',
  import.meta.url,
);

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

interface RawOperation {
  operationId?: string;
}
interface RawSpec {
  servers: { url: string }[];
  paths: Record<string, Record<string, RawOperation>>;
  components: { schemas: Record<string, unknown> };
}

export interface Operation {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** 契約のパス（`/api/v1` から後ろ。`{gameId}` の形） */
  path: string;
  /** Fastify のルートの形（`/api/v1/games/:gameId/lobby`） */
  routeUrl: string;
}

const spec = parse(readFileSync(fileURLToPath(SPEC_URL), 'utf8')) as RawSpec;

/** `servers[0].url`（`/api/v1`）。契約のパスの接頭辞 */
export const BASE_PATH = spec.servers[0]!.url;

/** 契約の全操作（operationId を持つもの） */
export function operations(): Operation[] {
  const found: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      found.push({
        operationId: op.operationId,
        method: method.toUpperCase() as Operation['method'],
        path,
        routeUrl: BASE_PATH + path.replace(/\{([^}]+)\}/g, ':$1'),
      });
    }
  }
  return found;
}

/** 契約のスキーマ名の一覧（`components.schemas`） */
export function schemaNames(): string[] {
  return Object.keys(spec.components.schemas);
}

// 契約は OpenAPI 3.1（JSON Schema 2020-12）。example・description などの注釈は無視する
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats は CommonJS で、NodeNext の型では、プラグインが `.default` に入る
addFormats.default(ajv);

const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validatorOf(name: string) {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({
      $ref: `#/components/schemas/${name}`,
      components: spec.components,
    });
    validators.set(name, validate);
  }
  return validate;
}

/** `components.schemas.<name>` で検証する。違反は、すべて集めて返す（空なら適合） */
export function violations(name: string, instance: unknown): string[] {
  const validate = validatorOf(name);
  if (validate(instance)) return [];
  return (validate.errors ?? []).map((e: ErrorObject) =>
    `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim(),
  );
}

/** 適合を主張する。違反があれば、スキーマ名・違反・応答をまとめて失敗にする */
export function expectConforms(name: string, instance: unknown): void {
  const found = violations(name, instance);
  if (found.length > 0) {
    throw new Error(
      `${name} に違反: ${JSON.stringify(found)}\n応答: ${JSON.stringify(instance)}`,
    );
  }
}
