export const ROOT_PX: number;
export const MIN_REM: number;
export interface TypeToken {
  name: string;
  alias: string | null;
  rem: number;
  lineHeight: string;
  tracking?: string;
  weight?: string;
  role: string;
  guidance: string;
  surface: 'dashboard' | 'marketing' | 'both';
}
export interface TypeUtility {
  className: string;
  role: string;
  css: string;
}
export const TYPE_SCALE: TypeToken[];
export const TYPE_UTILITIES: TypeUtility[];
export function toPx(rem: number): number;
export function assertScale(scale?: TypeToken[]): TypeToken[];
export function toTailwindFontSize(scale?: TypeToken[]): Record<string, [string, Record<string, string>]>;
