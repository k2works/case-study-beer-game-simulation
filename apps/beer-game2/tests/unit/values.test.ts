import { describe, expect, it } from 'vitest';
import {
  DemandSeries,
  DisplayName,
  DomainError,
  Money,
  Quantity,
  Version,
  Week,
} from '../../src/domain/values.js';
import {
  ROLES,
  isRole,
  downstreamOf,
  upstreamOf,
} from '../../src/domain/role.js';

describe('Role', () => {
  it('[US1.2/AC1.2.1] 役割は 4 つで、供給の流れの上流から並ぶ', () => {
    expect(ROLES).toEqual(['FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER']);
  });
  it('役割の判定と下流', () => {
    expect(isRole('RETAILER')).toBe(true);
    expect(isRole('CUSTOMER')).toBe(false);
    expect(downstreamOf('FACTORY')).toBe('DISTRIBUTOR');
    expect(downstreamOf('RETAILER')).toBeNull();
  });
});

describe('Quantity', () => {
  it.each([0, 1, 1000])('[US2.2/AC2.2.2] %i は有効', (n) => {
    expect(Quantity.of(n)).toBe(n);
  });
  it.each([-1, 1001, 1.5, Number.NaN, Infinity])(
    '[US2.2/AC2.2.2] %s は拒否する',
    (n) => {
      expect(() => Quantity.of(n)).toThrow(DomainError);
    },
  );
  it('上限を指定できる', () => {
    expect(() => Quantity.of(11, 10)).toThrow(DomainError);
  });
});

describe('Week', () => {
  it.each([1, 50])('%i は有効', (n) => expect(Week.of(n)).toBe(n));
  it.each([0, 51, 2.5])('[US1.1/AC1.1.1] %s は拒否する', (n) => {
    expect(() => Week.of(n)).toThrow(DomainError);
  });
});

describe('Money', () => {
  it('最小単位（セント）の非負整数', () => {
    expect(Money.ofMinor(50)).toBe(50);
    expect(() => Money.ofMinor(-1)).toThrow(DomainError);
    expect(() => Money.ofMinor(0.5)).toThrow(DomainError);
  });
  it('表示用の書式', () => {
    expect(Money.format(150)).toBe('$1.50');
  });
});

describe('Version', () => {
  it('0 以上の整数で、次の版を作れる', () => {
    expect(Version.next(Version.of(0))).toBe(1);
    expect(() => Version.of(-1)).toThrow(DomainError);
  });
});

describe('DisplayName', () => {
  it('前後の空白を除き、1〜20 文字', () => {
    expect(DisplayName.of('  花子 ')).toBe('花子');
    expect(() => DisplayName.of('   ')).toThrow(DomainError);
    expect(() => DisplayName.of('あ'.repeat(21))).toThrow(DomainError);
  });
});

describe('DemandSeries', () => {
  it('[US1.1/AC1.1.1] 週数と同じ長さの有効な系列を受け付ける', () => {
    expect(DemandSeries.create([4, 4, 8], 3)).toEqual([4, 4, 8]);
  });
  it('[US1.1/AC1.1.2] 無効な系列は、対象週と修正内容を示す', () => {
    try {
      DemandSeries.create([4, -1, 8, 2000], 5);
      expect.unreachable();
    } catch (e) {
      const err = e as DomainError;
      expect(err).toBeInstanceOf(DomainError);
      expect(err.issues).toEqual([
        {
          week: 2,
          problem: '0〜1000 の整数ではありません',
          fix: '0〜1000 の整数にしてください',
        },
        {
          week: 4,
          problem: '0〜1000 の整数ではありません',
          fix: '0〜1000 の整数にしてください',
        },
        {
          week: 5,
          problem: '需要が指定されていません',
          fix: '5 週目の需要を追加してください',
        },
      ]);
    }
  });
  it('週数を超える分は、超過週を示す', () => {
    try {
      DemandSeries.create([1, 2, 3], 2);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).issues[0]).toMatchObject({ week: 3 });
    }
  });
});

describe('Role: 上流', () => {
  it('発注先（上流）', () => {
    expect(upstreamOf('RETAILER')).toBe('WHOLESALER');
    expect(upstreamOf('FACTORY')).toBeNull();
  });
});
