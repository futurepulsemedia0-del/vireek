// supabase/functions/_shared/payroll/gusto.ts
//
// Gusto adapter. Pure apart from the injected `fetch`, so the whole flow runs against a mock in tests.
//
// STATUS: NOT LIVE-VERIFIED. Written from Gusto's public API reference and covered by mock tests only.
// Verify in a Gusto demo company (see the checklist in the delivery notes) before using it with real payroll.
//
// What it does:   fills "Regular Hours", "Overtime" and a "Commission" fixed compensation on ONE open
//                 (unprocessed) Gusto payroll whose pay period covers the batch.
// What it NEVER does: calculate, submit or process a payroll. The employer reviews and runs it in Gusto.
// Idempotent:     values are SET (compared first, written only when different, then read back and checked),
//                 so sending the same batch twice changes nothing the second time.

import {
  ProviderError,
  centsToAmount,
  classifyHttpStatus,
  hoursToString,
  safeErrorDetail,
  sameAmount,
  sameHours,
  type ClaimedBatch,
  type ClaimedLine,
  type ExternalEmployee,
  type LineOutcome,
  type PayrollProviderAdapter,
  type PayrollSettings,
  type ProviderPayrollRef,
} from './engine.ts';

export const GUSTO_API_VERSION = '2024-04-01';
export const gustoBase = (environment: 'production' | 'sandbox'): string => (environment === 'sandbox' ? 'https://api.gusto-demo.com' : 'https://api.gusto.com');

// ------------------------------------------------------------
// OAuth request shapes
// ------------------------------------------------------------

export function buildGustoAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; environment: 'production' | 'sandbox' }): string {
  const u = new URL(`${gustoBase(p.environment)}/oauth/authorize`);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', p.state);
  return u.toString();
}

export function buildGustoTokenRequest(
  kind: 'code' | 'refresh',
  p: { environment: 'production' | 'sandbox'; clientId: string; clientSecret: string; redirectUri: string; code?: string; refreshToken?: string },
): { url: string; headers: Record<string, string>; body: string } {
  const body = new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri });
  if (kind === 'code') {
    body.set('grant_type', 'authorization_code');
    body.set('code', p.code ?? '');
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', p.refreshToken ?? '');
  }
  return { url: `${gustoBase(p.environment)}/oauth/token`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() };
}

export function parseGustoToken(json: unknown): { accessToken: string; refreshToken: string | null; expiresInSec: number | null } {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (typeof o.access_token !== 'string' || !o.access_token) throw new ProviderError('bad_response');
  return {
    accessToken: o.access_token,
    refreshToken: typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : null,
    expiresInSec: typeof o.expires_in === 'number' && Number.isFinite(o.expires_in) ? o.expires_in : null,
  };
}

/** GET /v1/me → the first company the connected user administers. */
export function parseGustoMe(json: unknown): { companyId: string; companyName: string | null } | null {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const roles = (o.roles && typeof o.roles === 'object' ? o.roles : {}) as Record<string, unknown>;
  const admin = (roles.payroll_admin && typeof roles.payroll_admin === 'object' ? roles.payroll_admin : {}) as Record<string, unknown>;
  const companies = Array.isArray(admin.companies) ? admin.companies : [];
  const first = companies[0] && typeof companies[0] === 'object' ? (companies[0] as Record<string, unknown>) : null;
  const id = first ? (first.uuid ?? first.id) : null;
  if (typeof id !== 'string' || !id) return null;
  return { companyId: id, companyName: typeof first?.name === 'string' ? first.name : null };
}

// ------------------------------------------------------------
// Compensation merge (pure)
// ------------------------------------------------------------

export interface GustoHourly {
  name: string;
  hours: string;
  job_uuid?: string | null;
  [k: string]: unknown;
}
export interface GustoFixed {
  name: string;
  amount: string;
  job_uuid?: string | null;
  [k: string]: unknown;
}
export interface GustoEmpComp {
  employee_uuid: string;
  excluded?: boolean;
  version?: string;
  payment_method?: string;
  memo?: string | null;
  fixed_compensations: GustoFixed[];
  hourly_compensations: GustoHourly[];
  paid_time_off?: unknown[];
  [k: string]: unknown;
}

export type MergeResult = { ok: true; changed: boolean; next: GustoEmpComp } | { ok: false; code: string; message: string };

const nameEq = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Merge one batch line into an employee's compensation on the open payroll.
 * Only values the batch actually carries are touched (hours > 0, commission > 0); everything else the
 * employer entered in Gusto is preserved.
 */
export function mergeCompensation(existing: GustoEmpComp, line: ClaimedLine, s: PayrollSettings): MergeResult {
  if (existing.excluded === true) {
    return { ok: false, code: 'employee_excluded', message: 'This employee is excluded from the open payroll in Gusto.' };
  }
  const hourly = existing.hourly_compensations.map((h) => ({ ...h }));
  const fixed = existing.fixed_compensations.map((f) => ({ ...f }));
  let changed = false;

  const wantsHours = line.send_hours && (line.regular_hours > 0 || line.overtime_hours > 0);
  if (wantsHours) {
    const reg = hourly.find((h) => nameEq(h.name, s.regular_name));
    if (!reg) {
      return {
        ok: false,
        code: 'no_hourly_compensation',
        message: `No "${s.regular_name}" pay line for this employee on the open payroll. Check their hourly compensation in Gusto.`,
      };
    }
    if (line.regular_hours > 0 && !sameHours(reg.hours, line.regular_hours)) {
      reg.hours = hoursToString(line.regular_hours);
      changed = true;
    }
    if (line.overtime_hours > 0) {
      const ot = hourly.find((h) => nameEq(h.name, s.overtime_name));
      if (!ot) {
        hourly.push({ name: s.overtime_name, hours: hoursToString(line.overtime_hours), ...(reg.job_uuid ? { job_uuid: reg.job_uuid } : {}) });
        changed = true;
      } else if (!sameHours(ot.hours, line.overtime_hours)) {
        ot.hours = hoursToString(line.overtime_hours);
        changed = true;
      }
    }
  }

  if (line.commission_cents > 0) {
    const row = fixed.find((f) => nameEq(f.name, s.commission_name));
    if (!row) {
      fixed.push({ name: s.commission_name, amount: centsToAmount(line.commission_cents) });
      changed = true;
    } else if (!sameAmount(row.amount, line.commission_cents)) {
      row.amount = centsToAmount(line.commission_cents);
      changed = true;
    }
  }

  return { ok: true, changed, next: { ...existing, hourly_compensations: hourly, fixed_compensations: fixed } };
}

// ------------------------------------------------------------
// Response normalisers
// ------------------------------------------------------------

interface GustoPayroll {
  id: string;
  version: string | null;
  processed: boolean;
  start: string;
  end: string;
  checkDate: string | null;
  comps: GustoEmpComp[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function normalizeComp(raw: unknown): GustoEmpComp | null {
  const o = rec(raw);
  const id = str(o.employee_uuid) ?? str(o.employee_id);
  if (!id) return null;
  return {
    ...o,
    employee_uuid: id,
    excluded: o.excluded === true,
    version: str(o.version) ?? undefined,
    fixed_compensations: Array.isArray(o.fixed_compensations) ? (o.fixed_compensations as GustoFixed[]) : [],
    hourly_compensations: Array.isArray(o.hourly_compensations) ? (o.hourly_compensations as GustoHourly[]) : [],
  };
}

function normalizePayroll(raw: unknown): GustoPayroll {
  const o = rec(raw);
  const id = str(o.payroll_uuid) ?? str(o.uuid) ?? str(o.payroll_id);
  const period = rec(o.pay_period);
  const start = str(period.start_date);
  const end = str(period.end_date);
  if (!id || !start || !end) throw new ProviderError('bad_response');
  const comps = (Array.isArray(o.employee_compensations) ? o.employee_compensations : []).map(normalizeComp).filter((c): c is GustoEmpComp => c !== null);
  const status = str(o.processing_status);
  return {
    id,
    version: str(o.version),
    processed: o.processed === true || status === 'processed',
    start,
    end,
    checkDate: str(o.check_date),
    comps,
  };
}

const labelOf = (p: GustoPayroll): string => `${p.start} to ${p.end}${p.checkDate ? ` (pay date ${p.checkDate})` : ''}`;

// ------------------------------------------------------------
// Adapter
// ------------------------------------------------------------

export interface GustoDeps {
  fetch: typeof fetch;
  baseUrl: string;
  companyId: string;
  apiVersion?: string;
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenPayroll {
  id: string;
  start: string;
  end: string;
  checkDate: string | null;
  label: string;
}

const MAX_RETRIES = 2;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const addDays = (iso: string, d: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

export function createGustoAdapter(deps: GustoDeps): PayrollProviderAdapter & {
  listEmployees(): Promise<ExternalEmployee[]>;
  listOpenPayrolls(start: string, end: string): Promise<OpenPayroll[]>;
} {
  const sleep = deps.sleep ?? defaultSleep;
  const base = `${deps.baseUrl}/v1/companies/${encodeURIComponent(deps.companyId)}`;
  let token: string | null = null;

  async function request(method: 'GET' | 'PUT', url: string, body?: unknown): Promise<unknown> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      token = token ?? (await deps.getAccessToken());
      let res: Response;
      try {
        res = await deps.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Gusto-API-Version': deps.apiVersion ?? GUSTO_API_VERSION,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ProviderError('network');
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await deps.refreshAccessToken();
        continue;
      }
      const retryAfterMs = res.headers.get('retry-after') ? Math.min(Number(res.headers.get('retry-after')) * 1000 || 1000, 5000) : null;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs ?? Math.min(500 * 2 ** attempt, 4000));
        continue;
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) throw new ProviderError(classifyHttpStatus(res.status), safeErrorDetail(json), res.status, retryAfterMs);
      return json;
    }
  }

  async function getPayroll(id: string): Promise<GustoPayroll> {
    return normalizePayroll(await request('GET', `${base}/payrolls/${encodeURIComponent(id)}`));
  }

  /** An unprocessed payroll only lists employee pay lines once it has been prepared. */
  async function getEditablePayroll(id: string): Promise<GustoPayroll> {
    let p = await getPayroll(id);
    if (p.processed) throw new ProviderError('payroll_processed');
    if (p.comps.length === 0) {
      p = normalizePayroll(await request('PUT', `${base}/payrolls/${encodeURIComponent(id)}/prepare`, {}));
      if (p.processed) throw new ProviderError('payroll_processed');
    }
    return p;
  }

  async function putComps(p: GustoPayroll, comps: GustoEmpComp[]): Promise<GustoPayroll> {
    const body = {
      ...(p.version ? { version: p.version } : {}),
      employee_compensations: comps.map((c) => ({
        employee_uuid: c.employee_uuid,
        ...(c.version ? { version: c.version } : {}),
        ...(c.payment_method ? { payment_method: c.payment_method } : {}),
        ...(c.memo !== undefined ? { memo: c.memo } : {}),
        fixed_compensations: c.fixed_compensations,
        hourly_compensations: c.hourly_compensations,
        ...(Array.isArray(c.paid_time_off) ? { paid_time_off: c.paid_time_off } : {}),
      })),
    };
    return normalizePayroll(await request('PUT', `${base}/payrolls/${encodeURIComponent(p.id)}`, body));
  }

  const failed = (line: ClaimedLine, code: string, message: string): LineOutcome => ({ line_id: line.line_id, status: 'failed', error_code: code, error_message: message });

  /** Read-after-write: the provider's own response must now contain exactly what we meant to set. */
  function verified(after: GustoPayroll, line: ClaimedLine, s: PayrollSettings): boolean {
    const comp = after.comps.find((c) => c.employee_uuid === line.external_employee_id);
    if (!comp) return false;
    const m = mergeCompensation(comp, line, s);
    return m.ok && !m.changed;
  }

  return {
    async listEmployees(): Promise<ExternalEmployee[]> {
      const out: ExternalEmployee[] = [];
      for (let page = 1; page <= 50; page++) {
        const json = await request('GET', `${base}/employees?page=${page}&per=100`);
        const rows = Array.isArray(json) ? json : [];
        for (const r of rows) {
          const o = rec(r);
          const id = str(o.uuid) ?? str(o.id);
          if (!id) continue;
          const name = [str(o.first_name), str(o.middle_initial), str(o.last_name)].filter(Boolean).join(' ').trim();
          out.push({ id, name: name || 'Unnamed employee', email: str(o.email), terminated: o.terminated === true });
        }
        if (rows.length < 100) break;
      }
      return out;
    },

    async listOpenPayrolls(start: string, end: string): Promise<OpenPayroll[]> {
      const q = new URLSearchParams({ processing_statuses: 'unprocessed', payroll_types: 'regular', start_date: addDays(start, -35), end_date: addDays(end, 70) });
      const json = await request('GET', `${base}/payrolls?${q.toString()}`);
      const rows = Array.isArray(json) ? json : [];
      const out: OpenPayroll[] = [];
      for (const r of rows) {
        try {
          const p = normalizePayroll(r);
          if (!p.processed) out.push({ id: p.id, start: p.start, end: p.end, checkDate: p.checkDate, label: labelOf(p) });
        } catch {
          /* ignore rows we cannot read */
        }
      }
      return out.sort((a, b) => a.start.localeCompare(b.start));
    },

    async resolvePayroll(batch: ClaimedBatch, requested: string | null): Promise<ProviderPayrollRef> {
      const { period_start: start, period_end: end } = batch.batch;
      const covers = (p: { start: string; end: string }) => p.start <= start && p.end >= end;
      if (requested) {
        const p = await getPayroll(requested);
        if (p.processed) throw new ProviderError('payroll_processed');
        if (!covers(p)) throw new ProviderError('period_mismatch', `Provider payroll covers ${p.start} to ${p.end}.`);
        return { id: p.id, label: labelOf(p) };
      }
      const open = (await this.listOpenPayrolls(start, end)).filter(covers);
      if (open.length === 0) throw new ProviderError('no_matching_payroll');
      const exact = open.filter((p) => p.start === start && p.end === end);
      const pick = exact.length > 0 ? exact : open;
      if (pick.length > 1) throw new ProviderError('ambiguous_payroll', pick.map((p) => p.label).join('; '));
      return { id: pick[0].id, label: pick[0].label };
    },

    async pushLines(payroll: ProviderPayrollRef, batch: ClaimedBatch): Promise<LineOutcome[]> {
      const s = batch.settings;
      const outcomes: LineOutcome[] = [];
      let current = await getEditablePayroll(payroll.id);
      const pending: ClaimedLine[] = [];

      for (const line of batch.lines) {
        const comp = current.comps.find((c) => c.employee_uuid === line.external_employee_id);
        if (!comp) {
          outcomes.push(failed(line, 'employee_not_on_payroll', 'This employee is not on the open payroll in Gusto (terminated, not yet started, or on another pay schedule).'));
          continue;
        }
        const m = mergeCompensation(comp, line, s);
        if (!m.ok) outcomes.push(failed(line, m.code, m.message));
        else if (!m.changed) outcomes.push({ line_id: line.line_id, status: 'unchanged', external_ref: payroll.id });
        else pending.push(line);
      }
      if (pending.length === 0) return outcomes;

      const merged = (p: GustoPayroll, lines: ClaimedLine[]): { line: ClaimedLine; next: GustoEmpComp }[] =>
        lines.flatMap((line) => {
          const comp = p.comps.find((c) => c.employee_uuid === line.external_employee_id);
          const m = comp ? mergeCompensation(comp, line, s) : null;
          return m && m.ok ? [{ line, next: m.next }] : [];
        });

      try {
        const batchUpdates = merged(current, pending);
        const after = await putComps(current, batchUpdates.map((u) => u.next));
        for (const { line } of batchUpdates) {
          outcomes.push(verified(after, line, s) ? { line_id: line.line_id, status: 'sent', external_ref: payroll.id } : failed(line, 'verification_failed', 'Gusto accepted the update but the values did not read back correctly.'));
        }
        return outcomes;
      } catch (e) {
        if (!(e instanceof ProviderError) || (e.code !== 'validation' && e.code !== 'conflict')) throw e;
      }

      // The combined update was refused. Send one employee at a time so a single bad line cannot block the rest.
      for (const line of pending) {
        try {
          current = await getEditablePayroll(payroll.id);
          const one = merged(current, [line]);
          if (one.length === 0) {
            outcomes.push(failed(line, 'employee_not_on_payroll', 'This employee is no longer on the open payroll in Gusto.'));
            continue;
          }
          const after = await putComps(current, [one[0].next]);
          outcomes.push(verified(after, line, s) ? { line_id: line.line_id, status: 'sent', external_ref: payroll.id } : failed(line, 'verification_failed', 'Gusto accepted the update but the values did not read back correctly.'));
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          if (e.code === 'payroll_processed' || e.code === 'unauthorized' || e.code === 'forbidden') throw e;
          outcomes.push(failed(line, e.code, e.detail ? `${e.message} (${e.detail})` : e.message));
        }
      }
      return outcomes;
    },
  };
}
