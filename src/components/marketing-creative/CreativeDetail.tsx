import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarPlus, Check, CheckCircle2, Copy, Download, ImageOff, TriangleAlert, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  CALENDAR_CHANNELS,
  FORMAT_BY_ID,
  LIMITS,
  STATUS_LABEL,
  articleToHtml,
  captionWithHashtags,
  composeCreativeImage,
  creativeFilename,
  defaultChannel,
  faqJsonLd,
  parseMarkdownBlocks,
  seoChecks,
  wordCount,
  type BrandColors,
  type CalendarChannel,
  type CreativePatch,
  type CreativeRow,
} from '@/lib/marketingCreative';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

interface Props {
  creative: CreativeRow;
  imageUrl: string | null;
  businessName: string;
  brand: BrandColors;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: CreativePatch) => Promise<boolean>;
  onAddToCalendar: (channel: CalendarChannel, scheduledAt: string | null) => Promise<boolean>;
  onDelete: () => void;
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const tagsToString = (tags: string[]) => tags.join(', ');
const stringToTags = (s: string, max: number) =>
  [...new Set(s.split(/[,\n]/).map((t) => t.trim().replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean))].slice(0, max);

export function CreativeDetail({ creative: c, imageUrl, businessName, brand, busy, onClose, onSave, onAddToCalendar, onDelete, onNotify }: Props) {
  const uid = useId();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const isImage = c.kind === 'image';
  const meta = FORMAT_BY_ID[c.format];

  // ---------- editable fields ----------
  const [title, setTitle] = useState(c.title);
  const [headline, setHeadline] = useState(c.headline ?? '');
  const [caption, setCaption] = useState(c.caption ?? '');
  const [cta, setCta] = useState(c.cta ?? '');
  const [hashtags, setHashtags] = useState(tagsToString(c.hashtags));
  const [body, setBody] = useState(c.body ?? '');
  const [metaTitle, setMetaTitle] = useState(c.meta_title ?? '');
  const [metaDescription, setMetaDescription] = useState(c.meta_description ?? '');
  const [slug, setSlug] = useState(c.slug ?? '');
  const [keywords, setKeywords] = useState(tagsToString(c.keywords));
  const [tab, setTab] = useState<'preview' | 'edit' | 'seo' | 'export'>('preview');

  const dirty = isImage
    ? headline !== (c.headline ?? '') || caption !== (c.caption ?? '') || cta !== (c.cta ?? '') || hashtags !== tagsToString(c.hashtags)
    : title !== c.title || body !== (c.body ?? '') || metaTitle !== (c.meta_title ?? '') || metaDescription !== (c.meta_description ?? '') || slug !== (c.slug ?? '') || keywords !== tagsToString(c.keywords);

  // ---------- composed image preview (debounced, canvas) ----------
  const [composedUrl, setComposedUrl] = useState<string | null>(null);
  const [composeError, setComposeError] = useState(false);
  const composedBlob = useRef<Blob | null>(null);
  const composedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isImage || !imageUrl) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const blob = await composeCreativeImage({
          imageUrl,
          format: c.format,
          headline: headline.trim() || c.title,
          cta: cta.trim() || 'Book now',
          businessName,
          brand,
        });
        if (cancelled) return;
        composedBlob.current = blob;
        if (composedUrlRef.current) URL.revokeObjectURL(composedUrlRef.current);
        composedUrlRef.current = URL.createObjectURL(blob);
        setComposedUrl(composedUrlRef.current);
        setComposeError(false);
      } catch {
        if (!cancelled) setComposeError(true);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [isImage, imageUrl, c.format, c.title, headline, cta, businessName, brand]);
  useEffect(
    () => () => {
      if (composedUrlRef.current) URL.revokeObjectURL(composedUrlRef.current);
    },
    [],
  );

  // ---------- calendar ----------
  const [channel, setChannel] = useState<CalendarChannel>(defaultChannel(c.format));
  const [when, setWhen] = useState('');

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify(`${label} copied.`, 'success');
    } catch {
      onNotify('Could not copy. Select the text and copy it manually.', 'error');
    }
  };

  const save = async () => {
    const patch: CreativePatch = isImage
      ? {
          title: headline.trim() || c.title,
          headline: headline.trim().slice(0, 120) || null,
          caption: caption.trim().slice(0, LIMITS.caption) || null,
          cta: cta.trim().slice(0, 60) || null,
          hashtags: stringToTags(hashtags, LIMITS.hashtags),
        }
      : {
          title: title.trim() || c.title,
          body: body.trim() || c.body,
          meta_title: metaTitle.trim() || null,
          meta_description: metaDescription.trim() || null,
          slug: slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || null,
          keywords: stringToTags(keywords, LIMITS.keywords),
        };
    await onSave(patch);
  };

  const article = useMemo(
    () => ({ title, metaTitle, metaDescription, keywords: stringToTags(keywords, LIMITS.keywords), bodyMarkdown: body }),
    [title, metaTitle, metaDescription, keywords, body],
  );
  const checks = useMemo(() => (isImage ? [] : seoChecks(article)), [isImage, article]);
  const blocks = useMemo(() => (isImage ? [] : parseMarkdownBlocks(body)), [isImage, body]);

  const approved = c.status === 'approved';
  const scheduledIso = when ? new Date(when).toISOString() : null;

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="fixed inset-x-0 bottom-0 z-[101] max-h-[94vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(60rem,94vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6 dark:shadow-card-hover-dark"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${uid}-title`} className="truncate text-lg font-semibold text-text-primary">
              {c.title}
            </h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              {meta.label} · {STATUS_LABEL[c.status]}
              {c.calendar_item_id ? ' · On your calendar' : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -m-2 rounded-lg p-2 text-text-secondary hover:text-text-primary">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {c.warnings.length > 0 && (
          <div role="note" className="mb-4 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
            <p className="mb-1 flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4 shrink-0 text-warning-500" aria-hidden /> Check before you publish
            </p>
            <ul className="list-disc space-y-0.5 pl-9 text-text-secondary">
              {c.warnings.map((w) => (
                <li key={w.id}>{w.label}</li>
              ))}
            </ul>
          </div>
        )}

        {isImage ? (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <div className="overflow-hidden rounded-xl border border-border bg-bg-tertiary">
                {!imageUrl || composeError ? (
                  <div className="flex aspect-square flex-col items-center justify-center gap-2 p-6 text-center text-sm text-text-secondary">
                    <ImageOff className="h-8 w-8" aria-hidden />
                    {composeError ? 'The preview could not be composed. You can still download the original image.' : 'Image unavailable.'}
                  </div>
                ) : composedUrl ? (
                  <img src={composedUrl} alt={`Preview: ${headline || c.title}`} className="mx-auto max-h-[60vh] w-auto max-w-full object-contain" />
                ) : (
                  <Skeleton className="aspect-square w-full" />
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={!composedBlob.current || !composedUrl} onClick={() => composedBlob.current && download(composedBlob.current, creativeFilename(c, 'png'))}>
                  <Download className="h-4 w-4" aria-hidden /> Download ad (PNG)
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!imageUrl}
                  onClick={async () => {
                    try {
                      const r = await fetch(imageUrl!);
                      download(await r.blob(), creativeFilename(c, 'png').replace('.png', '-photo.png'));
                    } catch {
                      onNotify('Could not download the photo.', 'error');
                    }
                  }}
                >
                  <Download className="h-4 w-4" aria-hidden /> Photo only
                </Button>
              </div>
              <p className="mt-2 text-xs text-text-secondary">
                The photo is AI-generated. The headline, button and brand name are added by Vireek so the text is always crisp and correct. Disclose AI imagery where a platform requires it.
              </p>
            </div>

            <div className="space-y-3">
              <Input label="Headline" value={headline} maxLength={LIMITS.headline} onChange={(e) => setHeadline(e.target.value)} />
              <Input label="Button text" value={cta} maxLength={LIMITS.cta} onChange={(e) => setCta(e.target.value)} />
              <Textarea label="Caption" rows={6} value={caption} maxLength={LIMITS.caption} onChange={(e) => setCaption(e.target.value)} helperText={`${caption.length}/${LIMITS.caption}`} />
              <Input label="Hashtags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} helperText="Comma separated, without #" />
              {c.quote && (
                <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">
                  <span className="font-medium text-text-primary">Real customer quote you can feature: </span>“{c.quote}”
                </p>
              )}
              <Button size="sm" variant="secondary" onClick={() => void copy(captionWithHashtags(caption, stringToTags(hashtags, LIMITS.hashtags)), 'Caption')}>
                <Copy className="h-4 w-4" aria-hidden /> Copy caption + hashtags
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <div role="tablist" aria-label="Article sections" className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-bg-tertiary p-1">
              {(
                [
                  ['preview', 'Preview'],
                  ['edit', 'Edit'],
                  ['seo', `SEO ${checks.filter((x) => x.ok).length}/${checks.length}`],
                  ['export', 'Export'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`focus-ring min-h-[36px] flex-1 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-colors ${
                    tab === key ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'preview' && (
              <article className="mx-auto max-w-2xl space-y-3">
                <h3 className="text-2xl font-bold text-text-primary">{title}</h3>
                <p className="text-xs text-text-secondary">{wordCount(body)} words</p>
                {blocks.map((b, i) =>
                  b.type === 'h2' ? (
                    <h4 key={i} className="pt-2 text-lg font-semibold text-text-primary">{b.text}</h4>
                  ) : b.type === 'h3' ? (
                    <h5 key={i} className="font-semibold text-text-primary">{b.text}</h5>
                  ) : b.type === 'p' ? (
                    <p key={i} className="text-sm leading-relaxed text-text-secondary">{b.text}</p>
                  ) : b.type === 'ul' ? (
                    <ul key={i} className="list-disc space-y-1 pl-5 text-sm text-text-secondary">{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>
                  ) : (
                    <ol key={i} className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">{b.items.map((it, j) => <li key={j}>{it}</li>)}</ol>
                  ),
                )}
                {c.faq.length > 0 && (
                  <div className="space-y-2 border-t border-border pt-3">
                    <h4 className="text-lg font-semibold text-text-primary">Frequently asked questions</h4>
                    {c.faq.map((f, i) => (
                      <div key={i}>
                        <h5 className="font-semibold text-text-primary">{f.q}</h5>
                        <p className="text-sm text-text-secondary">{f.a}</p>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )}

            {tab === 'edit' && (
              <div className="space-y-3">
                <Input label="Title (H1)" value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="SEO title" value={metaTitle} maxLength={LIMITS.metaTitle} onChange={(e) => setMetaTitle(e.target.value)} helperText={`${metaTitle.length} characters · aim for 30–60`} />
                  <Input label="URL slug" value={slug} maxLength={LIMITS.slug} onChange={(e) => setSlug(e.target.value)} />
                </div>
                <Textarea label="Meta description" rows={3} value={metaDescription} maxLength={LIMITS.metaDescription} onChange={(e) => setMetaDescription(e.target.value)} helperText={`${metaDescription.length} characters · aim for 70–160`} />
                <Input label="Keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} helperText="Comma separated — the first one is the primary keyword" />
                <Textarea label="Article (Markdown)" rows={16} value={body} maxLength={30000} onChange={(e) => setBody(e.target.value)} />
              </div>
            )}

            {tab === 'seo' && (
              <div className="space-y-2">
                {checks.map((chk) => (
                  <p key={chk.id} className="flex items-start gap-2 text-sm text-text-primary">
                    {chk.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-500" aria-hidden /> : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-500" aria-hidden />}
                    <span>
                      {chk.label}
                      <span className="sr-only">{chk.ok ? ' — passed' : ' — needs attention'}</span>
                    </span>
                  </p>
                ))}
                <p className="pt-2 text-xs text-text-secondary">These checks cover page structure only. They do not predict search rankings.</p>
              </div>
            )}

            {tab === 'export' && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => void copy(articleToHtml({ title, body, faq: c.faq }), 'HTML')}>
                  <Copy className="h-4 w-4" aria-hidden /> Copy HTML
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void copy(`# ${title}\n\n${body}`, 'Markdown')}>
                  <Copy className="h-4 w-4" aria-hidden /> Copy Markdown
                </Button>
                {c.faq.length > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => void copy(`<script type="application/ld+json">\n${faqJsonLd(c.faq)}\n</script>`, 'FAQ schema')}>
                    <Copy className="h-4 w-4" aria-hidden /> Copy FAQ schema (JSON-LD)
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => download(new Blob([`# ${title}\n\n${body}\n`], { type: 'text/markdown' }), creativeFilename(c, 'md'))}>
                  <Download className="h-4 w-4" aria-hidden /> Download .md
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Calendar hand-off */}
        <div className="mt-5 rounded-xl border border-border p-3">
          <p className="mb-2 text-sm font-medium text-text-primary">{c.calendar_item_id ? 'Already on your Content Calendar' : 'Add to Content Calendar'}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-48">
              <label htmlFor={`${uid}-ch`} className="mb-1 block text-xs font-medium text-text-secondary">Channel</label>
              <select id={`${uid}-ch`} className={selectClass} value={channel} onChange={(e) => setChannel(e.target.value as CalendarChannel)}>
                {CALENDAR_CHANNELS.map((ch) => (
                  <option key={ch.id} value={ch.id}>{ch.label}</option>
                ))}
              </select>
            </div>
            <div className="sm:w-60">
              <Input label="Schedule (optional)" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
            <Button size="md" variant="secondary" disabled={busy} onClick={() => void onAddToCalendar(channel, scheduledIso)}>
              <CalendarPlus className="h-4 w-4" aria-hidden /> {c.calendar_item_id ? 'Add another' : 'Add as draft'}
            </Button>
          </div>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="ghost" size="sm" className="text-danger" disabled={busy} onClick={onDelete}>
            <Trash2 className="h-4 w-4" aria-hidden /> Delete
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="secondary" disabled={busy} onClick={() => void onSave({ status: approved ? 'ready' : 'approved' })}>
              <Check className="h-4 w-4" aria-hidden /> {approved ? 'Mark as draft' : 'Approve'}
            </Button>
            <Button disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
