export interface Issue {
  /** 対象の週（週に紐づかない場合は省略） */
  week?: number;
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

/** 版・週が古いなど、並行する操作との競合。呼び出し側は 409 として扱う */
export class StaleError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'StaleError';
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
export const DISPLAY_NAME_MAX = 20;

export type Quantity = number & { readonly __brand: 'Quantity' };
export const Quantity = {
  of(value: number, max: number = QUANTITY_MAX): Quantity {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new DomainError(`数量は 0〜${max} の整数です`);
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
      throw new DomainError(`表示名は 1〜${DISPLAY_NAME_MAX} 文字です`);
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
          week,
          problem: '週数を超える需要です',
          fix: `${week} 週目以降の需要を削除するか、週数を増やしてください`,
        });
      } else if (v === undefined) {
        issues.push({
          week,
          problem: '需要が指定されていません',
          fix: `${week} 週目の需要を追加してください`,
        });
      } else if (!Number.isInteger(v) || v < 0 || v > max) {
        issues.push({
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
