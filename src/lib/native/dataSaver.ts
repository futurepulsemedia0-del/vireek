// src/lib/native/dataSaver.ts — low-data mode. Automatic on Save-Data / 2G connections,
// or forced on/off by the user. Background prefetching must check isDataSaverActive().

export type DataSaverPref = 'auto' | 'on' | 'off';
export interface NetworkHint {
  saveData?: boolean;
  effectiveType?: string;
}

const KEY = 'vireek:data-saver';

export function parseDataSaverPref(raw: string | null | undefined): DataSaverPref {
  return raw === 'on' || raw === 'off' ? raw : 'auto';
}

export function shouldSaveData(pref: DataSaverPref, hint: NetworkHint): boolean {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return hint.saveData === true || hint.effectiveType === 'slow-2g' || hint.effectiveType === '2g';
}

export function readNetworkHint(): NetworkHint {
  const c = (typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: NetworkHint }).connection : undefined);
  return { saveData: c?.saveData, effectiveType: c?.effectiveType };
}

export function getDataSaverPref(): DataSaverPref {
  try {
    return parseDataSaverPref(window.localStorage.getItem(KEY));
  } catch {
    return 'auto';
  }
}

export function setDataSaverPref(pref: DataSaverPref): void {
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — preference simply does not persist */
  }
}

export function isDataSaverActive(): boolean {
  return shouldSaveData(getDataSaverPref(), readNetworkHint());
}
