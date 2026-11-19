import { createHash } from 'node:crypto';
import type {
  AccessControl,
  FacilitatorPrincipal,
  ParticipantPrincipal,
  Principal,
} from '../access/access-control.js';
import { normalizeJoinCode } from '../access/codes.js';
import type { Clock, RandomSource } from '../clock.js';
import { uuidFrom } from '../clock.js';
import { computeWeek, type EngineState } from '../domain/engine.js';
import { KIT_PRESET, judgeSetupKind, type KitPreset } from '../domain/kit-preset.js';
import {
  FIXED_DELAY_WEEKS,
  ROLES,
  type Decisions,
  type EndReason,
  type Role,
} from '../domain/types.js';
import {
  AppError,
  CodeCollisionError,
  VersionConflictError,
  conflictError,
  forbiddenError,
  internalError,
  notFoundError,
  stateError,
  validationError,
} from '../errors.js';
import {
  DEFAULTS,
  parseCreateGame,
  parseDecision,
  parseJoin,
  parseReplacement,
  parseRoleAssignment,
  requireIdempotencyKey,
} from './schemas.js';
import {
  buildLogEntry,
  participantLabel,
  toHistoryView,
  type ActorKind,
  type HistoryView,
  type LogDetail,
  type LogKind,
  type NewLogEntry,
} from './history.js';
import type { GameStateView, ObserverView } from './projection.js';
import type {
  ConfirmedRecord,
  GameRow,
  GameTx,
  IdempotencyRow,
  Snapshot,
  Store,
  WeekRecordRow,
} from './store.js';
import { engineStateAtWeekStart, initialEngineState, slotRowsOf } from './week-state.js';

export interface GameSessionDeps {
  store: Store;
  access: AccessControl;
  clock: Clock;
  random: RandomSource;
  /**
   * キット準拠の判定の基準（BR6.3）。既定は実際の KIT_PRESET（需要系列は未提供）。
   * 試験が仮の系列を含むプリセットで判定を確かめるための差し込み口で、作成の API の入力ではない。
   */
  kitPreset?: KitPreset;
}

export interface CreatedGame {
  gameId: string;
  name: string;
  status: GameRow['status'];
  weekCount: number;
  currentWeek: number;
  setupKind: GameRow['setupKind'];
  /** コードの平文は、この応答でだけ返す */
  codes: { joinCode: string; facilitatorCode: string; observerCode: string };
}

export interface JoinResult {
  gameId: string;
  participantId: string;
  displayName: string;
  joinOrder: number;
  /** 参加者を特定する token。この応答でだけ平文を返す */
  token: string;
}

/** 入れ替えの結果。token の平文は、この応答でだけ返す（NFR6.2）。 */
export interface ReplacementResult {
  gameId: string;
  role: Role;
  participantId: string;
  displayName: string;
  joinOrder: number;
  label: string;
  replacedParticipantId: string;
  token: string;
}

export interface DecisionResult {
  week: number;
  role: Role;
  quantity: number;
  version: number;
}

export interface WeekResultRow {
  role: Role;
  decision: number;
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  weeklyCost: number;
  cumulativeCost: number;
}

export interface WeekResult {
  week: number;
  results: WeekResultRow[];
  teamCost: number;
  status: GameRow['status'];
  currentWeek: number;
  version: number;
}

/** 自動終了の再検査の結果（BR25.4）。 */
export type AutoEndResult = 'ended' | 'not-stale' | 'already-ended' | 'not-found';

/** 削除の再検査の結果（BR24.5）。 */
export type DeleteResult = 'deleted' | 'not-expired' | 'not-found';

const isNotFound = (error: unknown): boolean =>
  error instanceof AppError && error.problem.kind === 'not_found';

const CODE_ISSUE_ATTEMPTS = 5;

const digestOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * GameSession: ゲームの集約の操作（C3）。
 * 週次進行と永続状態を所有し、副作用のない計算は SimulationEngine に任せる（ADR-006）。
 * 書き込みはゲームの行を占有して（ゲーム単位の直列処理）、1 回の保存で行う。
 *
 * 判定の順（BR4.8）: 認可 → 再送の照合 → 状態の検査 → 入力の検証。
 */
export class GameSession {
  private readonly store: Store;
  private readonly access: AccessControl;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly kitPreset: KitPreset;

  constructor(deps: GameSessionDeps) {
    this.store = deps.store;
    this.access = deps.access;
    this.clock = deps.clock;
    this.random = deps.random;
    this.kitPreset = deps.kitPreset ?? KIT_PRESET;
  }

  private id(): string {
    return uuidFrom(this.random);
  }

  /** 履歴の 1 件を作る。detail は kind ごとの厳密な型で検証する（NFR7.1）。 */
  private logEntry<K extends LogKind>(
    kind: K,
    actorKind: ActorKind,
    detail: LogDetail<K>,
    options: { week?: number | null; role?: Role | null } = {},
  ): NewLogEntry {
    return buildLogEntry({
      entryId: this.id(),
      kind,
      actorKind,
      occurredAt: this.clock.now(),
      week: options.week ?? null,
      role: options.role ?? null,
      detail,
    });
  }

  /** 保存の例外を、利用者へ返す形にする。AppError はそのまま、版の食い違いは conflict、他は internal。 */
  private translate(error: unknown): AppError {
    if (error instanceof AppError) {
      return error;
    }
    if (error instanceof VersionConflictError) {
      return conflictError(
        'ほかの操作と重なりました',
        '状態を取り直して、もう一度操作してください',
      );
    }
    return internalError();
  }

  /**
   * ゲームの行を占有して書き込む唯一の入口。状態を変える書き込みがあったときだけ、コミットの前に
   * 同じ保存の中で最後の操作の時刻を 1 回更新する（BR25.2、NFR2.5）。
   * 再送（前回と同じ結果を返すだけ）や拒否（例外）では書き込みが起きないため、更新されない。
   */
  private async write<T>(gameId: string, fn: (tx: GameTx) => Promise<T>): Promise<T> {
    try {
      return await this.store.transact(gameId, async (tx) => {
        const result = await fn(tx);
        if (tx.mutated) {
          await tx.touchOperation(this.clock.now());
        }
        return result;
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** ゲームを作る（BR1.1〜BR1.8）。ゲームと 3 種類のコードを、1 回の保存で作る。 */
  async createGame(body: unknown): Promise<CreatedGame> {
    const input = parseCreateGame(body);
    const now = this.clock.now();
    const demand =
      input.demandSeries ?? Array.from({ length: input.weekCount }, (_, i) => (i < 4 ? 4 : 8));
    const isProvisionalDefault = input.demandSeries === undefined;
    const settingsValues = {
      initialInventory: input.initialInventory ?? DEFAULTS.initialInventory,
      initialPipelineQuantity: input.initialPipelineQuantity ?? DEFAULTS.initialPipelineQuantity,
      inventoryUnitCost: input.inventoryUnitCost ?? DEFAULTS.inventoryUnitCost,
      backlogUnitCost: input.backlogUnitCost ?? DEFAULTS.backlogUnitCost,
    };
    // 種別は作成のときに決まり、以後は変わらない（BR6.1〜BR6.4）。
    // 需要系列を指定しなかったゲームは、仮の既定が入るので、他の値が同じでも「カスタム」。
    const setupKind = isProvisionalDefault
      ? 'custom'
      : judgeSetupKind(
          {
            weekCount: input.weekCount,
            ...settingsValues,
            delayWeeks: FIXED_DELAY_WEEKS,
            demandSeries: demand,
          },
          this.kitPreset,
        );

    for (let attempt = 0; attempt < CODE_ISSUE_ATTEMPTS; attempt += 1) {
      const gameId = this.id();
      const codes = this.access.issueGameCodes(gameId, now, () => this.id());
      try {
        await this.store.createGame({
          game: {
            gameId,
            name: input.name,
            status: 'preparing',
            weekCount: input.weekCount,
            currentWeek: 1,
            setupKind,
            version: 0,
            createdAt: now,
            // 作成時の最後の操作の時刻は、作成の時刻と同じ（BR25.2）
            lastOperationAt: now,
            endedAt: null,
            endReason: null,
            nextLogSequence: 1,
          },
          settings: {
            settingsId: this.id(),
            gameId,
            weekCount: input.weekCount,
            ...settingsValues,
            visibilityScope: 'team_totals',
            demandSeries: demand,
            isProvisionalDefault,
          },
          codes: codes.rows,
          // 作成時の設定を、最初の履歴にする（BR13.4）。需要系列の値そのものは持たない
          logs: [
            this.logEntry('setting', 'facilitator', {
              weekCount: input.weekCount,
              ...settingsValues,
              setupKind,
              demandSeriesLength: demand.length,
              demandSeriesIsProvisional: isProvisionalDefault,
            }),
          ],
        });
        return {
          gameId,
          name: input.name,
          status: 'preparing',
          weekCount: input.weekCount,
          currentWeek: 1,
          setupKind,
          codes: codes.plain,
        };
      } catch (error) {
        // 照合用の値が重なったときは、コードを発行し直す
        if (error instanceof CodeCollisionError) {
          continue;
        }
        throw this.translate(error);
      }
    }
    throw internalError('コードを発行できませんでした', 'もう一度操作してください');
  }

  /** 参加する（BR2.1〜BR2.6）。コード → 状態 → 表示名 の順に判定する。 */
  async joinGame(body: unknown, verifiedGameId?: string): Promise<JoinResult> {
    const rawCode =
      typeof body === 'object' && body !== null
        ? (body as { joinCode?: unknown }).joinCode
        : undefined;
    // 入力の形（欠け）の検査は先に行う。コードの有効性の検査はそのあと
    if (typeof rawCode !== 'string' || rawCode.length === 0) {
      parseJoin(body);
    }
    // 入口が参加の窓（BR18）の中でコードを検証済みなら、そのゲームを使う。直接呼ぶときは、ここで検証する
    const gameId =
      verifiedGameId ?? (await this.access.resolveJoinCode(normalizeJoinCode(String(rawCode))));
    if (!gameId) {
      throw forbiddenError(
        '参加コードが無効です',
        '参加コードを確かめて、もう一度入力してください',
      );
    }
    // 表示名の形式の検証（先頭が式になる文字を含む）は、副作用がないので占有の前に行う（BR23.10、NFR6.8）
    const input = parseJoin(body);
    return this.write(gameId, async (tx) => {
      const game = tx.game();
      if (game.status === 'ended') {
        throw stateError(
          'このゲームは終了済みです',
          '新しいゲームの参加コードを進行役に確かめてください',
        );
      }
      if (game.status === 'running' || game.status === 'paused') {
        throw stateError(
          'ゲームは進行中のため参加できない状態です',
          '次のゲームの開始前に参加してください',
        );
      }
      const participants = await tx.participants();
      const joinOrder = participants.reduce((max, p) => Math.max(max, p.joinOrder), 0) + 1;
      const participantId = this.id();
      const token = this.access.issueToken();
      const now = this.clock.now();
      await tx.addParticipant(
        {
          participantId,
          gameId,
          displayName: input.displayName,
          joinOrder,
          joinedAt: now,
          replacedAt: null,
          createdByFacilitator: false,
        },
        token.hash,
        now,
      );
      // 参加は 7 種類の履歴に含めない（BR11.3、functional-spec 前提）
      await tx.updateGame({}, game.version, []);
      return {
        gameId,
        participantId,
        displayName: input.displayName,
        joinOrder,
        token: token.plain,
      };
    });
  }

  /** 役割を割り当てる、または未割当てに戻す（BR3.2）。準備中だけ。進行役だけ。 */
  async assignRole(
    principal: Principal | null,
    gameId: string,
    participantId: string,
    roleInput: unknown,
  ): Promise<void> {
    this.access.requireFacilitator(principal, gameId);
    const role = parseRoleAssignment({ role: roleInput });
    await this.write(gameId, async (tx) => {
      const game = tx.game();
      // BR10.1: 進行中と一時停止中は、どんな要求でも拒否する。入れ替えは replacement を使う
      if (game.status === 'running' || game.status === 'paused') {
        throw stateError(
          '進行中は役割の割当てを変更できません',
          '担当者の入れ替えには、役割ごとの入れ替え（replacement）を使ってください',
        );
      }
      if (game.status !== 'preparing') {
        throw stateError(
          'ゲームは終了済みのため役割を割り当てられません',
          '状態を取り直してください',
        );
      }
      const participants = await tx.participants();
      const participant = participants.find((p) => p.participantId === participantId);
      if (!participant) {
        throw notFoundError('参加者が見つかりません');
      }
      const assignments = await tx.assignments();
      if (role !== null) {
        const inRole = assignments.filter(
          (a) => a.role === role && a.participantId !== participantId,
        );
        if (inRole.length >= 4) {
          throw stateError('1 つの役割に就けるのは 4 人までです', '別の役割に割り当ててください');
        }
      }
      const previous = assignments.find((a) => a.participantId === participantId)?.role ?? null;
      await tx.setAssignment(participantId, role, this.id());
      // 役割変更の履歴（BR13.3）。何も変わらない要求は、履歴に足さない
      const logs: NewLogEntry[] = [];
      if (previous !== role) {
        const change = role === null ? 'unassign' : previous === null ? 'assign' : 'reassign';
        logs.push(
          this.logEntry(
            'roleChange',
            'facilitator',
            {
              change,
              participantId,
              participantLabel: participantLabel(participant),
              ...(previous !== null ? { fromRole: previous } : {}),
              toRole: role,
              gameStatus: game.status,
            },
            { role: role ?? previous },
          ),
        );
      }
      await tx.updateGame({}, game.version, logs);
    });
  }

  /** ゲームを開始する（BR3.1、BR3.3）。4 役割に 1 人以上が就いていなければ拒否する。 */
  async startGame(principal: Principal | null, gameId: string): Promise<GameStateView> {
    const facilitator = this.access.requireFacilitator(principal, gameId);
    return this.write(gameId, async (tx) => {
      const game = tx.game();
      if (game.status !== 'preparing') {
        throw stateError('このゲームはすでに開始されています', '状態を取り直してください');
      }
      const assignments = await tx.assignments();
      const assigned = new Set(assignments.map((a) => a.role));
      const missing = ROLES.filter((role) => !assigned.has(role));
      if (missing.length > 0) {
        throw stateError(
          '役割が足りないため開始できません',
          '未割当ての役割に参加者を割り当ててください',
          missing,
        );
      }
      const settings = await tx.settings();
      await tx.replaceSlots(slotRowsOf(initialEngineState(settings)));
      await tx.insertWeekRecords(this.newWeekRecords(gameId, 1));
      await tx.updateGame({ status: 'running', currentWeek: 1 }, game.version, []);
      return this.access.project(await tx.snapshot(), facilitator);
    });
  }

  /**
   * 発注数（工場は生産要請数）を入力する（BR4.1〜BR4.8、BR11、BR12）。
   * 進行役用コードで呼ぶと代理入力になる（担当者の有無によらず、どの役割にもできる）。
   * 判定の順: 認可 → 占有 → 入力者の再検査 → 再送の照合 → 状態の検査 → 入力の検証。
   */
  async submitDecision(
    principal: Principal | null,
    gameId: string,
    week: number,
    role: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<DecisionResult> {
    // 1. 認可
    const roleValue = ROLES.find((r) => r === role);
    if (!roleValue) {
      // 存在しない役割の指定も、権限のない操作と同じ形で拒否する
      throw forbiddenError(
        '自分の役割以外の操作はできません',
        '自分の役割の画面から操作してください',
      );
    }
    const actor = this.access.requireDecisionActor(principal, gameId, roleValue);
    const key = requireIdempotencyKey(idempotencyKey);
    const digest = digestOf({ operation: 'submitDecision', week, role: roleValue, body });
    const requesterId = actor.kind === 'facilitator' ? 'facilitator' : actor.participantId;

    return this.write(gameId, async (tx) => {
      // 2. 入口の認可のあとに入れ替えがコミットされた競合を防ぐ（NFR6.3）。
      //    占有の中で、入力者が今もその役割に就いていて、token が失効していないことを再検査する。
      //    認可が先なので、失効した旧担当者は、前に成功した識別子の再送でも前回の結果を受け取れない
      if (actor.kind === 'participant') {
        await this.recheckParticipant(tx, actor.participantId, roleValue);
      }
      // 3. 再送の照合
      const replay = await this.findReplay(tx, 'submitDecision', requesterId, key, digest);
      if (replay) {
        return replay as DecisionResult;
      }
      // 4. 状態の検査（BR4.5、BR9.3、BR9.5）
      const game = tx.game();
      if (game.status !== 'running' || week !== game.currentWeek) {
        throw stateError(
          game.status === 'running'
            ? `第 ${week} 週は入力できません（当週は第 ${game.currentWeek} 週です）`
            : game.status === 'paused'
              ? 'ゲームは一時停止中のため入力できません'
              : game.status === 'ended'
                ? 'ゲームは終了済みのため入力できません'
                : 'ゲームが進行中でないため入力できません',
          game.status === 'paused'
            ? '進行役が再開するまで待ってください。保存済みの入力は残っています'
            : '画面を更新して、当週の入力欄から入力してください',
        );
      }
      // 5. 入力の検証（BR4.2）
      const { quantity } = parseDecision(body);
      await tx.setDecision(
        week,
        roleValue,
        quantity,
        actor.kind === 'facilitator'
          ? { kind: 'facilitator', participantId: null }
          : { kind: 'participant', participantId: actor.participantId },
        this.clock.now(),
      );
      // 代理入力のたびに履歴を残す。参加者の通常の入力は履歴に含めない（BR11.3）
      const logs =
        actor.kind === 'facilitator'
          ? [
              this.logEntry(
                'proxyInput',
                'facilitator',
                { value: quantity },
                { week, role: roleValue },
              ),
            ]
          : [];
      const updated = await tx.updateGame({}, game.version, logs);
      const result: DecisionResult = { week, role: roleValue, quantity, version: updated.version };
      await this.saveReplay(tx, gameId, 'submitDecision', requesterId, key, digest, result);
      return result;
    });
  }

  /** 入力者が今もその役割の担当者で、復帰用 token が有効であることを、占有の中で確かめる（NFR6.3）。 */
  private async recheckParticipant(tx: GameTx, participantId: string, role: Role): Promise<void> {
    const assigned = (await tx.assignments()).some(
      (a) => a.participantId === participantId && a.role === role,
    );
    if (!assigned || !(await tx.hasActiveToken(participantId))) {
      throw forbiddenError(
        '自分の役割以外の操作はできません',
        '担当者が入れ替わった可能性があります。進行役に確かめてください',
      );
    }
  }

  /** 週を確定する（BR5.1〜BR5.11）。結果、枠の前進、週の進行を、1 回の保存で行う。 */
  async confirmWeek(
    principal: Principal | null,
    gameId: string,
    week: number,
    idempotencyKey: string | undefined,
  ): Promise<WeekResult> {
    this.access.requireFacilitator(principal, gameId);
    const key = requireIdempotencyKey(idempotencyKey);
    const digest = digestOf({ operation: 'confirmWeek', week });

    return this.write(gameId, async (tx) => {
      const replay = await this.findReplay(tx, 'confirmWeek', 'facilitator', key, digest);
      if (replay) {
        return replay as WeekResult;
      }
      const game = tx.game();
      // BR7.1: 前回の結果を返すのは、同じ識別子の再送（上の照合）だけ。
      // 識別子が違う確定は、最終週の確定済み（終了）も含めて、確定済みの週への確定として拒否する。
      if (game.status === 'ended') {
        throw stateError(
          week >= 1 && week <= game.weekCount
            ? `第 ${week} 週はすでに確定済みです`
            : 'ゲームは終了済みのため週を確定できません',
          '画面を更新して、状態を確かめてください',
        );
      }
      const settings = await tx.settings();
      // BR5.11、BR9.3
      if (game.status === 'paused') {
        throw stateError(
          'ゲームは一時停止中のため週を確定できません',
          '進行役が再開してから確定してください',
        );
      }
      if (game.status !== 'running') {
        throw stateError('ゲームが進行中でないため週を確定できません', '状態を取り直してください');
      }
      if (week !== game.currentWeek) {
        throw stateError(
          week < game.currentWeek
            ? `第 ${week} 週はすでに確定済みです`
            : `第 ${week} 週はまだ確定できません（当週は第 ${game.currentWeek} 週です）`,
          '画面を更新して、当週を確定してください',
        );
      }
      // BR5.1
      const records = await tx.weekRecords();
      const current = records.filter((r) => r.week === week);
      const missing = ROLES.filter(
        (role) => (current.find((r) => r.role === role)?.decision ?? null) === null,
      );
      if (missing.length > 0) {
        throw stateError(
          '4 役割の入力がそろっていないため確定できません',
          '未入力の役割の入力を待ってください',
          missing,
        );
      }
      // 計算（副作用なし）
      const slots = await tx.slots();
      const state: EngineState = engineStateAtWeekStart(settings, week, records, slots);
      const decisions = Object.fromEntries(
        ROLES.map((role) => [role, current.find((r) => r.role === role)!.decision!]),
      ) as Decisions;
      const output = computeWeek({
        settings: settings,
        state,
        customerDemand: settings.demandSeries[week - 1] ?? 0,
        decisions,
      });
      const confirmed: ConfirmedRecord[] = ROLES.map((role) => ({ role, ...output.perRole[role] }));
      await tx.confirmRecords(week, confirmed);
      await tx.replaceSlots(slotRowsOf(output.state));
      const logs: NewLogEntry[] = [this.logEntry('weekConfirm', 'facilitator', { week }, { week })];
      let updated: GameRow;
      if (week === game.weekCount) {
        // BR5.10、BR9.7: 最終週の確定でゲームを終了にする。currentWeek は weekCount のまま。
        // 履歴は weekConfirm に続けて end（system）を、同じ保存の中で残す
        logs.push(this.logEntry('end', 'system', { reason: 'finalWeek', week }, { week }));
        updated = await tx.updateGame(
          { status: 'ended', endedAt: this.clock.now(), endReason: 'finalWeek' },
          game.version,
          logs,
        );
      } else {
        await tx.insertWeekRecords(this.newWeekRecords(gameId, week + 1));
        updated = await tx.updateGame({ currentWeek: week + 1 }, game.version, logs);
      }
      const result: WeekResult = {
        week,
        results: ROLES.map((role) => ({
          role,
          decision: decisions[role],
          ...output.perRole[role],
        })),
        teamCost: output.teamCost,
        status: updated.status,
        currentWeek: updated.currentWeek,
        version: updated.version,
      };
      await this.saveReplay(tx, gameId, 'confirmWeek', 'facilitator', key, digest, result);
      return result;
    });
  }

  /** 一時停止する（BR9.1）。進行中だけ。currentWeek と入力済みの値は変えない。 */
  async pauseGame(principal: Principal | null, gameId: string): Promise<GameStateView> {
    const facilitator = this.access.requireFacilitator(principal, gameId);
    return this.write(gameId, async (tx) => {
      const game = tx.game();
      if (game.status !== 'running') {
        throw stateError(
          game.status === 'paused'
            ? 'すでに一時停止中です'
            : game.status === 'ended'
              ? 'ゲームは終了済みのため一時停止できません'
              : 'ゲームが進行中でないため一時停止できません',
          '状態を取り直してください',
        );
      }
      await tx.updateGame({ status: 'paused' }, game.version, [
        this.logEntry(
          'pause',
          'facilitator',
          { week: game.currentWeek },
          { week: game.currentWeek },
        ),
      ]);
      return this.access.project(await tx.snapshot(), facilitator);
    });
  }

  /** 再開する（BR9.2）。一時停止中だけ。currentWeek と一時停止前の入力は保たれる。 */
  async resumeGame(principal: Principal | null, gameId: string): Promise<GameStateView> {
    const facilitator = this.access.requireFacilitator(principal, gameId);
    return this.write(gameId, async (tx) => {
      const game = tx.game();
      if (game.status !== 'paused') {
        throw stateError(
          game.status === 'ended'
            ? 'ゲームは終了済みのため再開できません'
            : '一時停止中ではないため再開できません',
          '状態を取り直してください',
        );
      }
      await tx.updateGame({ status: 'running' }, game.version, [
        this.logEntry(
          'resume',
          'facilitator',
          { week: game.currentWeek },
          { week: game.currentWeek },
        ),
      ]);
      return this.access.project(await tx.snapshot(), facilitator);
    });
  }

  /**
   * 進行役がゲームを終了する（BR9.4、BR9.6）。終了の理由は facilitator に固定し、外部から指定させない。
   * 準備中は終了できない。終了済みは、何も変えず現在の状態を返す（冪等）。
   */
  async endGame(principal: Principal | null, gameId: string): Promise<GameStateView> {
    const facilitator = this.access.requireFacilitator(principal, gameId);
    return this.write(gameId, async (tx) => {
      const game = tx.game();
      if (game.status === 'ended') {
        return this.access.project(await tx.snapshot(), facilitator);
      }
      if (game.status === 'preparing') {
        throw stateError(
          '準備中のゲームは終了できません',
          '開始してから終了してください。使わないゲームは自動で終了します',
        );
      }
      await this.finish(tx, game, 'facilitator', 'facilitator');
      return this.access.project(await tx.snapshot(), facilitator);
    });
  }

  /**
   * 放置されたゲームの自動終了（BR9.4、BR9.8、BR25.3、BR25.4）。U5 の定期処理が内部から呼ぶ。HTTP の入口は持たない。
   * 準備中からも終了できる唯一の経路。ゲームの行を占有した中で、期限（最後の操作が staleBefore 以前）を再検査する。
   * - ended: 終了した
   * - not-stale: 選んだあとに操作があり、期限を過ぎていなくなった（終了しない）
   * - already-ended: すでに終了していた（何もしない。冪等）
   * - not-found: ほかの処理が先に削除した（何もしない）
   */
  async autoEnd(gameId: string, staleBefore: Date): Promise<AutoEndResult> {
    try {
      return await this.write(gameId, async (tx): Promise<AutoEndResult> => {
        const game = tx.game();
        if (game.status === 'ended') {
          return 'already-ended';
        }
        if (game.lastOperationAt.getTime() > staleBefore.getTime()) {
          return 'not-stale';
        }
        await this.finish(tx, game, 'autoEnd', 'system');
        return 'ended';
      });
    } catch (error) {
      if (isNotFound(error)) {
        return 'not-found';
      }
      throw error;
    }
  }

  /**
   * 保持期間を過ぎたゲームの削除（BR24.3、BR24.5）。U5 の定期処理が内部から呼ぶ。HTTP の入口は持たない。
   * ゲームの行を占有した中で、終了済みで終了が expiredBefore 以前であることを再検査し、紐づくすべてのデータを
   * 1 回の保存で削除する。途中で失敗したらすべて元に戻る（例外を返す）。
   * - deleted: 削除した
   * - not-expired: 終了していない、または期限を過ぎていなくなった（削除しない）
   * - not-found: すでに削除されている（何もしない。冪等）
   */
  async deleteIfExpired(gameId: string, expiredBefore: Date): Promise<DeleteResult> {
    try {
      return await this.write(gameId, async (tx): Promise<DeleteResult> => {
        const game = tx.game();
        if (
          game.status !== 'ended' ||
          game.endedAt === null ||
          game.endedAt.getTime() > expiredBefore.getTime()
        ) {
          return 'not-expired';
        }
        await tx.deleteGame();
        return 'deleted';
      });
    } catch (error) {
      if (isNotFound(error)) {
        return 'not-found';
      }
      throw error;
    }
  }

  private async finish(
    tx: GameTx,
    game: GameRow,
    reason: EndReason,
    actorKind: ActorKind,
  ): Promise<void> {
    // currentWeek は終了した時点の週のまま。確定前の入力は、確定せずに残す（BR9.4）
    await tx.updateGame(
      { status: 'ended', endedAt: this.clock.now(), endReason: reason },
      game.version,
      [
        this.logEntry(
          'end',
          actorKind,
          { reason, week: game.currentWeek },
          { week: game.currentWeek },
        ),
      ],
    );
  }

  /**
   * 担当者を入れ替える（BR10.1〜BR10.6）。進行中と一時停止中だけ。
   * 旧担当者の割当てと token を同じコミットで失効させ、新しい参加者と token を作る。
   * 識別子を使わない。再送は、旧担当者が交代済みであること（conflict）で守る。
   */
  async replaceAssignee(
    principal: Principal | null,
    gameId: string,
    roleInput: string,
    body: unknown,
  ): Promise<ReplacementResult> {
    this.access.requireFacilitator(principal, gameId);
    const role = ROLES.find((r) => r === roleInput);
    if (!role) {
      throw validationError(
        '役割の指定に誤りがあります',
        '工場・一次卸・二次卸・小売店のいずれかを指定してください',
        [{ path: 'role', message: '役割を指定してください' }],
      );
    }
    const input = parseReplacement(body);
    return this.write(gameId, async (tx) => {
      const game = tx.game();
      if (game.status !== 'running' && game.status !== 'paused') {
        throw stateError(
          game.status === 'ended'
            ? 'ゲームは終了済みのため担当者を入れ替えられません'
            : '準備中は担当者の入れ替えではなく、役割の割当てを使ってください',
          '状態を取り直してください',
        );
      }
      const participants = await tx.participants();
      const assignments = await tx.assignments();
      const old = participants.find((p) => p.participantId === input.participantId);
      const oldAssigned = assignments.some(
        (a) => a.participantId === input.participantId && a.role === role,
      );
      if (!old || old.replacedAt !== null || !oldAssigned) {
        throw conflictError(
          '指定の担当者は、この役割の担当者ではないか、すでに入れ替え済みです',
          '進行管理の担当者一覧を取り直して、いまの担当者を指定してください',
        );
      }
      const joinOrder = participants.reduce((max, p) => Math.max(max, p.joinOrder), 0) + 1;
      const participantId = this.id();
      const token = this.access.issueToken();
      const now = this.clock.now();
      const created = {
        participantId,
        gameId,
        displayName: input.displayName,
        joinOrder,
        joinedAt: now,
        replacedAt: null,
        createdByFacilitator: true,
      };
      await tx.addParticipant(created, token.hash, now);
      await tx.setAssignment(old.participantId, null, this.id());
      await tx.setAssignment(participantId, role, this.id());
      await tx.replaceParticipant(old.participantId, now);
      const label = participantLabel(created);
      await tx.updateGame({}, game.version, [
        this.logEntry(
          'roleChange',
          'facilitator',
          {
            change: 'replace',
            participantId,
            participantLabel: label,
            toRole: role,
            replacedParticipantId: old.participantId,
            replacedParticipantLabel: participantLabel(old),
            gameStatus: game.status,
          },
          { role },
        ),
      ]);
      return {
        gameId,
        role,
        participantId,
        displayName: input.displayName,
        joinOrder,
        label,
        replacedParticipantId: old.participantId,
        token: token.plain,
      };
    });
  }

  /** 操作の履歴を sequence の昇順で返す。進行役だけ（BR13.5）。 */
  async getHistory(principal: Principal | null, gameId: string): Promise<HistoryView> {
    this.access.requireFacilitator(principal, gameId);
    try {
      return toHistoryView(await this.store.readHistory(gameId));
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** 呼び出した人ごとの投影を返す。行を占有しない読み取り（NFR4.4）。 */
  getState(
    principal: ParticipantPrincipal | FacilitatorPrincipal | null,
    gameId: string,
  ): Promise<GameStateView>;
  getState(principal: Principal | null, gameId: string): Promise<GameStateView | ObserverView>;
  async getState(
    principal: Principal | null,
    gameId: string,
  ): Promise<GameStateView | ObserverView> {
    const viewer = this.access.requireViewer(principal, gameId);
    let snapshot: Snapshot | null;
    try {
      snapshot = await this.store.readSnapshot(gameId);
    } catch (error) {
      throw this.translate(error);
    }
    if (!snapshot) {
      throw forbiddenError(
        'このゲームの状況を見る権限がありません',
        '参加したときのコードで入り直してください',
      );
    }
    if (
      viewer.kind === 'participant' &&
      !snapshot.participants.some((p) => p.participantId === viewer.participantId)
    ) {
      throw forbiddenError(
        'このゲームの状況を見る権限がありません',
        '参加したときのコードで入り直してください',
      );
    }
    return this.access.project(snapshot, viewer);
  }

  /** 参加コードと観察者用コードを再表示する（進行役）。進行役用コードは再表示しない。 */
  async getCodes(
    principal: Principal | null,
    gameId: string,
  ): Promise<{ joinCode: string; observerCode: string }> {
    this.access.requireFacilitator(principal, gameId);
    return {
      joinCode: await this.access.reveal(gameId, 'join'),
      observerCode: await this.access.reveal(gameId, 'observer'),
    };
  }

  private newWeekRecords(gameId: string, week: number): WeekRecordRow[] {
    return ROLES.map((role) => ({
      weekRecordId: this.id(),
      gameId,
      week,
      role,
      decision: null,
      receipt: null,
      ordersReceived: null,
      shipped: null,
      inventory: null,
      backlog: null,
      weeklyCost: null,
      cumulativeCost: null,
      isConfirmed: false,
      decidedByKind: null,
      decidedByParticipantId: null,
      decidedAt: null,
      decisionRevision: 0,
    }));
  }

  /** 再送の照合（BR4.7）。同じ組で内容が違えば conflict。 */
  private async findReplay(
    tx: GameTx,
    operation: IdempotencyRow['operation'],
    requesterId: string,
    key: string,
    digest: string,
  ): Promise<unknown | null> {
    const record = await tx.findIdempotency(operation, requesterId, key);
    if (!record) {
      return null;
    }
    if (record.requestDigest !== digest) {
      throw conflictError(
        '同じ識別子で内容の違う要求が届きました',
        '新しい Idempotency-Key を付けて、もう一度操作してください',
      );
    }
    return record.responseBody;
  }

  private async saveReplay(
    tx: GameTx,
    gameId: string,
    operation: IdempotencyRow['operation'],
    requesterId: string,
    key: string,
    digest: string,
    responseBody: unknown,
  ): Promise<void> {
    await tx.saveIdempotency({
      recordId: this.id(),
      gameId,
      key,
      operation,
      requesterId,
      requestDigest: digest,
      responseBody,
      createdAt: this.clock.now(),
    });
  }
}
