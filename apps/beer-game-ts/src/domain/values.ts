export interface Issue {
  /** 対象の週（週に紐づかない場合は省略） */
  week?: number;
  /** 対象の入力項目（共有の契約の `errors[].field`。例: `conditions.initialFlow`）。特定の項目に紐づかない場合は省略 */
  field?: string;
  problem: string;
  fix: string;
}

export class DomainError extends Error {
  constructor(
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 操作する権限がない。呼び出し側は 403 として扱う */
export class PermissionError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/**
 * 準備中でないゲームへの、準備中だけの操作（参加・割り当てなど）。
 * 共有の API の契約では 409 `game.not_preparing`。旧い経路では、ほかのドメインの誤りと同じく 422 のまま。
 */
export class NotPreparingError extends DomainError {
  constructor(message = 'このゲームは参加の受付を終了しています') {
    super(message);
    this.name = 'NotPreparingError';
  }
}

/** すでに開始されたゲームの、開始。共有の API の契約では 409 `session.already_started` */
export class AlreadyStartedError extends DomainError {
  constructor(message = 'このゲームはすでに開始されています') {
    super(message);
    this.name = 'AlreadyStartedError';
  }
}

/** 開始の条件を満たさない（役割が足りない）。共有の API の契約では 409 `game.start_condition_not_met`＋`missingRoles` */
export class StartConditionError extends DomainError {
  constructor(
    message: string,
    readonly missingRoles: readonly string[],
    issues: Issue[] = [],
  ) {
    super(message, issues);
    this.name = 'StartConditionError';
  }
}

/** このゲームの参加者ではない。共有の API の契約では 404 `game.participant_not_found` */
export class ParticipantNotFoundError extends DomainError {
  constructor(message = 'このゲームの参加者ではありません') {
    super(message);
    this.name = 'ParticipantNotFoundError';
  }
}

/** 停止中のセッションへの、進行中だけの操作。共有の契約では 409 `session.paused` */
export class SessionPausedError extends DomainError {
  constructor(
    message = '停止中です。進行役の再開を待ってください（保存済みの入力は残っています）',
  ) {
    super(message);
    this.name = 'SessionPausedError';
  }
}

/** 終了したセッションへの操作。共有の契約では 409 `session.already_ended` */
export class SessionEndedError extends DomainError {
  constructor(message = 'このゲームは終了しています') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

/** 停止中でないセッションの再開。共有の契約では 409 `session.not_paused` */
export class NotPausedError extends DomainError {
  constructor(message = '停止中ではないため、再開できません') {
    super(message);
    this.name = 'NotPausedError';
  }
}

/**
 * 1 役割・1 週あたりの保存回数（代理入力を含む）の上限に達した（NF-C8）。共有の契約では 409 `session.save_limit_reached`。
 * 競合で拒否された保存は、数えない（版は、受理された保存だけが進める）。
 */
export const SAVE_LIMIT = 9;
export class SaveLimitReachedError extends DomainError {
  constructor(
    message = `この週の、この役割の保存回数の上限（${SAVE_LIMIT} 回）に達しています`,
  ) {
    super(message);
    this.name = 'SaveLimitReachedError';
  }
}

/** 4 役割の入力がそろっていない週の確定。共有の契約では 422 `session.incomplete_decisions`＋`missingRoles` */
export class IncompleteDecisionsError extends DomainError {
  constructor(
    message: string,
    readonly missingRoles: readonly string[],
    issues: Issue[] = [],
  ) {
    super(message, issues);
    this.name = 'IncompleteDecisionsError';
  }
}

/** 版・週が古いなど、並行する操作との競合。呼び出し側は 409 として扱う */
export class StaleError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'StaleError';
  }
}

/**
 * 要求した週が、現在の週と違う（週がすでに進んでいる）。共有の契約では 409 `session.week_advanced`＋`requestedWeek`・`currentWeek`。
 * 版が違っても、週の判定が先。
 */
export class WeekAdvancedError extends StaleError {
  constructor(
    readonly requestedWeek: number,
    readonly currentWeek: number,
  ) {
    super(`現在の週は ${currentWeek} 週目です。要求の週が一致しません`);
    this.name = 'WeekAdvancedError';
  }
}

/**
 * 確認した後に、役割ごとの入力が変わった（確定の根拠が変わった）。共有の契約では 409 `session.decisions_changed`＋`week`・`current`。
 * `current` は、役割ごとの現在の入力（保存者・保存の時刻つき）。
 */
export class DecisionsChangedError extends StaleError {
  constructor(
    readonly week: number,
    readonly current: Readonly<
      Partial<
        Record<
          string,
          { quantity: number; version: number; savedBy: string; savedAt?: Date }
        >
      >
    >,
  ) {
    super('確認した後に入力が変更されました。再読み込みしてください');
    this.name = 'DecisionsChangedError';
  }
}

/** 競合したときの、その役割の最新の意思決定（保存者は参加者 ID、または代理入力の操作者） */
export interface LatestDecision {
  quantity: number;
  version: number;
  savedBy: string;
}

/**
 * 意思決定の版の競合（共同入力）。拒否した側へ、最新の値・版・保存者を返す（変更を黙って失わない）。
 * 未入力なら `latest` は null。
 */
export class DecisionConflictError extends StaleError {
  constructor(
    message: string,
    readonly latest: LatestDecision | null,
  ) {
    super(message);
    this.name = 'DecisionConflictError';
  }
}

export const QUANTITY_MAX = 1000;
export const WEEK_MAX = 50;
/** 表示名の上限（コードポイントの数）。共有の API の契約（`JoinGameRequest.displayName`）と同じ 80 */
export const DISPLAY_NAME_MAX = 80;

export type Quantity = number & { readonly __brand: 'Quantity' };
export const Quantity = {
  of(value: number, max: number = QUANTITY_MAX): Quantity {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new DomainError(`数量は 0〜${max} の整数です`, [
        {
          field: 'quantity',
          problem: `数量は 0〜${max} の整数です`,
          fix: `数量を 0〜${max} の整数にしてください`,
        },
      ]);
    }
    return value as Quantity;
  },
};

export type Week = number & { readonly __brand: 'Week' };
export const Week = {
  of(value: number, max: number = WEEK_MAX): Week {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new DomainError(`週は 1〜${max} の整数です`);
    }
    return value as Week;
  },
};

/** 金額は最小単位（セント）の非負整数で持つ。 */
export type Money = number & { readonly __brand: 'Money' };
export const Money = {
  ofMinor(value: number): Money {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainError('金額は 0 以上の整数（最小単位）です');
    }
    return value as Money;
  },
  format(minor: number): string {
    return `$${(minor / 100).toFixed(2)}`;
  },
};

export type Version = number & { readonly __brand: 'Version' };
export const Version = {
  of(value: number): Version {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainError('版は 0 以上の整数です');
    }
    return value as Version;
  },
  next(v: Version): Version {
    return Version.of(v + 1);
  },
};

export type DisplayName = string & { readonly __brand: 'DisplayName' };
export const DisplayName = {
  of(value: string): DisplayName {
    const trimmed = value.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > DISPLAY_NAME_MAX) {
      throw new DomainError(`表示名は 1〜${DISPLAY_NAME_MAX} 文字です`, [
        {
          field: 'displayName',
          problem: `表示名は 1〜${DISPLAY_NAME_MAX} 文字です`,
          fix: `表示名を 1〜${DISPLAY_NAME_MAX} 文字にしてください`,
        },
      ]);
    }
    return trimmed as DisplayName;
  },
};

/** 顧客需要の系列。週数と同じ長さで、各週は 0〜上限の整数。 */
export type DemandSeries = readonly Quantity[];
export const DemandSeries = {
  create(
    values: readonly number[],
    weeks: number,
    max: number = QUANTITY_MAX,
  ): DemandSeries {
    const issues: Issue[] = [];
    const range = `0〜${max} の整数`;
    for (let week = 1; week <= Math.max(weeks, values.length); week++) {
      const v = values[week - 1];
      if (week > weeks) {
        issues.push({
          field: 'demand',
          week,
          problem: '週数を超える需要です',
          fix: `${week} 週目以降の需要を削除するか、週数を増やしてください`,
        });
      } else if (v === undefined) {
        issues.push({
          field: 'demand',
          week,
          problem: '需要が指定されていません',
          fix: `${week} 週目の需要を追加してください`,
        });
      } else if (!Number.isInteger(v) || v < 0 || v > max) {
        issues.push({
          field: 'demand',
          week,
          problem: `${range}ではありません`,
          fix: `${range}にしてください`,
        });
      }
    }
    if (issues.length > 0) throw new DomainError('需要系列が無効です', issues);
    return values as DemandSeries;
  },
};
