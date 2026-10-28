/**
 * Payroll provider connectors: pure engine (no I/O, no framework imports).
 *
 * Shared by the edge functions (Deno) and the dashboard (Vite) and unit-tested in
 * src/lib/payrollConnectors.test.ts. It holds:
 *   - the provider catalog (what each provider can do, how its ids look),
 *   - settings validation (mirrors public._payroll_clean_settings in SQL),
 *   - file renderers (ADP wide layout, long layout for Gusto / Paychex / Rippling),
 *   - the Gusto API helpers (OAuth, employee matching, payroll update planning),
 *   - number / CSV helpers that never lose a cent and never allow CSV formula injection.
 */

// ============================================================
// CATALOG
// ============================================================

export const PAYROLL_PROVIDERS = ['gusto', 'adp', 'paychex', 'rippling'] as const;
export type PayrollProvider = (typeof PAYROLL_PROVIDERS)[number];
export type DeliveryMode = 'file' | 'api';
export type EarningKey = 'regular' | 'overtime' | 'commission' | 'tips';
export const EARNING_KEYS: EarningKey[] = ['regular', 'overtime', 'commission', 'tips'];

export interface ProviderMeta {
  label: string;
  tagline: string;
  /** Column / field label for the provider's employee identifier. */
  idLabel: string;
  idPlaceholder: string;
  supportsApi: boolean;
  fileLayout: 'wide' | 'long';
  fileLabel: string;
  /** Decimals used for hours in the file. */
  hoursDecimals: 2 | 3;
  /** Earning names / codes can be edited (Gusto's are fixed by its API). */
  editableEarnings: boolean;
  needsCompanyCode: boolean;
  importHint: string;
  setup: string[];
}

export const PROVIDER_META: Record<PayrollProvider, ProviderMeta> = {
  gusto: {
    label: 'Gusto',
    tagline: 'Send hours, commissions and tips straight into an open Gusto payroll, or download a file.',
    idLabel: 'Gusto employee UUID',
    idPlaceholder: 'e.g. 3f9c1a2e-…',
    supportsApi: true,
    fileLayout: 'long',
    fileLabel: 'Gusto hours & earnings CSV',
    hoursDecimals: 3,
    editableEarnings: false,
    needsCompanyCode: false,
    importHint: 'Gusto > Run payroll > the open pay period. API delivery fills it in for you.',
    setup: [
      'Connect Gusto with one click (OAuth). Vireek only asks for payroll and employee access.',
      'Create the pay period in Gusto first. The export dates must match it exactly.',
      'Use Auto-match to link employees by email or name.',
    ],
  },
  adp: {
    label: 'ADP Workforce Now',
    tagline: 'A Pay Data Input style CSV: one row per employee with regular / overtime hours and earnings codes.',
    idLabel: 'ADP File #',
    idPlaceholder: 'e.g. 1042',
    supportsApi: false,
    fileLayout: 'wide',
    fileLabel: 'ADP Pay Data Input CSV',
    hoursDecimals: 2,
    editableEarnings: true,
    needsCompanyCode: true,
    importHint: 'ADP Workforce Now > Payroll > Payroll Data Input / import from file.',
    setup: [
      'Enter your ADP company code and the earnings codes your ADP account uses for commission and tips.',
      'Enter each employee’s ADP File # in Employee mapping.',
      'ADP stores hours to 2 decimals, so Vireek rounds each employee’s total once.',
      'ADP import layouts are configured per client. Compare the first file with your own import template.',
    ],
  },
  paychex: {
    label: 'Paychex Flex',
    tagline: 'A one-row-per-earning CSV (hours or amount) keyed by Paychex Worker ID.',
    idLabel: 'Paychex Worker ID',
    idPlaceholder: 'e.g. 00012345',
    supportsApi: false,
    fileLayout: 'long',
    fileLabel: 'Paychex hours & earnings CSV',
    hoursDecimals: 2,
    editableEarnings: true,
    needsCompanyCode: false,
    importHint: 'Paychex Flex > Payroll > the open payroll > import hours and earnings.',
    setup: [
      'Enter each employee’s Paychex Worker ID in Employee mapping.',
      'Set the pay component names exactly as they appear in your Paychex account.',
      'Compare the first file with your own Paychex import template.',
    ],
  },
  rippling: {
    label: 'Rippling',
    tagline: 'A one-row-per-earning CSV keyed by Rippling employee ID or work email.',
    idLabel: 'Rippling employee ID or email',
    idPlaceholder: 'e.g. name@company.com',
    supportsApi: false,
    fileLayout: 'long',
    fileLabel: 'Rippling hours & earnings CSV',
    hoursDecimals: 2,
    editableEarnings: true,
    needsCompanyCode: false,
    importHint: 'Rippling > Payroll > Run payroll > upload hours and earnings.',
    setup: [
      'Enter each employee’s Rippling ID or work email in Employee mapping.',
      'Set the earning type names as they appear in your Rippling payroll settings.',
      'Compare the first file with your own Rippling upload template.',
    ],
  },
};

export const isPayrollProvider = (v: unknown): v is PayrollProvider =>
  typeof v === 'string' && (PAYROLL_PROVIDERS as readonly string[]).includes(v);

// ============================================================
// SETTINGS (mirrors public._payroll_clean_settings)
// ============================================================

export interface ConnectorSettings {
  earnings: Record<EarningKey, string>;
  adp: { co_code: string; batch_prefix: string };
}

export const GUSTO_EARNINGS: Record<EarningKey, string> = {
  regular: 'Regular Hours',
  overtime: 'Overtime',
  commission: 'Commission',
  tips: 'Paycheck Tips',
};

export function defaultSettings(provider: PayrollProvider): ConnectorSettings {
  const earnings: Record<EarningKey, string> =
    provider === 'adp'
      ? { regular: 'Regular Hours', overtime: 'Overtime', commission: 'COM', tips: 'TIP' }
      : { ...GUSTO_EARNINGS };
  return { earnings, adp: { co_code: '', batch_prefix: 'VRK' } };
}

const EARNING_NAME = /^[A-Za-z0-9][A-Za-z0-9 _/&.-]{0,39}$/;
const ADP_CO = /^[A-Za-z0-9]{0,6}$/;
const ADP_PREFIX = /^[A-Za-z0-9]{0,4}$/;

export type SettingsResult = { ok: true; settings: ConnectorSettings } | { ok: false; error: string };

export function validateSettings(provider: PayrollProvider, input: unknown): SettingsResult {
  const base = defaultSettings(provider);
  if (input === undefined || input === null) return { ok: true, settings: base };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Settings must be an object.' };
  const src = input as Record<string, unknown>;
  const out: ConnectorSettings = { earnings: { ...base.earnings }, adp: { ...base.adp } };
  for (const k of Object.keys(src)) {
    if (k !== 'earnings' && k !== 'adp') return { ok: false, error: `Unknown setting: ${k}` };
    const group = src[k];
    if (!group || typeof group !== 'object' || Array.isArray(group)) return { ok: false, error: `Setting ${k} must be an object.` };
    for (const [sk, raw] of Object.entries(group as Record<string, unknown>)) {
      if (typeof raw !== 'string') return { ok: false, error: `Setting ${k}.${sk} must be text.` };
      const v = raw.trim();
      if (k === 'earnings') {
        if (!(EARNING_KEYS as string[]).includes(sk)) return { ok: false, error: `Unknown earning: ${sk}` };
        if (!EARNING_NAME.test(v)) return { ok: false, error: `Earning name for ${sk} must be 1-40 letters, numbers, spaces or _ / & . -` };
        out.earnings[sk as EarningKey] = v;
      } else if (sk === 'co_code') {
        if (!ADP_CO.test(v)) return { ok: false, error: 'ADP company code must be up to 6 letters or numbers.' };
        out.adp.co_code = v;
      } else if (sk === 'batch_prefix') {
        if (!ADP_PREFIX.test(v)) return { ok: false, error: 'ADP batch prefix must be up to 4 letters or numbers.' };
        out.adp.batch_prefix = v;
      } else {
        return { ok: false, error: `Unknown ADP setting: ${sk}` };
      }
    }
  }
  if (provider === 'gusto') out.earnings = { ...GUSTO_EARNINGS };
  return { ok: true, settings: out };
}

/** Same rule as set_payroll_employee_link() in SQL, plus the Gusto UUID shape. */
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9 ._@+#/:-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateExternalId(provider: PayrollProvider, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.trim();
  if (!v) return { ok: true, value: '' };
  if (!EXTERNAL_ID.test(v)) return { ok: false, error: 'Use letters, numbers or . _ @ + # / : - (no leading symbol).' };
  if (provider === 'gusto' && !UUID.test(v)) return { ok: false, error: 'A Gusto employee ID is a UUID, e.g. 3f9c1a2e-….' };
  return { ok: true, value: v };
}

// ============================================================
// NUMBERS + CSV
// ============================================================

export interface ExportLine {
  employee_id: string;
  employee_name: string;
  external_id: string;
  external_job_id: string | null;
  regular_hours: number;
  overtime_hours: number;
  commission_cents: number;
  tip_cents: number;
}

/** PostgREST returns numeric columns as numbers or strings; normalise defensively. */
export function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function normalizeLine(raw: Record<string, unknown>): ExportLine {
  return {
    employee_id: String(raw.employee_id ?? ''),
    employee_name: String(raw.employee_name ?? ''),
    external_id: String(raw.external_id ?? ''),
    external_job_id: raw.external_job_id ? String(raw.external_job_id) : null,
    regular_hours: toNumber(raw.regular_hours),
    overtime_hours: toNumber(raw.overtime_hours),
    commission_cents: Math.round(toNumber(raw.commission_cents)),
    tip_cents: Math.round(toNumber(raw.tip_cents)),
  };
}

/** Hours as fixed decimals. Rounded half away from zero on the thousandths first, so 7.3335 -> 7.334. */
export function formatHours(hours: number, decimals: 2 | 3 = 3): string {
  const scaled = Math.round((Math.abs(hours) + Number.EPSILON) * 10 ** decimals);
  const s = (scaled / 10 ** decimals).toFixed(decimals);
  return hours < 0 && scaled > 0 ? `-${s}` : s;
}

/** Integer cents -> "1234.50" using integer math only. */
export function formatAmount(cents: number): string {
  const c = Math.round(cents);
  const abs = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Quote when needed (RFC 4180). */
function quote(s: string): string {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Text cell: neutralises spreadsheet formula injection (=, +, -, @, tab, CR) before quoting. */
export function csvText(value: string): string {
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return quote(s);
}
/** Numeric cell: already formatted by formatHours / formatAmount, never user text. */
const csvNum = (s: string): string => s;

export interface RenderContext {
  provider: PayrollProvider;
  settings: ConnectorSettings;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
}

export interface RenderedFile {
  fileName: string;
  mime: string;
  content: string; // UTF-8 with BOM, CRLF line endings
  rowCount: number;
}

export function batchId(prefix: string, periodEnd: string): string {
  const mmdd = periodEnd.slice(5, 7) + periodEnd.slice(8, 10);
  return `${prefix || 'VRK'}${mmdd}`;
}

const ID_HEADER: Record<PayrollProvider, string> = {
  gusto: 'Employee UUID',
  adp: 'File #',
  paychex: 'Worker ID',
  rippling: 'Employee ID',
};

export function renderExportFile(lines: ExportLine[], ctx: RenderContext): RenderedFile {
  const meta = PROVIDER_META[ctx.provider];
  const d = meta.hoursDecimals;
  const e = ctx.settings.earnings;
  const rows: string[][] = [];
  let header: string[];

  if (meta.fileLayout === 'wide') {
    header = ['Co Code', 'Batch ID', 'File #', 'Reg Hours', 'O/T Hours', 'Earnings 3 Code', 'Earnings 3 Amount', 'Earnings 4 Code', 'Earnings 4 Amount'];
    const bid = batchId(ctx.settings.adp.batch_prefix, ctx.periodEnd);
    for (const l of lines) {
      rows.push([
        csvText(ctx.settings.adp.co_code),
        csvText(bid),
        csvText(l.external_id),
        l.regular_hours > 0 ? csvNum(formatHours(l.regular_hours, d)) : '',
        l.overtime_hours > 0 ? csvNum(formatHours(l.overtime_hours, d)) : '',
        l.commission_cents > 0 ? csvText(e.commission) : '',
        l.commission_cents > 0 ? csvNum(formatAmount(l.commission_cents)) : '',
        l.tip_cents > 0 ? csvText(e.tips) : '',
        l.tip_cents > 0 ? csvNum(formatAmount(l.tip_cents)) : '',
      ]);
    }
  } else {
    header = [ID_HEADER[ctx.provider], 'Employee Name', 'Earning', 'Hours', 'Amount', 'Pay Period Start', 'Pay Period End'];
    const push = (l: ExportLine, earning: string, hours: string, amount: string) =>
      rows.push([csvText(l.external_id), csvText(l.employee_name), csvText(earning), hours, amount, ctx.periodStart, ctx.periodEnd]);
    for (const l of lines) {
      if (l.regular_hours > 0) push(l, e.regular, csvNum(formatHours(l.regular_hours, d)), '');
      if (l.overtime_hours > 0) push(l, e.overtime, csvNum(formatHours(l.overtime_hours, d)), '');
      if (l.commission_cents > 0) push(l, e.commission, '', csvNum(formatAmount(l.commission_cents)));
      if (l.tip_cents > 0) push(l, e.tips, '', csvNum(formatAmount(l.tip_cents)));
    }
  }

  const csv = [header.map(quote).join(','), ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n';
  return {
    fileName: `vireek-${ctx.provider}-payroll-${ctx.periodStart}_${ctx.periodEnd}.csv`,
    mime: 'text/csv;charset=utf-8',
    content: '﻿' + csv,
    rowCount: rows.length,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// GUSTO API
// ============================================================

export type GustoEnvironment = 'production' | 'sandbox';
export const GUSTO_BASES: Record<GustoEnvironment, string> = {
  production: 'https://api.gusto.com',
  sandbox: 'https://api.gusto-demo.com',
};
export const GUSTO_DEFAULT_API_VERSION = '2026-06-15';
export const GUSTO_MAX_COMPENSATIONS_PER_REQUEST = 100;

export const gustoBaseFor = (env: GustoEnvironment): string => GUSTO_BASES[env];
export const isAllowedGustoBase = (url: string): boolean => Object.values(GUSTO_BASES).includes(url.replace(/\/+$/, ''));

export function buildGustoAuthorizeUrl(p: { base: string; clientId: string; redirectUri: string; state: string }): string {
  const u = new URL('/oauth/authorize', p.base);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', p.state);
  return u.toString();
}

export interface HttpReq {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function buildGustoTokenRequest(
  kind: 'code' | 'refresh',
  p: { base: string; clientId: string; clientSecret: string; redirectUri?: string; code?: string; refreshToken?: string },
): HttpReq {
  const body = new URLSearchParams();
  body.set('client_id', p.clientId);
  body.set('client_secret', p.clientSecret);
  if (kind === 'code') {
    body.set('grant_type', 'authorization_code');
    body.set('code', p.code ?? '');
    body.set('redirect_uri', p.redirectUri ?? '');
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', p.refreshToken ?? '');
  }
  return {
    url: new URL('/oauth/token', p.base).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  };
}

export interface GustoTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
}
export function parseGustoTokens(json: unknown): GustoTokens {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('Token response had no access token.');
  const exp = toNumber(j.expires_in);
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null,
    expiresInSec: exp > 0 ? exp : null,
  };
}

export const gustoHeaders = (accessToken: string, version: string = GUSTO_DEFAULT_API_VERSION): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Gusto-API-Version': version,
});

export interface GustoCompany {
  id: string;
  name: string;
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Companies the OAuth user can administer, from GET /v1/me (tolerates the response shapes Gusto has used). */
export function parseGustoCompanies(json: unknown): GustoCompany[] {
  const j = obj(json);
  const roles = obj(j.roles);
  const candidates: unknown[] = [
    ...(Array.isArray(obj(roles.payroll_admin).companies) ? (obj(roles.payroll_admin).companies as unknown[]) : []),
    ...(Array.isArray(j.companies) ? (j.companies as unknown[]) : []),
  ];
  const seen = new Set<string>();
  const out: GustoCompany[] = [];
  for (const c of candidates) {
    const o = obj(c);
    const id = str(o.uuid) ?? str(o.id);
    if (!id || !UUID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: str(o.name) ?? str(o.trade_name) ?? 'Gusto company' });
  }
  return out;
}

export interface GustoEmployee {
  id: string;
  name: string;
  email: string | null;
  jobId: string | null;
  terminated: boolean;
}
export function parseGustoEmployees(json: unknown): GustoEmployee[] {
  if (!Array.isArray(json)) return [];
  const out: GustoEmployee[] = [];
  for (const raw of json) {
    const o = obj(raw);
    const id = str(o.uuid) ?? str(o.id);
    if (!id || !UUID.test(id)) continue;
    const jobs = Array.isArray(o.jobs) ? (o.jobs as unknown[]).map(obj) : [];
    const primary = jobs.find((j) => j.primary === true) ?? jobs[0];
    const name = [str(o.first_name), str(o.last_name)].filter(Boolean).join(' ');
    out.push({
      id,
      name: name || 'Unnamed employee',
      email: str(o.email)?.toLowerCase() ?? null,
      jobId: primary ? (str(primary.uuid) ?? str(primary.id)) : null,
      terminated: o.terminated === true,
    });
  }
  return out;
}

export interface MappingEmployee {
  employee_id: string;
  name: string;
  email: string | null;
  external_id: string | null;
}
export interface SuggestedLink {
  employee_id: string;
  external_id: string;
  external_job_id: string | null;
  label: string;
  match_source: 'email' | 'name';
}

const normName = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * One-to-one auto-match: by email first, then by exact normalised name. Already-linked employees are
 * skipped; a name shared by more than one candidate on either side is never guessed.
 */
export function matchGustoEmployees(vireek: MappingEmployee[], gusto: GustoEmployee[]): SuggestedLink[] {
  const taken = new Set(vireek.map((v) => v.external_id).filter(Boolean) as string[]);
  const free = gusto.filter((g) => !g.terminated && !taken.has(g.id));
  const open = vireek.filter((v) => !v.external_id);
  const used = new Set<string>();
  const out: SuggestedLink[] = [];
  const claim = (v: MappingEmployee, g: GustoEmployee, src: 'email' | 'name') => {
    used.add(g.id);
    out.push({ employee_id: v.employee_id, external_id: g.id, external_job_id: g.jobId, label: g.email ? `${g.name} (${g.email})` : g.name, match_source: src });
  };
  const done = new Set<string>();
  for (const v of open) {
    const em = v.email?.trim().toLowerCase();
    if (!em) continue;
    const hits = free.filter((g) => g.email === em && !used.has(g.id));
    if (hits.length === 1) {
      claim(v, hits[0], 'email');
      done.add(v.employee_id);
    }
  }
  for (const v of open) {
    if (done.has(v.employee_id)) continue;
    const n = normName(v.name);
    if (!n) continue;
    const vSame = open.filter((x) => !done.has(x.employee_id) && normName(x.name) === n);
    const hits = free.filter((g) => !used.has(g.id) && normName(g.name) === n);
    if (vSame.length === 1 && hits.length === 1) claim(v, hits[0], 'name');
  }
  return out;
}

export type JsonObj = Record<string, unknown>;

/** The unprocessed payroll whose pay period is exactly [start, end]. */
export function pickGustoPayroll(payrolls: unknown, start: string, end: string): { id: string; raw: JsonObj } | null {
  if (!Array.isArray(payrolls)) return null;
  for (const p of payrolls) {
    const o = obj(p);
    const period = obj(o.pay_period);
    const s = str(period.start_date) ?? str(o.pay_period_start_date);
    const e = str(period.end_date) ?? str(o.pay_period_end_date);
    const id = str(o.payroll_uuid) ?? str(o.uuid) ?? str(o.payroll_id);
    if (id && s === start && e === end && o.processed !== true) return { id, raw: o };
  }
  return null;
}

export interface GustoFixed { name: string; amount: string; job_uuid?: string }
export interface GustoHourly { name: string; hours: string; job_uuid?: string }
export interface GustoEmployeeComp {
  employee_uuid: string;
  version?: string;
  fixed_compensations?: GustoFixed[];
  hourly_compensations?: GustoHourly[];
}
export type LineOutcome = { status: 'pending' | 'unchanged' | 'conflict' | 'error'; message: string };

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Compares what Vireek wants with what the open Gusto payroll already holds and builds the minimal PUT.
 * Values are SET, not added, so re-sending the same export is idempotent. Existing different non-zero
 * values are never overwritten unless `overwrite` is true (they become a `conflict` for the owner).
 * An employee is updated all-or-nothing so a payroll never ends up half-filled.
 */
export function planGustoUpdates(
  lines: ExportLine[],
  existingCompensations: unknown,
  opts: { overwrite: boolean },
): { updates: GustoEmployeeComp[]; outcomes: Map<string, LineOutcome> } {
  const existing = new Map<string, JsonObj>();
  if (Array.isArray(existingCompensations)) {
    for (const c of existingCompensations) {
      const o = obj(c);
      const id = str(o.employee_uuid) ?? str(o.employee_id);
      if (id) existing.set(id.toLowerCase(), o);
    }
  }
  const updates: GustoEmployeeComp[] = [];
  const outcomes = new Map<string, LineOutcome>();

  for (const l of lines) {
    const comp = existing.get(l.external_id.toLowerCase());
    if (!comp) {
      outcomes.set(l.employee_id, { status: 'error', message: 'Not on this Gusto payroll (terminated, wrong company, or not in this pay period).' });
      continue;
    }
    const fixedNow = Array.isArray(comp.fixed_compensations) ? (comp.fixed_compensations as unknown[]).map(obj) : [];
    const hourlyNow = Array.isArray(comp.hourly_compensations) ? (comp.hourly_compensations as unknown[]).map(obj) : [];
    const job = l.external_job_id ?? undefined;
    const findNow = (list: JsonObj[], name: string) =>
      list.find((x) => str(x.name)?.toLowerCase() === name.toLowerCase() && (!job || !str(x.job_uuid) || str(x.job_uuid) === job));

    const wantHourly: { name: string; hours: number }[] = [];
    if (l.regular_hours > 0) wantHourly.push({ name: GUSTO_EARNINGS.regular, hours: l.regular_hours });
    if (l.overtime_hours > 0) wantHourly.push({ name: GUSTO_EARNINGS.overtime, hours: l.overtime_hours });
    const wantFixed: { name: string; cents: number }[] = [];
    if (l.commission_cents > 0) wantFixed.push({ name: GUSTO_EARNINGS.commission, cents: l.commission_cents });
    if (l.tip_cents > 0) wantFixed.push({ name: GUSTO_EARNINGS.tips, cents: l.tip_cents });

    const hourlyOut: GustoHourly[] = [];
    const fixedOut: GustoFixed[] = [];
    const conflicts: string[] = [];

    for (const w of wantHourly) {
      const cur = toNumber(findNow(hourlyNow, w.name)?.hours);
      if (near(cur, w.hours, 0.0005)) continue;
      if (cur !== 0 && !opts.overwrite) conflicts.push(`${w.name}: Gusto has ${cur} h, Vireek has ${formatHours(w.hours)} h`);
      else hourlyOut.push({ name: w.name, hours: formatHours(w.hours, 3), ...(job ? { job_uuid: job } : {}) });
    }
    for (const w of wantFixed) {
      const cur = Math.round(toNumber(findNow(fixedNow, w.name)?.amount) * 100);
      if (cur === w.cents) continue;
      if (cur !== 0 && !opts.overwrite) conflicts.push(`${w.name}: Gusto has $${formatAmount(cur)}, Vireek has $${formatAmount(w.cents)}`);
      else fixedOut.push({ name: w.name, amount: formatAmount(w.cents), ...(job ? { job_uuid: job } : {}) });
    }

    if (conflicts.length) {
      outcomes.set(l.employee_id, { status: 'conflict', message: `Left untouched. ${conflicts.join('; ')}. Tick "Overwrite values already in Gusto" to replace them.` });
    } else if (!hourlyOut.length && !fixedOut.length) {
      outcomes.set(l.employee_id, { status: 'unchanged', message: 'Gusto already has these values.' });
    } else {
      const version = str(comp.version) ?? undefined;
      updates.push({
        employee_uuid: l.external_id,
        ...(version ? { version } : {}),
        ...(fixedOut.length ? { fixed_compensations: fixedOut } : {}),
        ...(hourlyOut.length ? { hourly_compensations: hourlyOut } : {}),
      });
      outcomes.set(l.employee_id, { status: 'pending', message: 'Sent to Gusto.' });
    }
  }
  return { updates, outcomes };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type GustoFault = 'ok' | 'conflict' | 'invalid' | 'auth' | 'throttle' | 'notfound' | 'error';
export function classifyGustoStatus(status: number): GustoFault {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'invalid';
  if (status === 429) return 'throttle';
  return 'error';
}

/** Best-effort human message from a Gusto error body (never echoes more than 300 chars). */
export function gustoErrorMessage(json: unknown, fallback: string): string {
  const j = obj(json);
  const errs = Array.isArray(j.errors) ? (j.errors as unknown[]).map(obj) : [];
  const parts = errs.map((e) => str(e.message) ?? str(e.error_key)).filter(Boolean) as string[];
  const msg = parts.length ? parts.join('; ') : (str(j.message) ?? fallback);
  return msg.slice(0, 300);
}

// ============================================================
// SUMMARY HELPERS (UI + edge)
// ============================================================

export interface ExportTotals {
  employees: number;
  regular_hours: number;
  overtime_hours: number;
  commission_cents: number;
  tip_cents: number;
}
export function totalsOf(lines: ExportLine[]): ExportTotals {
  return lines.reduce<ExportTotals>(
    (t, l) => ({
      employees: t.employees + 1,
      regular_hours: Math.round((t.regular_hours + l.regular_hours) * 1000) / 1000,
      overtime_hours: Math.round((t.overtime_hours + l.overtime_hours) * 1000) / 1000,
      commission_cents: t.commission_cents + l.commission_cents,
      tip_cents: t.tip_cents + l.tip_cents,
    }),
    { employees: 0, regular_hours: 0, overtime_hours: 0, commission_cents: 0, tip_cents: 0 },
  );
}
