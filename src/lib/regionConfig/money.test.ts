import { describe, it, expect } from 'vitest';
import { SUPPORTED_CURRENCIES, currencyDecimals, roundCents } from '../regional';
import { currencyExponent } from '../regionalPacks/packMoney';
import {
  MoneyError, ROUNDING_MODES, add, allocate, compare, divRound, fromDecimal, legacyCentsToMoney, money,
  moneyToLegacyCents, mulPct, mulRatio, negate, parseDecimal, subtract, sum, toDecimalNumber, zero, type RoundingMode,
} from './money';

describe('divRound — explicit rounding rules on exact ties', () => {
  // value = n / 2 so every case is an exact tie
  const table: Array<[number, Record<RoundingMode, number>]> = [
    [5, { half_away_from_zero: 3, half_up: 3, half_even: 2, floor: 2, ceil: 3, trunc: 2 }], //  2.5
    [7, { half_away_from_zero: 4, half_up: 4, half_even: 4, floor: 3, ceil: 4, trunc: 3 }], //  3.5
    [-5, { half_away_from_zero: -3, half_up: -2, half_even: -2, floor: -3, ceil: -2, trunc: -2 }], // -2.5
    [-7, { half_away_from_zero: -4, half_up: -3, half_even: -4, floor: -4, ceil: -3, trunc: -3 }], // -3.5
    [4, { half_away_from_zero: 2, half_up: 2, half_even: 2, floor: 2, ceil: 2, trunc: 2 }], // exact
  ];
  for (const [n, expected] of table) {
    for (const mode of ROUNDING_MODES) {
      it(`${n}/2 with ${mode} = ${expected[mode]}`, () => {
        expect(divRound(BigInt(n), 2n, mode)).toBe(BigInt(expected[mode]));
      });
    }
  }
  it('non-ties round to nearest for the half_* modes', () => {
    expect(divRound(7n, 3n, 'half_even')).toBe(2n); // 2.33
    expect(divRound(8n, 3n, 'half_even')).toBe(3n); // 2.67
    expect(divRound(-8n, 3n, 'half_up')).toBe(-3n);
  });
  it('rejects a non-positive divisor', () => {
    expect(() => divRound(1n, 0n)).toThrow(MoneyError);
  });
});

describe('construction & exact decimals', () => {
  it('rejects non-integers, unsafe integers and bad currencies', () => {
    expect(() => money(1.5, 'USD')).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(MoneyError);
    expect(() => money(1, 'usdollar')).toThrow(MoneyError);
    expect(money(1, 'usd').currency).toBe('USD');
  });
  it('normalises -0 and freezes', () => {
    const z = money(-0, 'USD');
    expect(Object.is(z.minor, 0)).toBe(true);
    expect(Object.isFrozen(z)).toBe(true);
  });
  it('parses decimals without float error', () => {
    expect(parseDecimal('1.005')).toEqual({ int: 1005n, scale: 3 });
    expect(parseDecimal(1.005)).toEqual({ int: 1005n, scale: 3 });
    expect(parseDecimal(-0.1)).toEqual({ int: -1n, scale: 1 });
    expect(() => parseDecimal('1e3')).toThrow(MoneyError);
    expect(() => parseDecimal(NaN)).toThrow(MoneyError);
  });
  it('fromDecimal handles the classic 1.005 and 0.285 float traps', () => {
    expect(fromDecimal(1.005, 'USD').minor).toBe(101);
    expect(fromDecimal('0.285', 'USD').minor).toBe(29);
    expect(fromDecimal('0.285', 'USD', 'half_even').minor).toBe(28);
    expect(fromDecimal('-0.285', 'USD', 'half_up').minor).toBe(-28);
    expect(fromDecimal('-0.285', 'USD').minor).toBe(-29);
  });
  it('fromDecimal respects zero-decimal currencies', () => {
    expect(fromDecimal('1000.5', 'JPY').minor).toBe(1001);
    expect(fromDecimal('1000.5', 'JPY', 'half_even').minor).toBe(1000);
    expect(fromDecimal(1234, 'JPY').minor).toBe(1234);
    expect(toDecimalNumber(money(1234, 'JPY'))).toBe(1234);
    expect(toDecimalNumber(money(12345, 'USD'))).toBe(123.45);
  });
});

describe('arithmetic', () => {
  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow(/without an explicit conversion/);
    expect(() => compare(money(1, 'USD'), money(1, 'EUR'))).toThrow(MoneyError);
  });
  it('adds, subtracts, negates, sums', () => {
    expect(add(money(150, 'USD'), money(75, 'USD')).minor).toBe(225);
    expect(subtract(money(150, 'USD'), money(175, 'USD')).minor).toBe(-25);
    expect(negate(money(5, 'USD')).minor).toBe(-5);
    expect(sum([money(1, 'EUR'), money(2, 'EUR'), money(3, 'EUR')], 'EUR').minor).toBe(6);
    expect(sum([], 'EUR')).toEqual(zero('EUR'));
  });
  it('mulPct uses exact thousandths and a single rounding', () => {
    expect(mulPct(money(2000, 'CAD'), 9.975).minor).toBe(200); // 199.5 → 200
    expect(mulPct(money(-2000, 'CAD'), '9.975').minor).toBe(-200);
    expect(mulPct(money(2000, 'CAD'), 9.975, 'half_even').minor).toBe(200); // 199.5 → 200 (even)
    expect(mulPct(money(1000, 'EUR'), 19).minor).toBe(190);
    expect(mulPct(money(1, 'EUR'), 50).minor).toBe(1); // 0.5 → 1 half_away
    expect(mulPct(money(1, 'EUR'), 50, 'half_even').minor).toBe(0);
    expect(() => mulPct(money(100, 'EUR'), '9.9755')).toThrow(/3 decimal/);
    expect(mulPct(money(100, 'EUR'), '9.9750').minor).toBe(10); // trailing zeros are fine
  });
  it('mulRatio converts with an exact rational rate', () => {
    expect(mulRatio(money(10000, 'USD'), 1085n, 1000n).minor).toBe(10850);
    expect(mulRatio(money(333, 'USD'), 1, 3).minor).toBe(111);
  });
  it('allocate never loses or invents a minor unit', () => {
    for (const total of [-1001, -1, 0, 1, 99, 100, 101, 100000]) {
      for (const w of [[1, 1, 1], [3, 7], [1], [0, 5, 0], [2, 3, 5, 7]]) {
        const parts = allocate(money(total, 'EUR'), w);
        expect(parts.reduce((a, p) => a + p.minor, 0)).toBe(total);
        expect(parts.every((p) => p.currency === 'EUR')).toBe(true);
      }
    }
    expect(() => allocate(money(1, 'EUR'), [-1, 2])).toThrow(MoneyError);
  });
});

describe('legacy "cents ×100" bridge', () => {
  it('is the identity for 2-decimal currencies', () => {
    expect(legacyCentsToMoney(12345, 'USD').minor).toBe(12345);
    expect(moneyToLegacyCents(money(12345, 'USD'))).toBe(12345);
  });
  it('maps zero-decimal currencies (¥1,000 = 100000 legacy cents = 1000 minor)', () => {
    expect(legacyCentsToMoney(100000, 'JPY').minor).toBe(1000);
    expect(moneyToLegacyCents(money(1000, 'JPY'))).toBe(100000);
    expect(legacyCentsToMoney(100050, 'JPY').minor).toBe(1001); // half_away
    expect(legacyCentsToMoney(100050, 'JPY', 'half_even').minor).toBe(1000);
  });
  it('round-trips every supported currency', () => {
    for (const code of Object.keys(SUPPORTED_CURRENCIES)) {
      const m = money(123456, code);
      expect(legacyCentsToMoney(moneyToLegacyCents(m), code)).toEqual(m);
    }
  });
  it('agrees with regional.roundCents (single source of truth for stored amounts)', () => {
    for (const code of Object.keys(SUPPORTED_CURRENCIES)) {
      for (const cents of [0, 1, 49, 50, 51, 99, 100, 150, 99999]) {
        const viaMoney = moneyToLegacyCents(legacyCentsToMoney(roundCents(cents, code), code));
        expect(viaMoney).toBe(roundCents(cents, code));
      }
    }
  });
  it('rejects 3-decimal currencies instead of corrupting them', () => {
    expect(() => legacyCentsToMoney(1000, 'KWD')).toThrow(/legacy cents/);
    expect(() => moneyToLegacyCents(money(1000, 'KWD'))).toThrow(MoneyError);
    expect(() => legacyCentsToMoney(NaN, 'USD')).toThrow(MoneyError);
  });
});

describe('the two repo conventions agree on decimals', () => {
  it('regional.currencyDecimals === packMoney.currencyExponent for every supported currency', () => {
    for (const code of Object.keys(SUPPORTED_CURRENCIES)) {
      expect({ code, d: currencyDecimals(code) }).toEqual({ code, d: currencyExponent(code) });
    }
  });
});
