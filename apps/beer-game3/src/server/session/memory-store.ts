import { randomUUID } from 'node:crypto';
import {
  CodeCollisionError,
  VersionConflictError,
  notFoundError,
  unavailableError,
} from '../errors.js';
import type { Role } from '../domain/types.js';
import type { LogEntryRow, NewLogEntry } from './history.js';
import type {
  AccessCodeKind,
  AccessCodeRow,
  AssignmentRow,
  ConfirmedRecord,
  CredentialCode,
  DecisionBy,
  ExclusiveResult,
  GameRow,
  GameTx,
  GameUpdate,
  IdempotencyRow,
  JoinAttemptInput,
  JoinAttemptOutcome,
  NewGame,
  ParticipantRow,
  ResolvedToken,
  SettingsRow,
  Snapshot,
  SlotRow,
  Store,
  WeekRecordRow,
} from './store.js';

interface TokenRow {
  tokenId: string;
  tokenHash: string;
  participantId: string;
  lastUsedAt: Date;
  revokedAt: Date | null;
}

interface JoinAttemptRow {
  id: number;
  sourceKey: string;
  attemptedAt: Date;
}

interface GameData {
  game: GameRow;
  settings: SettingsRow;
  participants: ParticipantRow[];
  assignments: AssignmentRow[];
  weekRecords: WeekRecordRow[];
  slots: SlotRow[];
  idempotency: IdempotencyRow[];
  tokens: TokenRow[];
  codes: AccessCodeRow[];
  log: LogEntryRow[];
}

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

interface Lock {
  held: boolean;
  waiters: Waiter[];
}

export interface MemoryStoreOptions {
  /** 同じゲームの書き込みの順番待ちの上限（ミリ秒） */
  lockTimeoutMs: number;
}

/**
 * メモリ上の保存。DB を使わない振る舞いの試験に使う。
 * PostgreSQL の保存と同じ約束を守る: ゲーム単位の直列処理（待ちの上限つき）、1 回の保存での原子性、版の検査。
 */
export class MemoryStore implements Store {
  private readonly games = new Map<string, GameData>();
  private joinAttempts: JoinAttemptRow[] = [];
  private nextAttemptId = 1;
  private readonly locks = new Map<string, Lock>();
  private readonly exclusive = new Set<string>();
  private readonly lockTimeoutMs: number;
  /** 試験用: 次の書き込みで、指定の操作を失敗させる（原子性の試験） */
  failNextWriteOn: string | null = null;

  constructor(options: MemoryStoreOptions = { lockTimeoutMs: 3000 }) {
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  async createGame(input: NewGame): Promise<void> {
    for (const code of input.codes) {
      for (const data of this.games.values()) {
        if (data.codes.some((c) => c.codeHash === code.codeHash)) {
          throw new CodeCollisionError();
        }
      }
    }
    const log = input.logs.map((entry, index) => ({
      ...entry,
      gameId: input.game.gameId,
      sequence: index + 1,
    }));
    this.games.set(
      input.game.gameId,
      structuredClone({
        game: { ...input.game, nextLogSequence: log.length + 1 },
        log,
        settings: input.settings,
        participants: [],
        assignments: [],
        weekRecords: [],
        slots: [],
        idempotency: [],
        tokens: [],
        codes: input.codes,
      } satisfies GameData),
    );
  }

  async findCodeByHash(
    hashes: string[],
    kind: AccessCodeKind,
  ): Promise<{ gameId: string; kind: AccessCodeKind } | null> {
    for (const data of this.games.values()) {
      const found = data.codes.find((c) => c.kind === kind && hashes.includes(c.codeHash));
      if (found) {
        return { gameId: found.gameId, kind: found.kind };
      }
    }
    return null;
  }

  async findTokenByHash(hash: string): Promise<ResolvedToken | null> {
    for (const data of this.games.values()) {
      const token = data.tokens.find((t) => t.tokenHash === hash && t.revokedAt === null);
      if (token) {
        const role = data.assignments.find((a) => a.participantId === token.participantId)?.role;
        return {
          tokenId: token.tokenId,
          gameId: data.game.gameId,
          participantId: token.participantId,
          role: role ?? null,
          lastUsedAt: new Date(token.lastUsedAt),
        };
      }
    }
    return null;
  }

  async findCredentialCode(hashes: string[]): Promise<CredentialCode | null> {
    for (const data of this.games.values()) {
      const found = data.codes.find(
        (c) => (c.kind === 'facilitator' || c.kind === 'observer') && hashes.includes(c.codeHash),
      );
      if (found) {
        return { gameId: found.gameId, kind: found.kind as 'facilitator' | 'observer' };
      }
    }
    return null;
  }

  async touchToken(tokenId: string, now: Date, minIntervalMs: number): Promise<boolean> {
    for (const data of this.games.values()) {
      const token = data.tokens.find((t) => t.tokenId === tokenId && t.revokedAt === null);
      if (token) {
        if (token.lastUsedAt.getTime() <= now.getTime() - minIntervalMs) {
          token.lastUsedAt = new Date(now);
          return true;
        }
        return false;
      }
    }
    return false;
  }

  /** 1 つの同期的な処理なので、await をはさまず、他の試行と交わらない（接続元ごとの排他の代わり）。 */
  async attemptJoin(input: JoinAttemptInput): Promise<JoinAttemptOutcome> {
    const cutoff = input.now.getTime() - input.windowMs;
    this.joinAttempts = this.joinAttempts.filter(
      (row) => row.sourceKey !== input.sourceKey || row.attemptedAt.getTime() >= cutoff,
    );
    const mine = this.joinAttempts.filter((row) => row.sourceKey === input.sourceKey);
    const record = (): void => {
      this.joinAttempts.push({
        id: this.nextAttemptId++,
        sourceKey: input.sourceKey,
        attemptedAt: new Date(input.now),
      });
    };
    if (mine.length >= input.maxAttempts) {
      record();
      // 接続元ごとに最新の maxAttempts + 1 件だけ残す
      const newest = this.joinAttempts
        .filter((row) => row.sourceKey === input.sourceKey)
        .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime() || b.id - a.id)
        .slice(0, input.maxAttempts + 1);
      const keep = new Set(newest.map((row) => row.id));
      this.joinAttempts = this.joinAttempts.filter(
        (row) => row.sourceKey !== input.sourceKey || keep.has(row.id),
      );
      return { result: 'limited' };
    }
    for (const data of this.games.values()) {
      const found = data.codes.find(
        (c) => c.kind === 'join' && input.codeHashes.includes(c.codeHash),
      );
      if (found) {
        return { result: 'valid', gameId: found.gameId };
      }
    }
    record();
    return { result: 'invalid' };
  }

  async sweepJoinAttempts(olderThan: Date): Promise<number> {
    const before = this.joinAttempts.length;
    this.joinAttempts = this.joinAttempts.filter(
      (row) => row.attemptedAt.getTime() >= olderThan.getTime(),
    );
    return before - this.joinAttempts.length;
  }

  async countJoinAttempts(sourceKey?: string): Promise<number> {
    return sourceKey === undefined
      ? this.joinAttempts.length
      : this.joinAttempts.filter((row) => row.sourceKey === sourceKey).length;
  }

  async getAccessCode(gameId: string, kind: AccessCodeKind): Promise<AccessCodeRow | null> {
    const row = this.games.get(gameId)?.codes.find((c) => c.kind === kind);
    return row ? structuredClone(row) : null;
  }

  async readSnapshot(gameId: string): Promise<Snapshot | null> {
    const data = this.games.get(gameId);
    return data ? structuredClone(snapshotOf(data)) : null;
  }

  async readHistory(gameId: string): Promise<LogEntryRow[]> {
    const data = this.games.get(gameId);
    return data ? structuredClone([...data.log].sort((a, b) => a.sequence - b.sequence)) : [];
  }

  async transact<T>(gameId: string, fn: (tx: GameTx) => Promise<T>): Promise<T> {
    if (!this.games.has(gameId)) {
      throw notFoundError('ゲームが見つかりません');
    }
    const release = await this.acquire(gameId);
    try {
      const committed = this.games.get(gameId);
      if (!committed) {
        throw notFoundError('ゲームが見つかりません');
      }
      const working = structuredClone(committed);
      const tx = new MemoryTx(working, () => this.consumeFailure.bind(this));
      const result = await fn(tx);
      if (tx.deleted) {
        this.games.delete(gameId);
      } else {
        this.games.set(gameId, working);
      }
      return result;
    } finally {
      release();
    }
  }

  async findStaleGames(before: Date, limit: number, exclude: readonly string[]): Promise<string[]> {
    return [...this.games.values()]
      .filter(
        (data) =>
          data.game.status !== 'ended' &&
          data.game.lastOperationAt.getTime() <= before.getTime() &&
          !exclude.includes(data.game.gameId),
      )
      .sort(
        (a, b) =>
          a.game.lastOperationAt.getTime() - b.game.lastOperationAt.getTime() ||
          a.game.gameId.localeCompare(b.game.gameId),
      )
      .slice(0, limit)
      .map((data) => data.game.gameId);
  }

  async findExpiredGames(
    before: Date,
    limit: number,
    exclude: readonly string[],
  ): Promise<string[]> {
    return [...this.games.values()]
      .filter(
        (data) =>
          data.game.status === 'ended' &&
          data.game.endedAt !== null &&
          data.game.endedAt.getTime() <= before.getTime() &&
          !exclude.includes(data.game.gameId),
      )
      .sort(
        (a, b) =>
          a.game.endedAt!.getTime() - b.game.endedAt!.getTime() ||
          a.game.gameId.localeCompare(b.game.gameId),
      )
      .slice(0, limit)
      .map((data) => data.game.gameId);
  }

  /** 同じプロセスの実行中の印で、二重実行を防ぐ。待たない（BR26.2）。 */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<ExclusiveResult<T>> {
    if (this.exclusive.has(key)) {
      return { acquired: false };
    }
    this.exclusive.add(key);
    try {
      return { acquired: true, value: await fn() };
    } finally {
      this.exclusive.delete(key);
    }
  }

  async ping(): Promise<void> {
    // メモリ上の保存は常に接続できる
  }

  async close(): Promise<void> {
    // 閉じる資源はない
  }

  private consumeFailure(operation: string): void {
    if (this.failNextWriteOn === operation) {
      this.failNextWriteOn = null;
      throw new Error(`試験用に注入した保存の失敗: ${operation}`);
    }
  }

  private acquire(gameId: string): Promise<() => void> {
    let lock = this.locks.get(gameId);
    if (!lock) {
      lock = { held: false, waiters: [] };
      this.locks.set(gameId, lock);
    }
    const current = lock;
    const release = (): void => {
      const next = current.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant();
      } else {
        current.held = false;
      }
    };
    if (!current.held) {
      current.held = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => resolve(release),
        timer: setTimeout(() => {
          current.waiters = current.waiters.filter((w) => w !== waiter);
          reject(unavailableError());
        }, this.lockTimeoutMs),
      };
      current.waiters.push(waiter);
    });
  }
}

function snapshotOf(data: GameData): Snapshot {
  return {
    game: data.game,
    settings: data.settings,
    participants: data.participants,
    assignments: data.assignments,
    weekRecords: data.weekRecords,
    slots: data.slots,
  };
}

class MemoryTx implements GameTx {
  mutated = false;
  /** deleteGame が呼ばれた。コミットのときにゲームごと取り除く */
  deleted = false;

  constructor(
    private readonly data: GameData,
    private readonly failure: () => (operation: string) => void,
  ) {}

  game(): GameRow {
    return structuredClone(this.data.game);
  }

  async settings(): Promise<SettingsRow> {
    return structuredClone(this.data.settings);
  }

  async participants(): Promise<ParticipantRow[]> {
    return structuredClone(this.data.participants);
  }

  async assignments(): Promise<AssignmentRow[]> {
    return structuredClone(this.data.assignments);
  }

  async weekRecords(week?: number): Promise<WeekRecordRow[]> {
    return structuredClone(
      week === undefined
        ? this.data.weekRecords
        : this.data.weekRecords.filter((r) => r.week === week),
    );
  }

  async slots(): Promise<SlotRow[]> {
    return structuredClone(this.data.slots);
  }

  async snapshot(): Promise<Snapshot> {
    return structuredClone(snapshotOf(this.data));
  }

  async addParticipant(
    participant: ParticipantRow,
    tokenHash: string,
    issuedAt: Date,
  ): Promise<void> {
    this.failure()('addParticipant');
    this.mutated = true;
    this.data.participants.push(structuredClone(participant));
    this.data.tokens.push({
      tokenId: randomUUID(),
      tokenHash,
      participantId: participant.participantId,
      // 発行の時刻から有効期間を数える（BR17.6）
      lastUsedAt: new Date(issuedAt),
      revokedAt: null,
    });
  }

  async setAssignment(
    participantId: string,
    role: Role | null,
    assignmentId: string,
  ): Promise<void> {
    this.failure()('setAssignment');
    this.mutated = true;
    this.data.assignments = this.data.assignments.filter((a) => a.participantId !== participantId);
    if (role !== null) {
      this.data.assignments.push({
        assignmentId,
        gameId: this.data.game.gameId,
        participantId,
        role,
      });
    }
  }

  async insertWeekRecords(rows: WeekRecordRow[]): Promise<void> {
    this.failure()('insertWeekRecords');
    this.mutated = true;
    this.data.weekRecords.push(...structuredClone(rows));
  }

  async setDecision(
    week: number,
    role: Role,
    quantity: number,
    by: DecisionBy,
    at: Date,
  ): Promise<void> {
    this.failure()('setDecision');
    this.mutated = true;
    const record = this.data.weekRecords.find((r) => r.week === week && r.role === role);
    if (!record || record.isConfirmed) {
      throw new Error('入力できる週の記録がありません');
    }
    record.decision = quantity;
    record.decidedByKind = by.kind;
    record.decidedByParticipantId = by.participantId;
    record.decidedAt = new Date(at);
    record.decisionRevision += 1;
  }

  async hasActiveToken(participantId: string): Promise<boolean> {
    return this.data.tokens.some((t) => t.participantId === participantId && t.revokedAt === null);
  }

  async replaceParticipant(participantId: string, at: Date): Promise<void> {
    this.failure()('replaceParticipant');
    this.mutated = true;
    const participant = this.data.participants.find((p) => p.participantId === participantId);
    if (!participant) {
      throw new Error('参加者がいません');
    }
    participant.replacedAt = new Date(at);
    for (const token of this.data.tokens) {
      if (token.participantId === participantId && token.revokedAt === null) {
        token.revokedAt = new Date(at);
      }
    }
  }

  async confirmRecords(week: number, records: ConfirmedRecord[]): Promise<void> {
    this.failure()('confirmRecords');
    this.mutated = true;
    for (const result of records) {
      const record = this.data.weekRecords.find((r) => r.week === week && r.role === result.role);
      if (!record) {
        throw new Error('週の記録がありません');
      }
      Object.assign(record, {
        receipt: result.receipt,
        ordersReceived: result.ordersReceived,
        shipped: result.shipped,
        inventory: result.inventory,
        backlog: result.backlog,
        weeklyCost: result.weeklyCost,
        cumulativeCost: result.cumulativeCost,
        isConfirmed: true,
      });
    }
  }

  async replaceSlots(rows: SlotRow[]): Promise<void> {
    this.failure()('replaceSlots');
    this.mutated = true;
    this.data.slots = structuredClone(rows);
  }

  async findIdempotency(
    operation: IdempotencyRow['operation'],
    requesterId: string,
    key: string,
  ): Promise<IdempotencyRow | null> {
    const row = this.data.idempotency.find(
      (r) => r.operation === operation && r.requesterId === requesterId && r.key === key,
    );
    return row ? structuredClone(row) : null;
  }

  async saveIdempotency(row: IdempotencyRow): Promise<void> {
    this.failure()('saveIdempotency');
    this.data.idempotency.push(structuredClone(row));
  }

  async updateGame(
    update: GameUpdate,
    expectedVersion: number,
    logs: readonly NewLogEntry[],
  ): Promise<GameRow> {
    this.failure()('updateGame');
    this.mutated = true;
    if (this.data.game.version !== expectedVersion) {
      throw new VersionConflictError();
    }
    for (const entry of logs) {
      this.failure()('appendLog');
      this.data.log.push(
        structuredClone({
          ...entry,
          gameId: this.data.game.gameId,
          sequence: this.data.game.nextLogSequence,
        }),
      );
      this.data.game.nextLogSequence += 1;
    }
    this.data.game = {
      ...this.data.game,
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.currentWeek !== undefined ? { currentWeek: update.currentWeek } : {}),
      ...(update.endedAt !== undefined ? { endedAt: update.endedAt } : {}),
      ...(update.endReason !== undefined ? { endReason: update.endReason } : {}),
      version: this.data.game.version + 1,
    };
    return structuredClone(this.data.game);
  }

  async touchOperation(at: Date): Promise<void> {
    if (at.getTime() > this.data.game.lastOperationAt.getTime()) {
      this.data.game.lastOperationAt = new Date(at);
    }
  }

  async deleteGame(): Promise<void> {
    this.failure()('deleteGame');
    if (this.data.game.status !== 'ended') {
      throw new Error('終了していないゲームは削除できません');
    }
    this.deleted = true;
  }
}
