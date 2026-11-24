import type { FieldError, ProblemBody, Role } from './types';

/** サーバーが problem+json（または想定外の本文）で返した失敗。 */
export class ApiError extends Error {
    readonly status: number;
    readonly body: ProblemBody;

    constructor(status: number, body: ProblemBody = {}) {
        super(body.code ?? `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }

    get code(): string | undefined {
        return this.body.code;
    }

    /** problem+json の type。バックエンド自身が返した失敗は必ず持つ（LB の応答と区別する）。 */
    get type(): string | undefined {
        return this.body.type;
    }

    get correlationId(): string | undefined {
        return this.body.correlationId;
    }

    get errors(): FieldError[] {
        return this.body.errors ?? [];
    }

    get missingRoles(): Role[] {
        return this.body.missingRoles ?? [];
    }
}

/** 通信の失敗（切断、タイムアウトなど）。結果は不明。 */
export class NetworkError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'NetworkError';
    }
}
