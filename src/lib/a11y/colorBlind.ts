import type { ColorBlindMode } from './settings';

type Mode = Exclude<ColorBlindMode, 'none'>;
type M3 = readonly (readonly number[])[];

/** Machado et al. (2009), severity 1.0 — dichromacy simulation, linear RGB. */
const SIM: Record<Mode, M3> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

/** Daltonization error-redistribution (moves lost channel information into visible channels). */
const SHIFT: Record<Mode, M3> = {
  protanopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  deuteranopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
  tritanopia: [[1, 0, 0.7], [0, 1, 0.7], [0, 0, 0]],
};

const at = (m: M3, i: number, j: number): number => m[i]?.[j] ?? 0;
const IDX = [0, 1, 2] as const;

/** Correction = I + SHIFT · (I − SIM). Neutral grays are preserved (every row sums to 1). */
export function correctionMatrix(mode: Mode): number[][] {
  const diff = IDX.map((i) => IDX.map((j) => (i === j ? 1 : 0) - at(SIM[mode], i, j)));
  return IDX.map((i) =>
    IDX.map((j) => {
      let shifted = 0;
      for (const k of IDX) shifted += at(SHIFT[mode], i, k) * (diff[k]?.[j] ?? 0);
      return (i === j ? 1 : 0) + shifted;
    }),
  );
}

/** 3×3 → feColorMatrix `values` (5×4, alpha untouched). */
export function toFeColorMatrix(m: number[][]): string {
  return m.map((r) => `${r.map((v) => Number(v.toFixed(6))).join(' ')} 0 0`).concat('0 0 0 1 0').join(' ');
}
