import { displayNameFor, type SeededPlan } from '../shared/rng.js';
import { ROLES, ROLE_LABELS, type Role } from '../shared/roles.js';
import { Secret } from '../shared/secret.js';
import { MISSING_REFLECTION_SAMPLE_MS } from '../shared/stats.js';
import { call, isSuccess } from './http.js';
import type { PhaseName, Recorder } from './recorder.js';
import { ReflectionMeter } from './render-latency.js';
import { VirtualClient, type StateObservation } from './virtual-client.js';

/** 反映の観察を待つ上限（ミリ秒）。これを過ぎても現れない画面は、標本の値 10 秒の「未反映」とする。 */
const REFLECTION_WAIT_MS = MISSING_REFLECTION_SAMPLE_MS;
/** 追加の画面（同じ役割の担当者）は、役割あたり 4 人まで（主の 1 人 + 追加の 3 人）。 */
const EXTRA_PER_ROLE = 3;

export interface TeamDriverOptions {
  team: number;
  baseUrl: string;
  plan: SeededPlan;
  recorder: Recorder;
  weekCount: number;
  pollIntervalMs: number;
  /** チームあたりの追加の取り直し専用の画面の数（0 または 13） */
  extraScreens: number;
  /** 実ブラウザで見せるチームか。true なら、通常の 5 画面は仮想の取り直しをしない */
  browserTeam: boolean;
  /** 週の確定の応答を受け取ったときに呼ぶ（実ブラウザの反映の始点） */
  onWeekConfirmed?: (newWeek: number, atMs: number) => void;
}

interface Player {
  role: Role;
  participantId: string;
  token: Secret;
}

interface JoinedExtra {
  token: Secret;
}

/**
 * 1 チーム（4 役割 + 進行役 + 観察者 + 追加の担当者）の動作。公開の API だけを使う。
 * 準備（作成、参加、割当て、開始）、入力と週の確定、仮想の利用者の取り直しの開始と停止を持つ。
 */
export class TeamDriver {
  gameId = '';
  private facilitator = new Secret('');
  private observer = new Secret('');
  private players: Player[] = [];
  private extras: JoinedExtra[] = [];
  private normalClients: VirtualClient[] = [];
  private extraClients: VirtualClient[] = [];
  private currentWeek = 1;
  private readonly reflection = new ReflectionMeter({ screens: 4, missingMs: REFLECTION_WAIT_MS });
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly flushing = new Map<number, PhaseName>();
  private readonly secretsOut: Secret[] = [];
  private cyclesStopped = false;
  private failed = false;

  constructor(private readonly options: TeamDriverOptions) {}

  /** このチームの生成した資格情報（要約に出ていないことの確認に使う）。 */
  secrets(): Secret[] {
    return [...this.secretsOut];
  }

  get facilitatorCode(): Secret {
    return this.facilitator;
  }

  get playerTokens(): Secret[] {
    return this.players.map((p) => p.token);
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  /** 反映の標本が、まだ記録されていない週の数。 */
  get pendingReflections(): number {
    return this.flushing.size;
  }

  /** ゲームを作成し、4 役割と追加の担当者と観察者を入れて、開始する。 */
  async setup(): Promise<void> {
    const { baseUrl, team, weekCount, extraScreens } = this.options;
    const created = await call(baseUrl, 'POST', '/api/games', {
      body: { name: displayNameFor(team, 'ゲーム'), weekCount },
    });
    const body = created.json as
      | {
          gameId?: string;
          codes?: { joinCode?: string; facilitatorCode?: string; observerCode?: string };
        }
      | undefined;
    if (!isSuccess(created.outcome) || !body?.gameId || !body.codes) {
      throw new Error('ゲームの作成に失敗しました');
    }
    this.gameId = body.gameId;
    const joinCode = new Secret(body.codes.joinCode ?? '');
    this.facilitator = new Secret(body.codes.facilitatorCode ?? '');
    this.observer = new Secret(body.codes.observerCode ?? '');
    this.secretsOut.push(joinCode, this.facilitator, this.observer);

    const join = async (label: string): Promise<{ participantId: string; token: Secret }> => {
      const result = await call(baseUrl, 'POST', '/api/games/join', {
        body: { joinCode: joinCode.reveal(), displayName: displayNameFor(team, label) },
      });
      const joined = result.json as { participantId?: string; token?: string } | undefined;
      if (!isSuccess(result.outcome) || !joined?.participantId || !joined.token) {
        throw new Error('参加に失敗しました');
      }
      const token = new Secret(joined.token);
      this.secretsOut.push(token);
      return { participantId: joined.participantId, token };
    };
    const assign = async (participantId: string, role: Role): Promise<void> => {
      const result = await call(
        baseUrl,
        'PUT',
        `/api/games/${this.gameId}/assignments/${participantId}`,
        {
          token: this.facilitator,
          body: { role },
        },
      );
      if (!isSuccess(result.outcome)) {
        throw new Error('役割の割当てに失敗しました');
      }
    };

    for (const role of ROLES) {
      const joined = await join(ROLE_LABELS[role]);
      await assign(joined.participantId, role);
      this.players.push({ role, ...joined });
    }
    // 最大想定の区間で使う追加の担当者を、準備中（公開の参加手順）のうちに入れておく
    const extraRoles = Math.min(extraScreens, ROLES.length * EXTRA_PER_ROLE);
    for (let index = 0; index < extraRoles; index += 1) {
      const role = ROLES[index % ROLES.length] as Role;
      const joined = await join(`追加 ${String(index + 1).padStart(2, '0')}`);
      await assign(joined.participantId, role);
      this.extras.push({ token: joined.token });
    }
    const start = await call(baseUrl, 'POST', `/api/games/${this.gameId}/start`, {
      token: this.facilitator,
    });
    if (!isSuccess(start.outcome)) {
      throw new Error('ゲームの開始に失敗しました');
    }
  }

  private newClient(token: Secret): VirtualClient {
    return new VirtualClient({
      baseUrl: this.options.baseUrl,
      gameId: this.gameId,
      token,
      intervalMs: this.options.pollIntervalMs,
      recorder: this.options.recorder,
    });
  }

  /** 通常の画面（4 役割 + 進行役）の取り直しを始める。実ブラウザのチームは始めない。 */
  startNormalClients(): void {
    if (this.options.browserTeam) {
      return;
    }
    // 4 人の役割の画面は、反映の観察のために週を受け取る。進行役の画面は確定を要求した側なので観察しない
    this.normalClients = [
      ...this.players.map(
        (player, screen) =>
          new VirtualClient({
            baseUrl: this.options.baseUrl,
            gameId: this.gameId,
            token: player.token,
            intervalMs: this.options.pollIntervalMs,
            recorder: this.options.recorder,
            onState: (state) => this.observeState(screen, state),
          }),
      ),
      this.newClient(this.facilitator),
    ];
    for (const client of this.normalClients) {
      client.start();
    }
  }

  /** 追加の取り直し専用の画面（担当者の追加分と観察者）の取り直しを始める。 */
  startExtraClients(): void {
    if (this.options.extraScreens === 0) {
      return;
    }
    this.extraClients = [
      ...this.extras.map((extra) => this.newClient(extra.token)),
      this.newClient(this.observer),
    ];
    for (const client of this.extraClients) {
      client.start();
    }
  }

  /** 切断の模擬: 1 人の担当者の取り直しを、指定の時間だけ止める。 */
  simulateDisconnect(ms: number): number {
    const target = this.normalClients[0];
    if (!target) {
      return 0;
    }
    target.disconnectFor(ms);
    return 1;
  }

  async stopClients(): Promise<void> {
    await Promise.all([...this.normalClients, ...this.extraClients].map((client) => client.stop()));
  }

  private observeState(screen: number, state: StateObservation): void {
    this.reflection.observe(screen, state.week, state.receivedAt);
    for (const week of [...this.flushing.keys()]) {
      if (this.reflection.isComplete(week)) {
        this.flush(week);
      }
    }
  }

  private flush(week: number): void {
    const phase = this.flushing.get(week);
    if (phase === undefined) {
      return;
    }
    this.flushing.delete(week);
    const collected = this.reflection.collect(week);
    for (const value of collected.values) {
      this.options.recorder.recordReflection('virtual', value, phase);
    }
  }

  /**
   * 1 週ぶんの動作: 4 役割が入力を確定し、進行役が週を確定する。
   * 週の確定の応答を受け取った時刻を、反映の始点にする。
   */
  async playWeek(): Promise<void> {
    if (this.failed || this.cyclesStopped) {
      return;
    }
    const { baseUrl, team, plan, recorder } = this.options;
    const week = this.currentWeek;
    await Promise.all(
      this.players.map(async (player) => {
        const quantity = plan.quantity(team, week, player.role);
        const result = await call(
          baseUrl,
          'PUT',
          `/api/games/${this.gameId}/weeks/${week}/decisions/${player.role}`,
          {
            token: player.token,
            body: { quantity },
            idempotencyKey: `u6load-in-t${team}-w${week}-${player.role}-${this.gameId.slice(0, 8)}`,
          },
        );
        recorder.recordInputConfirm(result.outcome, {
          gameId: this.gameId,
          week,
          role: player.role,
          quantity,
        });
      }),
    );
    const confirm = await call(baseUrl, 'POST', `/api/games/${this.gameId}/weeks/${week}/confirm`, {
      token: this.facilitator,
      idempotencyKey: `u6load-confirm-t${team}-w${week}-${this.gameId.slice(0, 8)}`,
    });
    recorder.recordWeekConfirm(confirm.outcome);
    if (!isSuccess(confirm.outcome)) {
      this.failed = true;
      return;
    }
    this.currentWeek = week + 1;
    const newWeek = this.currentWeek;
    if (!this.options.browserTeam) {
      this.reflection.markConfirmed(newWeek, confirm.receivedAt);
      this.flushing.set(newWeek, recorder.currentPhase());
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.flush(newWeek);
      }, REFLECTION_WAIT_MS);
      this.timers.add(timer);
    }
    this.options.onWeekConfirmed?.(newWeek, confirm.receivedAt);
  }

  /** 週の確定の動作を止める。待っている反映の標本を取り出す。 */
  stopCycles(): void {
    this.cyclesStopped = true;
  }

  /** 待っている反映の標本を、現れなかった画面を含めて記録して終える。 */
  flushPending(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const week of [...this.flushing.keys()]) {
      this.flush(week);
    }
  }
}
