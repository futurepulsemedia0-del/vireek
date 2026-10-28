// Client API + pure helpers for the Marketing Creative Studio
// (/dashboard/marketing/creative).
// Backend: supabase/functions/marketing-creative-generate (runs as the signed-in
// user; copy via the shared Vireek AI router, image via Gemini). Schema:
// supabase/migrations/20280101000000_marketing_creative_studio.sql.
// Pure rules (formats, limits, validation, claim + SEO checks) live in the shared
// engine so client and server can never disagree.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  FORMAT_BY_ID,
  LIMITS,
  reviewIsUsable,
  validateRequest,
  type ArticleFaq,
  type CreativeFormat,
  type CreativeRow,
  type CreativeStatus,
  type GenerateRequest,
} from '../../supabase/functions/_shared/marketing-creative/engine';

export {
  FORMATS,
  FORMAT_BY_ID,
  GOALS,
  LIMITS,
  MAX_GENERATIONS_PER_HOUR,
  TONES,
  claimWarnings,
  reviewIsUsable,
  seoChecks,
  validateRequest,
  wordCount,
  type ArticleFaq,
  type ClaimWarning,
  type CreativeFormat,
  type CreativeGoal,
  type CreativeKind,
  type CreativeRow,
  type CreativeStatus,
  type CreativeTone,
  type FormatMeta,
  type GenerateRequest,
  type SourceType,
} from '../../supabase/functions/_shared/marketing-creative/engine';

const BUCKET = 'marketing-creatives';
const CALENDAR_TABLE = 'content_calendar_items';

// ---------------------------------------------------------------
// Types for the "source" pickers
// ---------------------------------------------------------------

export interface SourceJob {
  id: string;
  service_type: string | null;
  completed_at: string | null;
  scheduled_datetime: string | null;
}

export interface SourceReview {
  id: string;
  platform: string;
  rating: number;
  body: string | null;
  reviewed_at: string;
}

export interface BrandColors {
  primary: string;
  accent: string;
}

export const DEFAULT_BRAND: BrandColors = { primary: '#2563EB', accent: '#0EA5E9' };

export type CalendarChannel = 'facebook' | 'instagram' | 'google_business' | 'linkedin' | 'nextdoor' | 'tiktok' | 'blog' | 'other';

export const CALENDAR_CHANNELS: { id: CalendarChannel; label: string }[] = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'google_business', label: 'Google Business' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'nextdoor', label: 'Nextdoor' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'blog', label: 'Blog' },
  { id: 'other', label: 'Other' },
];

// ---------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
    if (body?.error) return body.error;
  }
  return fallback;
}

export async function generateCreative(req: GenerateRequest): Promise<CreativeRow> {
  const checked = validateRequest(req);
  if (!checked.ok) throw new Error(checked.error);
  const { data, error } = await supabase.functions.invoke('marketing-creative-generate', { body: checked.value });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not reach the creative studio. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.error));
  if (!data?.creative) throw new Error('The studio returned an empty result. Please try again.');
  return data.creative as CreativeRow;
}

export async function fetchCreatives(ownerId: string): Promise<CreativeRow[]> {
  const { data, error } = await supabase
    .from('marketing_creatives')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as CreativeRow[];
}

export async function fetchSourceJobs(ownerId: string): Promise<SourceJob[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, service_type, completed_at, scheduled_datetime')
    .eq('user_id', ownerId)
    .eq('job_status', 'completed')
    .order('scheduled_datetime', { ascending: false, nullsFirst: false })
    .limit(40);
  if (error) throw new Error(error.message);
  return (data ?? []) as SourceJob[];
}

export async function fetchSourceReviews(ownerId: string): Promise<SourceReview[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select('id, platform, rating, body, reviewed_at')
    .eq('user_id', ownerId)
    .gte('rating', LIMITS.minReviewRating)
    .not('body', 'is', null)
    .order('reviewed_at', { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  return ((data ?? []) as SourceReview[]).filter((r) => reviewIsUsable(r.rating, r.body));
}

export async function fetchBrandColors(ownerId: string): Promise<BrandColors> {
  const { data } = await supabase.from('brand_settings').select('primary_color, accent_color').eq('user_id', ownerId).maybeSingle();
  const row = data as { primary_color?: string; accent_color?: string } | null;
  return {
    primary: isHexColor(row?.primary_color) ? row!.primary_color! : DEFAULT_BRAND.primary,
    accent: isHexColor(row?.accent_color) ? row!.accent_color! : DEFAULT_BRAND.accent,
  };
}

export async function signedImageUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export type CreativePatch = Partial<
  Pick<CreativeRow, 'title' | 'headline' | 'caption' | 'cta' | 'hashtags' | 'body' | 'meta_title' | 'meta_description' | 'slug' | 'keywords' | 'status'>
>;

export async function updateCreative(id: string, ownerId: string, patch: CreativePatch): Promise<CreativeRow> {
  const { data, error } = await supabase.from('marketing_creatives').update(patch).eq('id', id).eq('user_id', ownerId).select('*').single();
  if (error || !data) throw new Error(error?.message ?? 'Could not save your changes.');
  return data as CreativeRow;
}

export async function deleteCreative(c: CreativeRow, ownerId: string): Promise<void> {
  const { error } = await supabase.from('marketing_creatives').delete().eq('id', c.id).eq('user_id', ownerId);
  if (error) throw new Error(error.message);
  // Best-effort: an orphaned file is harmless, a failed delete must not block the UI.
  if (c.image_path) await supabase.storage.from(BUCKET).remove([c.image_path]).catch(() => undefined);
}

export async function addToCalendar(c: CreativeRow, ownerId: string, channel: CalendarChannel, scheduledAt: string | null): Promise<string> {
  const payload = { ...buildCalendarPayload(c, channel, scheduledAt), user_id: ownerId };
  const { data, error } = await supabase.from(CALENDAR_TABLE).insert(payload).select('id').single();
  if (error || !data) throw new Error(error?.message ?? 'Could not add to the calendar.');
  const calendarId = (data as { id: string }).id;
  await supabase.from('marketing_creatives').update({ calendar_item_id: calendarId }).eq('id', c.id).eq('user_id', ownerId);
  return calendarId;
}

// ---------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function contrastText(hex: string): '#000000' | '#FFFFFF' {
  if (!isHexColor(hex)) return '#FFFFFF';
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum > 0.4 ? '#000000' : '#FFFFFF';
}

/** Greedy word-wrap. `measure` returns the rendered width of a string. Overflow is ellipsized. */
export function wrapText(measure: (s: string) => number, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (measure(next) <= maxWidth || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = words[i];
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

export interface Layout {
  width: number;
  height: number;
  margin: number;
  safeTop: number;
  safeBottom: number;
  headlineSize: number;
  ctaSize: number;
  brandSize: number;
  maxHeadlineLines: number;
}

/** Story/Reel covers keep clear of the platform UI zones at the top and bottom. */
export function computeLayout(format: CreativeFormat): Layout {
  const { width, height } = FORMAT_BY_ID[format];
  const story = format === 'social_story';
  return {
    width,
    height,
    margin: Math.round(width * 0.07),
    safeTop: story ? 220 : 0,
    safeBottom: story ? 300 : 0,
    headlineSize: Math.round(width * (story ? 0.075 : format === 'ad_landscape' ? 0.05 : 0.066)),
    ctaSize: Math.round(width * (format === 'ad_landscape' ? 0.026 : 0.034)),
    brandSize: Math.round(width * 0.026),
    maxHeadlineLines: format === 'ad_landscape' ? 2 : 3,
  };
}

export interface ComposeInput {
  imageUrl: string;
  format: CreativeFormat;
  headline: string;
  cta: string;
  businessName: string;
  brand: BrandColors;
}

/** Browser-only: draws the AI photo + real, crisp headline/CTA/brand → PNG blob. */
export async function composeCreativeImage(input: ComposeInput): Promise<Blob> {
  const res = await fetch(input.imageUrl);
  if (!res.ok) throw new Error('Could not load the image.');
  const objectUrl = URL.createObjectURL(await res.blob());
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read the image.'));
      el.src = objectUrl;
    });
    const L = computeLayout(input.format);
    const canvas = document.createElement('canvas');
    canvas.width = L.width;
    canvas.height = L.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot compose images.');

    // cover-fit
    const scale = Math.max(L.width / img.naturalWidth, L.height / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, (L.width - dw) / 2, (L.height - dh) / 2, dw, dh);

    // bottom scrim for legibility
    const scrimTop = L.height * 0.45;
    const grad = ctx.createLinearGradient(0, scrimTop, 0, L.height);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, scrimTop, L.width, L.height - scrimTop);

    const font = (size: number, weight: number) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

    // brand chip (top-left)
    if (input.businessName) {
      ctx.font = font(L.brandSize, 700);
      const label = input.businessName.toUpperCase();
      const pad = Math.round(L.brandSize * 0.7);
      const w = ctx.measureText(label).width + pad * 2;
      const h = L.brandSize + pad * 1.2;
      const x = L.margin;
      const y = L.margin + L.safeTop;
      ctx.fillStyle = input.brand.primary;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = contrastText(input.brand.primary);
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + pad, y + h / 2 + 1);
    }

    // CTA pill (anchored bottom), headline above it
    ctx.font = font(L.ctaSize, 700);
    const ctaPadX = Math.round(L.ctaSize * 1.1);
    const ctaH = Math.round(L.ctaSize * 2.1);
    const ctaW = ctx.measureText(input.cta).width + ctaPadX * 2;
    const ctaX = L.margin;
    const ctaY = L.height - L.margin - L.safeBottom - ctaH;

    ctx.font = font(L.headlineSize, 800);
    const lines = wrapText((s) => ctx.measureText(s).width, input.headline, L.width - L.margin * 2, L.maxHeadlineLines);
    const lineH = Math.round(L.headlineSize * 1.15);
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = Math.round(L.headlineSize * 0.2);
    const blockTop = ctaY - Math.round(L.ctaSize * 1.2) - lines.length * lineH;
    lines.forEach((line, i) => ctx.fillText(line, L.margin, blockTop + (i + 1) * lineH - Math.round(L.headlineSize * 0.2)));
    ctx.shadowBlur = 0;

    ctx.fillStyle = input.brand.accent;
    ctx.beginPath();
    ctx.roundRect(ctaX, ctaY, ctaW, ctaH, ctaH / 2);
    ctx.fill();
    ctx.fillStyle = contrastText(input.brand.accent);
    ctx.font = font(L.ctaSize, 700);
    ctx.textBaseline = 'middle';
    ctx.fillText(input.cta, ctaX + ctaPadX, ctaY + ctaH / 2 + 1);

    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the image.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ---------------------------------------------------------------
// Article rendering / export
// ---------------------------------------------------------------

export type MdBlock = { type: 'h2' | 'h3' | 'p'; text: string } | { type: 'ul' | 'ol'; items: string[] };

/** Removes inline Markdown so it can be rendered as plain text safely. */
export function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export function parseMarkdownBlocks(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', text: stripInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push(list);
    list = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ type: h[1].length <= 2 ? 'h2' : 'h3', text: stripInline(h[2]) });
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(stripInline((ul ?? ol)![1]));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Clean, dependency-free HTML ready to paste into any CMS (WordPress, Webflow, …). */
export function articleToHtml(a: { title: string; body: string; faq: ArticleFaq[] }): string {
  const out: string[] = [`<h1>${escapeHtml(a.title)}</h1>`];
  for (const b of parseMarkdownBlocks(a.body)) {
    if (b.type === 'ul' || b.type === 'ol') out.push(`<${b.type}>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${b.type}>`);
    else out.push(`<${b.type}>${escapeHtml(b.text)}</${b.type}>`);
  }
  if (a.faq.length) {
    out.push('<h2>Frequently asked questions</h2>');
    for (const f of a.faq) out.push(`<h3>${escapeHtml(f.q)}</h3>`, `<p>${escapeHtml(f.a)}</p>`);
  }
  return out.join('\n');
}

/** schema.org FAQPage JSON-LD (safe to embed in a <script type="application/ld+json">). */
export function faqJsonLd(faq: ArticleFaq[]): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
  return JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
}

export function captionWithHashtags(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((h) => `#${h.replace(/^#+/, '')}`).join(' ');
  return tags ? `${caption}\n\n${tags}` : caption;
}

// ---------------------------------------------------------------
// Content Calendar hand-off
// ---------------------------------------------------------------

export function defaultChannel(format: CreativeFormat): CalendarChannel {
  switch (format) {
    case 'social_story':
    case 'social_portrait':
      return 'instagram';
    case 'blog_post':
    case 'seo_local_page':
      return 'blog';
    default:
      return 'facebook';
  }
}

export function buildCalendarPayload(c: CreativeRow, channel: CalendarChannel, scheduledAt: string | null) {
  const isArticle = c.kind === 'article';
  const body = isArticle
    ? [c.meta_description ?? '', 'Full article is in Marketing Creative Studio.'].filter(Boolean).join('\n\n')
    : captionWithHashtags(c.caption ?? '', c.hashtags);
  const contentType = isArticle ? 'article' : c.format === 'social_story' ? 'story' : c.format === 'ad_landscape' ? 'ad' : 'post';
  return {
    title: c.title.slice(0, 160),
    body: body.slice(0, 5000),
    channel,
    content_type: contentType,
    status: 'draft' as const,
    scheduled_at: scheduledAt,
    tags: (isArticle ? c.keywords : c.hashtags).slice(0, 10),
  };
}

export function creativeFilename(c: Pick<CreativeRow, 'title' | 'format' | 'id'>, ext: string): string {
  const base = c.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'creative'}-${c.format}-${c.id.slice(0, 6)}.${ext}`;
}

export const STATUS_LABEL: Record<CreativeStatus, string> = { ready: 'Draft', approved: 'Approved', archived: 'Archived' };
