import { supabase } from '@/lib/supabase';

/**
 * Branding & white-label — client library.
 *
 * Data lives in `brand_settings` (one row per ACCOUNT, keyed by the account
 * owner's profile id — see supabase/migrations/20271009000000_brand_settings.sql).
 * Every query here is scoped by `ownerId` (the account owner, NOT the
 * logged-in user: for a team member those differ), and RLS enforces the same
 * thing server-side.
 */

// ============================================================
// Types & constants
// ============================================================

export type PortalTheme = 'light' | 'dark' | 'auto';
export type DomainStatus = 'unconfigured' | 'pending' | 'verified' | 'failed';

export interface BrandSettings {
  user_id: string;
  logo_path: string | null;
  primary_color: string;
  accent_color: string;
  email_sender_name: string | null;
  email_reply_to: string | null;
  email_footer: string | null;
  sms_sender_label: string | null;
  portal_theme: PortalTheme;
  portal_welcome_title: string | null;
  portal_welcome_message: string | null;
  portal_show_powered_by: boolean;
  custom_domain: string | null;
  domain_status: DomainStatus;
  domain_verification_token: string | null;
  domain_verified_at: string | null;
  domain_last_checked_at: string | null;
  domain_error: string | null;
  updated_at: string;
}

/** Fields the user edits. Verification state is deliberately absent — server-controlled. */
export interface BrandForm {
  primary_color: string;
  accent_color: string;
  email_sender_name: string;
  email_reply_to: string;
  email_footer: string;
  sms_sender_label: string;
  portal_theme: PortalTheme;
  portal_welcome_title: string;
  portal_welcome_message: string;
  portal_show_powered_by: boolean;
  custom_domain: string;
}

export interface PortalBranding {
  business_name: string | null;
  logo_path: string | null;
  primary_color: string;
  accent_color: string;
  portal_theme: PortalTheme;
  portal_welcome_title: string | null;
  portal_welcome_message: string | null;
  portal_show_powered_by: boolean;
}

export const BRAND_BUCKET = 'brand-assets';
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const DOMAIN_TXT_HOST_PREFIX = '_vireek-verify';
export const DOMAIN_CNAME_TARGET = 'cname.vercel-dns.com';

export const LIMITS = {
  senderName: 80,
  replyTo: 254,
  footer: 500,
  smsLabel: 30,
  welcomeTitle: 80,
  welcomeMessage: 400,
} as const;

export const DEFAULT_FORM: BrandForm = {
  primary_color: '#2563EB',
  accent_color: '#0EA5E9',
  email_sender_name: '',
  email_reply_to: '',
  email_footer: '',
  sms_sender_label: '',
  portal_theme: 'auto',
  portal_welcome_title: '',
  portal_welcome_message: '',
  portal_show_powered_by: true,
  custom_domain: '',
};

export const COLOR_PRESETS: { name: string; primary: string; accent: string }[] = [
  { name: 'Ocean', primary: '#2563EB', accent: '#0EA5E9' },
  { name: 'Forest', primary: '#15803D', accent: '#65A30D' },
  { name: 'Ember', primary: '#C2410C', accent: '#F59E0B' },
  { name: 'Violet', primary: '#6D28D9', accent: '#DB2777' },
  { name: 'Slate', primary: '#334155', accent: '#0F766E' },
  { name: 'Crimson', primary: '#B91C1C', accent: '#1D4ED8' },
];

// ============================================================
// Pure helpers (unit-tested)
// ============================================================

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

/** Accepts "#abc", "abc", "#AABBCC", "aabbcc" → "#AABBCC"; null if not a color. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9A-Fa-f]{3}$/.test(raw)) {
    return `#${raw.split('').map((c) => c + c).join('')}`.toUpperCase();
  }
  if (/^[0-9A-Fa-f]{6}$/.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const n = normalizeHex(hex);
  if (!n) return 0;
  const r = parseInt(n.slice(1, 3), 16);
  const g = parseInt(n.slice(3, 5), 16);
  const b = parseInt(n.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white — whichever reads better on `background`. */
export function readableTextColor(background: string): '#FFFFFF' | '#0F172A' {
  return contrastRatio(background, '#FFFFFF') >= contrastRatio(background, '#0F172A') ? '#FFFFFF' : '#0F172A';
}

export type ContrastGrade = 'AAA' | 'AA' | 'AA-large' | 'fail';

export function gradeContrast(ratio: number): ContrastGrade {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

/** Lowercases, strips protocol / path / port / trailing dot. "" if nothing usable. */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '');
  d = d.split(/[/?#]/)[0] ?? '';
  d = d.replace(/:\d+$/, '').replace(/\.$/, '');
  return d;
}

/** Hosts that can never be claimed as a customer portal domain. */
const RESERVED_DOMAIN_SUFFIXES = ['vireek.com', 'vireek.app', 'vercel.app', 'supabase.co', 'localhost'];

export function validateDomain(input: string): string | null {
  const d = normalizeDomain(input);
  if (!d) return null; // empty is valid = "no custom domain"
  if (!DOMAIN_RE.test(d)) return 'Enter a valid domain, e.g. portal.yourcompany.com';
  if (d.length > 253) return 'That domain is too long.';
  if (RESERVED_DOMAIN_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`))) {
    return 'That domain belongs to a platform we host on — use your own domain.';
  }
  return null;
}

export function validateEmail(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (v.length > LIMITS.replyTo || !EMAIL_RE.test(v)) return 'Enter a valid email address.';
  return null;
}

export function validateSenderName(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (v.length > LIMITS.senderName) return `Keep it under ${LIMITS.senderName} characters.`;
  if (/[<>"\r\n]/.test(v)) return 'Remove angle brackets, quotes and line breaks.';
  return null;
}

export interface FormErrors {
  primary_color?: string;
  accent_color?: string;
  email_sender_name?: string;
  email_reply_to?: string;
  sms_sender_label?: string;
  custom_domain?: string;
}

export function validateForm(form: BrandForm): FormErrors {
  const errors: FormErrors = {};
  if (!isHexColor(form.primary_color)) errors.primary_color = 'Use a 6-digit hex color, e.g. #2563EB.';
  if (!isHexColor(form.accent_color)) errors.accent_color = 'Use a 6-digit hex color, e.g. #0EA5E9.';
  const name = validateSenderName(form.email_sender_name);
  if (name) errors.email_sender_name = name;
  const reply = validateEmail(form.email_reply_to);
  if (reply) errors.email_reply_to = reply;
  const label = form.sms_sender_label.trim();
  if (label.length > LIMITS.smsLabel) errors.sms_sender_label = `Keep it under ${LIMITS.smsLabel} characters.`;
  else if (/[\r\n]/.test(label)) errors.sms_sender_label = 'No line breaks.';
  const domain = validateDomain(form.custom_domain);
  if (domain) errors.custom_domain = domain;
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function settingsToForm(row: BrandSettings | null): BrandForm {
  if (!row) return { ...DEFAULT_FORM };
  return {
    primary_color: row.primary_color,
    accent_color: row.accent_color,
    email_sender_name: row.email_sender_name ?? '',
    email_reply_to: row.email_reply_to ?? '',
    email_footer: row.email_footer ?? '',
    sms_sender_label: row.sms_sender_label ?? '',
    portal_theme: row.portal_theme,
    portal_welcome_title: row.portal_welcome_title ?? '',
    portal_welcome_message: row.portal_welcome_message ?? '',
    portal_show_powered_by: row.portal_show_powered_by,
    custom_domain: row.custom_domain ?? '',
  };
}

const emptyToNull = (v: string): string | null => {
  const t = v.trim();
  return t ? t : null;
};

export function formToPayload(form: BrandForm) {
  return {
    primary_color: form.primary_color.toUpperCase(),
    accent_color: form.accent_color.toUpperCase(),
    email_sender_name: emptyToNull(form.email_sender_name),
    email_reply_to: emptyToNull(form.email_reply_to)?.toLowerCase() ?? null,
    email_footer: emptyToNull(form.email_footer),
    sms_sender_label: emptyToNull(form.sms_sender_label),
    portal_theme: form.portal_theme,
    portal_welcome_title: emptyToNull(form.portal_welcome_title),
    portal_welcome_message: emptyToNull(form.portal_welcome_message),
    portal_show_powered_by: form.portal_show_powered_by,
    custom_domain: emptyToNull(normalizeDomain(form.custom_domain)),
  };
}

export function isFormDirty(a: BrandForm, b: BrandForm): boolean {
  return JSON.stringify(formToPayload(a)) !== JSON.stringify(formToPayload(b));
}

/** CSS custom properties that theme a subtree (portal, preview). */
export function brandCssVars(primary: string, accent: string): Record<string, string> {
  const p = isHexColor(primary) ? primary : DEFAULT_FORM.primary_color;
  const a = isHexColor(accent) ? accent : DEFAULT_FORM.accent_color;
  return {
    '--brand-primary': p,
    '--brand-on-primary': readableTextColor(p),
    '--brand-accent': a,
    '--brand-on-accent': readableTextColor(a),
  };
}

export function logoPublicUrl(path: string | null): string | null {
  if (!path) return null;
  return supabase.storage.from(BRAND_BUCKET).getPublicUrl(path).data.publicUrl;
}

export function formatSmsPreview(label: string, body: string): string {
  const l = label.trim();
  return l ? `${l}: ${body}` : body;
}

export function formatFromHeader(name: string, fallbackCompany: string): string {
  return name.trim() || fallbackCompany.trim() || 'Your business';
}

export interface DnsRecord {
  type: 'TXT' | 'CNAME';
  host: string;
  value: string;
  purpose: string;
}

export function domainDnsRecords(domain: string, token: string | null): DnsRecord[] {
  const d = normalizeDomain(domain);
  if (!d) return [];
  return [
    {
      type: 'TXT',
      host: `${DOMAIN_TXT_HOST_PREFIX}.${d}`,
      value: token ? `vireek-verify=${token}` : '(generated when you save)',
      purpose: 'Proves you own the domain',
    },
    { type: 'CNAME', host: d, value: DOMAIN_CNAME_TARGET, purpose: 'Points your domain at Vireek' },
  ];
}

/** Validate a candidate logo file before uploading. Returns an error message or null. */
export function validateLogoFile(file: { type: string; size: number }): string | null {
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPG or WebP image.';
  if (file.size > LOGO_MAX_BYTES) return 'Logo must be 2 MB or smaller.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

// ============================================================
// Data access
// ============================================================

export async function fetchBrandSettings(ownerId: string): Promise<BrandSettings | null> {
  const { data, error } = await supabase
    .from('brand_settings')
    .select('*')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  return (data as BrandSettings | null) ?? null;
}

export async function saveBrandSettings(ownerId: string, form: BrandForm): Promise<BrandSettings> {
  const { data, error } = await supabase
    .from('brand_settings')
    .upsert({ user_id: ownerId, ...formToPayload(form) }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as BrandSettings;
}

function extFor(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

/** Uploads a new logo, points brand_settings at it, then best-effort deletes the previous file. */
export async function uploadLogo(ownerId: string, file: File, previousPath: string | null): Promise<BrandSettings> {
  const invalid = validateLogoFile(file);
  if (invalid) throw new Error(invalid);

  // Unique path per upload so CDN/browser caches never serve a stale logo.
  const path = `${ownerId}/logo-${Date.now()}.${extFor(file.type)}`;
  const { error: upErr } = await supabase.storage.from(BRAND_BUCKET).upload(path, file, {
    contentType: file.type,
    cacheControl: '31536000',
    upsert: false,
  });
  if (upErr) throw upErr;

  const { data, error } = await supabase
    .from('brand_settings')
    .upsert({ user_id: ownerId, logo_path: path }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) {
    await supabase.storage.from(BRAND_BUCKET).remove([path]).catch(() => undefined);
    throw error;
  }
  if (previousPath && previousPath !== path) {
    await supabase.storage.from(BRAND_BUCKET).remove([previousPath]).catch(() => undefined);
  }
  return data as BrandSettings;
}

export async function removeLogo(ownerId: string, currentPath: string | null): Promise<BrandSettings> {
  const { data, error } = await supabase
    .from('brand_settings')
    .update({ logo_path: null })
    .eq('user_id', ownerId)
    .select('*')
    .single();
  if (error) throw error;
  if (currentPath) await supabase.storage.from(BRAND_BUCKET).remove([currentPath]).catch(() => undefined);
  return data as BrandSettings;
}

export interface VerifyDomainResult {
  status: DomainStatus;
  txt_found: boolean;
  cname_ok: boolean;
  error: string | null;
}

export async function verifyCustomDomain(): Promise<VerifyDomainResult> {
  const { data, error } = await supabase.functions.invoke('verify-custom-domain', { body: {} });
  if (error) throw error;
  return data as VerifyDomainResult;
}

/** Best-effort audit trail — never blocks the save. */
export async function logBrandingChange(actorEmail: string | null, changedFields: string[]): Promise<void> {
  try {
    await supabase.from('audit_log').insert({
      action: 'branding_updated',
      actor_email: actorEmail,
      metadata: { fields: changedFields },
    });
  } catch {
    /* non-blocking */
  }
}

export function changedFields(a: BrandForm, b: BrandForm): string[] {
  const pa = formToPayload(a) as Record<string, unknown>;
  const pb = formToPayload(b) as Record<string, unknown>;
  return Object.keys(pa).filter((k) => pa[k] !== pb[k]);
}

/** Public, token-validated branding for the customer portal. Null when unavailable. */
export async function fetchPortalBranding(token: string): Promise<PortalBranding | null> {
  const { data, error } = await supabase.rpc('get_portal_branding', { p_token: token });
  if (error || !data) return null;
  return data as PortalBranding;
}
