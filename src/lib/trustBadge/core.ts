// src/lib/trustBadge/core.ts
//
// Pure, dependency-free logic for the "Answered by Vireek" trust badge.
// Shared by: the trust-badge edge functions (Deno), the dashboard page and the verify page (browser), and Vitest.
// No I/O here. Every decision about what the badge may claim lives in this file so it is unit-tested.

export const BADGE_MIN_SAMPLE = 30; // minimum calls (or timed calls) in the window before any number is shown
export const BADGE_FRESH_DAYS = 7; // newest qualifying data point must be at most this old
export const BADGE_WINDOW_DAYS = 30;
export const BADGE_TOKEN_TTL_S = 24 * 60 * 60;

export const BADGE_VARIANTS = ['tiny', 'stat', 'card'] as const;
export const BADGE_THEMES = ['light', 'dark', 'auto'] as const;
export const BADGE_SIZES = ['sm', 'md', 'lg'] as const;
export const BADGE_PALETTES = ['blue', 'green', 'slate', 'mono'] as const;
export const BADGE_LOCALES = ['en', 'es', 'fa', 'ar', 'fr', 'de', 'hi', 'ja', 'zh'] as const;
export const BADGE_METRICS = ['calls', 'answer_time'] as const;
export const BADGE_REL_TOKENS = ['nofollow', 'sponsored', 'ugc'] as const;

export type BadgeVariant = (typeof BADGE_VARIANTS)[number];
export type BadgeTheme = (typeof BADGE_THEMES)[number];
export type BadgeSize = (typeof BADGE_SIZES)[number];
export type BadgePalette = (typeof BADGE_PALETTES)[number];
export type BadgeLocale = (typeof BADGE_LOCALES)[number];
export type BadgeMetric = (typeof BADGE_METRICS)[number];
export type BadgeRelToken = (typeof BADGE_REL_TOKENS)[number];
export type BadgeState = 'ok' | 'neutral' | 'hidden';

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;

export const parseVariant = (v: unknown) => oneOf(BADGE_VARIANTS, v, 'tiny');
export const parseTheme = (v: unknown) => oneOf(BADGE_THEMES, v, 'auto');
export const parseSize = (v: unknown) => oneOf(BADGE_SIZES, v, 'md');
export const parsePalette = (v: unknown) => oneOf(BADGE_PALETTES, v, 'blue');
export const parseLocale = (v: unknown): BadgeLocale => {
  const base = typeof v === 'string' ? v.toLowerCase().split(/[-_]/)[0] : '';
  return oneOf(BADGE_LOCALES, base, 'en');
};
export const isRtl = (l: BadgeLocale) => l === 'fa' || l === 'ar';

export function parseRel(input: unknown): BadgeRelToken[] {
  const arr = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const out = new Set<BadgeRelToken>();
  for (const t of arr) if ((BADGE_REL_TOKENS as readonly string[]).includes(String(t))) out.add(t as BadgeRelToken);
  return [...out];
}
/** `noopener` is always present; customer-chosen SEO tokens are appended. */
export const relAttr = (tokens: readonly BadgeRelToken[]) => ['noopener', ...tokens].join(' ');

/* ------------------------------ hosts & domains ------------------------------ */

const RESERVED_SUFFIXES = ['vireek.com', 'vireek.app', 'vercel.app', 'supabase.co', 'localhost', 'local', 'internal', 'example', 'invalid', 'test'];
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: string): string {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  return s.replace(/^www\./, '');
}

export function validateDomain(input: string): { ok: true; domain: string } | { ok: false; reason: string } {
  const domain = normalizeDomain(input);
  if (!DOMAIN_RE.test(domain)) return { ok: false, reason: 'Enter a domain like example.com (use punycode for non-ASCII names).' };
  if (/^\d+(\.\d+){3}$/.test(domain)) return { ok: false, reason: 'IP addresses are not supported.' };
  if (RESERVED_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`))) return { ok: false, reason: 'That domain belongs to a platform we host on. Use your own domain.' };
  return { ok: true, domain };
}

/** host "www.example.com" and "shop.example.com" match verified domain "example.com". */
export function hostAllowed(host: string, verifiedDomains: readonly string[]): boolean {
  const h = normalizeDomain(host);
  if (!h) return false;
  return verifiedDomains.some((d) => {
    const dom = normalizeDomain(d);
    return !!dom && (h === dom || h.endsWith(`.${dom}`));
  });
}

/** Browser-set Origin header -> bare host, or '' when absent / not http(s). */
export function hostFromOrigin(origin: string | null | undefined): string {
  if (!origin) return '';
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || u.protocol === 'http:' ? normalizeDomain(u.hostname) : '';
  } catch {
    return '';
  }
}

/* ------------------------------ palettes (contrast-checked in tests) ------------------------------ */

/** [background, foreground, border, accent] */
export type PaletteSet = readonly [string, string, string, string];
export const PALETTES: Record<BadgePalette, { l: PaletteSet; d: PaletteSet }> = {
  blue: { l: ['#FFFFFF', '#0F172A', '#CBD5E1', '#1D4ED8'], d: ['#0F172A', '#F8FAFC', '#334155', '#93C5FD'] },
  green: { l: ['#FFFFFF', '#0F172A', '#CBD5E1', '#047857'], d: ['#0F172A', '#F8FAFC', '#334155', '#6EE7B7'] },
  slate: { l: ['#F8FAFC', '#1E293B', '#CBD5E1', '#334155'], d: ['#1E293B', '#F1F5F9', '#475569', '#CBD5E1'] },
  mono: { l: ['#FFFFFF', '#111111', '#111111', '#111111'], d: ['#111111', '#FFFFFF', '#FFFFFF', '#FFFFFF'] },
};

export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ------------------------------ i18n (server-side only; the loader ships no strings) ------------------------------ */

interface Strings {
  tiny: string; neutral: string; calls: string; time: string; period: string;
  cardTitle: string; cardSub: string; call: string; book: string; verify: string; powered: string;
}
export const STRINGS: Record<BadgeLocale, Strings> = {
  en: { tiny: 'Calls answered 24/7 by Vireek', neutral: 'Answered by Vireek', calls: '{n} calls answered', time: 'Avg. answer time {s}', period: 'Last 30 days · as of {date}', cardTitle: 'Call or book now', cardSub: 'Answered 24/7 by Vireek', call: 'Call now', book: 'Book online', verify: 'Verify this badge (opens in a new tab)', powered: 'Powered by Vireek' },
  es: { tiny: 'Llamadas atendidas 24/7 por Vireek', neutral: 'Atendido por Vireek', calls: '{n} llamadas atendidas', time: 'Tiempo medio de respuesta {s}', period: 'Últimos 30 días · al {date}', cardTitle: 'Llama o reserva ahora', cardSub: 'Atendido 24/7 por Vireek', call: 'Llamar', book: 'Reservar en línea', verify: 'Verificar esta insignia (se abre en una pestaña nueva)', powered: 'Con tecnología de Vireek' },
  fa: { tiny: 'تماس‌ها ۲۴/۷ توسط Vireek پاسخ داده می‌شود', neutral: 'پاسخ‌گویی توسط Vireek', calls: '{n} تماس پاسخ داده شد', time: 'میانگین زمان پاسخ {s}', period: '۳۰ روز اخیر · تا {date}', cardTitle: 'همین حالا تماس بگیرید یا رزرو کنید', cardSub: 'پاسخ‌گویی ۲۴/۷ توسط Vireek', call: 'تماس', book: 'رزرو آنلاین', verify: 'تأیید این نشان (در تب جدید باز می‌شود)', powered: 'قدرت‌گرفته از Vireek' },
  ar: { tiny: 'يرد Vireek على المكالمات على مدار الساعة', neutral: 'يرد عليكم Vireek', calls: '{n} مكالمة تم الرد عليها', time: 'متوسط زمن الرد {s}', period: 'آخر 30 يومًا · حتى {date}', cardTitle: 'اتصل أو احجز الآن', cardSub: 'يرد عليكم Vireek على مدار الساعة', call: 'اتصل', book: 'احجز عبر الإنترنت', verify: 'تحقق من هذه الشارة (تفتح في علامة تبويب جديدة)', powered: 'مدعوم من Vireek' },
  fr: { tiny: 'Appels pris 24h/24 par Vireek', neutral: 'Réponse par Vireek', calls: '{n} appels pris', time: 'Délai moyen de réponse {s}', period: '30 derniers jours · au {date}', cardTitle: 'Appelez ou réservez', cardSub: 'Réponse 24h/24 par Vireek', call: 'Appeler', book: 'Réserver en ligne', verify: 'Vérifier ce badge (s’ouvre dans un nouvel onglet)', powered: 'Propulsé par Vireek' },
  de: { tiny: 'Anrufe rund um die Uhr von Vireek beantwortet', neutral: 'Beantwortet von Vireek', calls: '{n} Anrufe beantwortet', time: 'Ø Antwortzeit {s}', period: 'Letzte 30 Tage · Stand {date}', cardTitle: 'Jetzt anrufen oder buchen', cardSub: 'Rund um die Uhr von Vireek beantwortet', call: 'Anrufen', book: 'Online buchen', verify: 'Dieses Badge prüfen (öffnet in neuem Tab)', powered: 'Bereitgestellt von Vireek' },
  hi: { tiny: 'कॉल का जवाब 24/7 Vireek देता है', neutral: 'Vireek द्वारा उत्तरित', calls: '{n} कॉल का जवाब दिया गया', time: 'औसत उत्तर समय {s}', period: 'पिछले 30 दिन · {date} तक', cardTitle: 'अभी कॉल करें या बुक करें', cardSub: 'Vireek 24/7 जवाब देता है', call: 'कॉल करें', book: 'ऑनलाइन बुक करें', verify: 'इस बैज को सत्यापित करें (नए टैब में खुलता है)', powered: 'Vireek द्वारा संचालित' },
  ja: { tiny: '電話は Vireek が24時間365日対応', neutral: 'Vireek が応対', calls: '{n}件の電話に対応', time: '平均応答時間 {s}', period: '過去30日間 · {date}時点', cardTitle: '今すぐ電話・予約', cardSub: 'Vireek が24時間対応', call: '電話する', book: 'オンライン予約', verify: 'このバッジを確認（新しいタブで開きます）', powered: 'Powered by Vireek' },
  zh: { tiny: '来电由 Vireek 全天候接听', neutral: '由 Vireek 接听', calls: '已接听 {n} 个来电', time: '平均接听时间 {s}', period: '近30天 · 截至 {date}', cardTitle: '立即致电或预约', cardSub: 'Vireek 全天候接听', call: '拨打电话', book: '在线预约', verify: '验证此徽章（在新标签页中打开）', powered: '由 Vireek 提供支持' },
};

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

function fmtSeconds(ms: number, locale: BadgeLocale): string {
  const s = ms / 1000;
  if (s < 1) return locale === 'en' ? '<1s' : `<1 ${locale === 'ja' || locale === 'zh' ? '秒' : 's'}`;
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: s < 10 ? 1 : 0 }).format(s);
  return locale === 'ja' || locale === 'zh' ? `${n}秒` : `${n}s`;
}
const fmtDate = (iso: string, locale: BadgeLocale) =>
  new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

/* ------------------------------ what may the badge claim? ------------------------------ */

export interface AccountFacts {
  enabled: boolean;
  profileStatus: string; // profiles.status
  subscriptionStatus: string; // profiles.subscription_status
  hostOk: boolean;
}
export function decideState(f: AccountFacts): BadgeState {
  if (!f.enabled || !f.hostOk) return 'hidden';
  if (f.profileStatus !== 'active') return 'hidden'; // suspended / canceled / anything unknown
  if (f.subscriptionStatus === 'suspended') return 'hidden';
  if (f.subscriptionStatus === 'past_due') return 'neutral'; // keep the page tidy, make no performance claim
  return 'ok';
}

export interface StatInputs {
  metric: BadgeMetric;
  callCount: number; // qualifying calls in the window
  latestCallAt: string | null;
  timedCount: number; // calls with a measured answer time in the window
  latestTimedAt: string | null;
  avgAnswerMs: number | null;
}
export interface BadgeStat { kind: BadgeMetric; value: number; asOf: string }

/** Returns null (=> neutral text) unless the sample is large enough AND fresh. Never extrapolates. */
export function pickStat(i: StatInputs, now: Date): BadgeStat | null {
  const fresh = (iso: string | null) => !!iso && now.getTime() - Date.parse(iso) <= BADGE_FRESH_DAYS * 86_400_000 && Date.parse(iso) <= now.getTime() + 60_000;
  if (i.metric === 'answer_time') {
    if (i.timedCount < BADGE_MIN_SAMPLE || i.avgAnswerMs == null || !Number.isFinite(i.avgAnswerMs) || i.avgAnswerMs < 0 || !fresh(i.latestTimedAt)) return null;
    return { kind: 'answer_time', value: Math.round(i.avgAnswerMs), asOf: i.latestTimedAt as string };
  }
  if (i.callCount < BADGE_MIN_SAMPLE || !fresh(i.latestCallAt)) return null;
  return { kind: 'calls', value: i.callCount, asOf: i.latestCallAt as string };
}

/* ------------------------------ the view sent to the loader ------------------------------ */

export interface BadgeView {
  s: 'ok' | 'neutral';
  d: 'ltr' | 'rtl';
  l: BadgeLocale;
  t: BadgeTheme;
  v: BadgeVariant;
  p: { l: PaletteSet; d: PaletteSet };
  a: string; // full accessible name of the main link
  x: string; // main text
  y?: string; // secondary text (stat + card only)
  h: string; // verification page URL
  r: string; // rel for every link
  c?: { x: string; h: string }[]; // card actions
  w?: { x: string; h: string }; // optional "Powered by"
}

export interface ViewInput {
  state: 'ok' | 'neutral';
  variant: BadgeVariant;
  theme: BadgeTheme;
  palette: BadgePalette;
  locale: BadgeLocale;
  stat: BadgeStat | null;
  verifyHref: string;
  rel: readonly BadgeRelToken[];
  card: { phone: string | null; bookingUrl: string | null };
  poweredByHref: string | null;
}

export function buildView(i: ViewInput): BadgeView {
  const S = STRINGS[i.locale];
  const ok = i.state === 'ok';
  let x = ok ? S.tiny : S.neutral;
  let y: string | undefined;
  if (i.variant === 'stat' && ok && i.stat) {
    const val = i.stat.kind === 'calls' ? new Intl.NumberFormat(i.locale).format(i.stat.value) : fmtSeconds(i.stat.value, i.locale);
    x = fill(i.stat.kind === 'calls' ? S.calls : S.time, { n: val, s: val });
    y = fill(S.period, { date: fmtDate(i.stat.asOf, i.locale) });
  }
  const view: BadgeView = {
    s: i.state, d: isRtl(i.locale) ? 'rtl' : 'ltr', l: i.locale, t: i.theme, v: i.variant, p: PALETTES[i.palette],
    a: `${x}${y ? `. ${y}` : ''}. ${S.verify}`, x, h: i.verifyHref, r: relAttr(i.rel),
  };
  if (y) view.y = y;
  if (i.variant === 'card') {
    view.x = S.cardTitle;
    view.y = ok ? S.cardSub : S.neutral;
    view.a = `${S.cardTitle}. ${view.y}. ${S.verify}`;
    const actions: { x: string; h: string }[] = [];
    if (i.card.phone && /^\+[1-9]\d{6,14}$/.test(i.card.phone)) actions.push({ x: S.call, h: `tel:${i.card.phone}` });
    if (i.card.bookingUrl && /^https:\/\//.test(i.card.bookingUrl)) actions.push({ x: S.book, h: i.card.bookingUrl });
    if (actions.length) view.c = actions;
  }
  if (i.poweredByHref) view.w = { x: S.powered, h: i.poweredByHref };
  return view;
}

/* ------------------------------ "Powered by Vireek" link (UTM + partner attribution) ------------------------------ */

export function buildPoweredByHref(o: { appUrl: string; slug: string; variant: BadgeVariant; partnerCode: string | null }): string {
  const q = new URLSearchParams({ utm_source: 'trust_badge', utm_medium: 'embed', utm_campaign: 'powered_by', utm_content: o.variant });
  if (o.partnerCode && /^[A-Za-z0-9_-]{3,40}$/.test(o.partnerCode)) return `${o.appUrl}/r/${encodeURIComponent(o.partnerCode)}?${q}`;
  q.set('utm_term', o.slug);
  return `${o.appUrl}/?${q}`;
}

/* ------------------------------ signed tokens (HMAC-SHA256, WebCrypto: Deno, browsers, Node 20+) ------------------------------ */

export interface BadgeTokenPayload { s: string; h: string; i: number; e: number }

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hmacKey = (secret: string, usage: KeyUsage[]) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);

export async function signBadgeToken(secret: string, payload: BadgeTokenPayload): Promise<string> {
  if (secret.length < 32) throw new Error('badge signing secret too short');
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}

export type TokenCheck = { valid: true; payload: BadgeTokenPayload } | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_account' };

export async function verifyBadgeToken(secret: string, token: string, expectSlug: string, now: Date): Promise<TokenCheck> {
  if (typeof token !== 'string' || token.length > 600 || secret.length < 32) return { valid: false, reason: 'malformed' };
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { valid: false, reason: 'malformed' };
  let payload: BadgeTokenPayload;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), unb64u(sig), enc.encode(body)); // constant-time
    if (!ok) return { valid: false, reason: 'bad_signature' };
    payload = JSON.parse(new TextDecoder().decode(unb64u(body))) as BadgeTokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof payload?.s !== 'string' || typeof payload.h !== 'string' || !Number.isFinite(payload.i) || !Number.isFinite(payload.e)) return { valid: false, reason: 'malformed' };
  if (payload.s !== expectSlug) return { valid: false, reason: 'wrong_account' };
  if (now.getTime() / 1000 > payload.e || payload.i > now.getTime() / 1000 + 300) return { valid: false, reason: 'expired' };
  return { valid: true, payload };
}

/* ------------------------------ snippets (install page) ------------------------------ */

export interface SnippetOpts { origin: string; slug: string; variant: BadgeVariant; theme: BadgeTheme; size: BadgeSize; palette: BadgePalette; lang: string; sri?: string | null }

const attrs = (o: SnippetOpts) =>
  `data-slug="${o.slug}" data-variant="${o.variant}" data-theme="${o.theme}" data-size="${o.size}" data-palette="${o.palette}" data-lang="${o.lang}"`;
const srcUrl = (o: SnippetOpts) => `${o.origin}/embed/badge.v1.js`;
const sriAttrs = (o: SnippetOpts) => (o.sri ? ` integrity="${o.sri}" crossorigin="anonymous"` : '');

export function buildScriptSnippet(o: SnippetOpts): string {
  return `<script async src="${srcUrl(o)}"${sriAttrs(o)} ${attrs(o)}></script>`;
}
export function buildReactSnippet(o: SnippetOpts): string {
  const sri = o.sri ? `\n    s.integrity = '${o.sri}';\n    s.crossOrigin = 'anonymous';` : '';
  return `import { useEffect, useRef } from 'react';

export function VireekBadge() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = document.createElement('script');
    s.async = true;
    s.src = '${srcUrl(o)}';${sri}
    s.dataset.slug = '${o.slug}';
    s.dataset.variant = '${o.variant}';
    s.dataset.theme = '${o.theme}';
    s.dataset.size = '${o.size}';
    s.dataset.palette = '${o.palette}';
    s.dataset.lang = '${o.lang}';
    el.appendChild(s);
    return () => { el.replaceChildren(); };
  }, []);
  return <div ref={ref} />;
}`;
}

/** Reserved box [width, height] per variant and size. MUST equal the table in public/embed/badge.v1.js (a test enforces it). */
export const BADGE_BOX: Record<BadgeVariant, readonly [readonly [number, number], readonly [number, number], readonly [number, number]]> = {
  tiny: [[200, 28], [240, 34], [290, 42]],
  stat: [[210, 36], [250, 42], [300, 50]],
  card: [[280, 124], [320, 136], [360, 150]],
};
