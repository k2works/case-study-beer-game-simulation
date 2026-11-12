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
  DecisionBy,
  GameRow,
  GameTx,
  GameUpdate,
  IdempotencyRow,
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
  tokenHash: string;
  participantId: string;
  revokedAt: Date | null;
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
  private readonly locks = new Map<string, Lock>();
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
        return { gameId: data.game.gameId, participantId: token.participantId, role: role ?? null };
      }
    }
    return null;
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
      this.games.set(gameId, working);
      return result;
    } finally {
      release();
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

  async addParticipant(participant: ParticipantRow, tokenHash: string): Promise<void> {
    this.failure()('addParticipant');
    this.data.participants.push(structuredClone(participant));
    this.data.tokens.push({
      tokenHash,
      participantId: participant.participantId,
      revokedAt: null,
    });
  }

  async setAssignment(
    participantId: string,
    role: Role | null,
    assignmentId: string,
  ): Promise<void> {
    this.failure()('setAssignment');
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
}
