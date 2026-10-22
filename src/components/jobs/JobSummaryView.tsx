// Customer-facing rendering of a job summary. Used by the public page (/summary/:token) AND the staff
// editor preview, so staff see exactly what the customer will see.
import { CalendarClock, ImageOff, Lightbulb, ShieldCheck, Wrench } from 'lucide-react';
import { formatDateLong, warrantyStatus } from '@/lib/jobSummaries';

export interface SummaryViewData {
  business_name: string | null;
  business_phone?: string | null;
  headline: string;
  intro: string;
  work_summary: string;
  work_items: string[];
  parts: { name: string; quantity: number }[];
  warranty: { label: string; expires_on: string | null; note: string | null }[];
  maintenance_tips: string[];
  next_service_date: string | null;
  next_service_note: string | null;
  service_date: string | null;
  updated_at?: string | null;
  photos: { url: string | null; kind: 'before' | 'after' | 'progress'; caption: string | null }[];
}

const KIND_LABEL = { before: 'Before', after: 'After', progress: 'During' } as const;

function Section({ icon: Icon, title, children }: { icon: typeof Wrench; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Icon size={16} className="text-accent" aria-hidden="true" /> {title}
      </h2>
      <div className="mt-3 text-sm leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

export function JobSummaryView({ data, todayISO }: { data: SummaryViewData; todayISO: string }) {
  return (
    <article className="space-y-4">
      <header>
        {data.business_name && <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{data.business_name}</p>}
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-text-primary">{data.headline}</h1>
        {data.service_date && <p className="mt-1 text-sm text-text-secondary">{formatDateLong(data.service_date)}</p>}
        {data.intro && <p className="mt-3 text-sm leading-relaxed text-text-primary">{data.intro}</p>}
        {data.updated_at && <p className="mt-2 text-xs text-text-secondary">Updated {new Date(data.updated_at).toLocaleDateString()}</p>}
      </header>

      {(data.work_summary || data.work_items.length > 0) && (
        <Section icon={Wrench} title="What we did">
          {data.work_summary && <p className="text-text-primary">{data.work_summary}</p>}
          {data.work_items.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.work_items.map((i, idx) => (
                <li key={idx}>{i}</li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {data.photos.some((p) => p.url) && (
        <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-label="Photos">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.photos.map((p, idx) => (
              <figure key={idx} className="overflow-hidden rounded-xl border border-border/60">
                {p.url ? (
                  <img src={p.url} alt={p.caption || `${KIND_LABEL[p.kind]} photo`} loading="lazy" className="aspect-square w-full object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-bg-tertiary text-text-secondary">
                    <ImageOff size={20} aria-hidden="true" />
                  </div>
                )}
                <figcaption className="px-2 py-1.5 text-xs text-text-secondary">
                  <span className="font-medium text-text-primary">{KIND_LABEL[p.kind]}</span>
                  {p.caption ? ` · ${p.caption}` : ''}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {data.parts.length > 0 && (
        <Section icon={Wrench} title="Parts used">
          <ul className="space-y-1">
            {data.parts.map((p, idx) => (
              <li key={idx}>
                <span className="font-medium text-text-primary">{p.quantity} ×</span> {p.name}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.warranty.length > 0 && (
        <Section icon={ShieldCheck} title="Warranty">
          <ul className="space-y-2">
            {data.warranty.map((w, idx) => {
              const st = warrantyStatus(w.expires_on, todayISO);
              return (
                <li key={idx}>
                  <span className="font-medium text-text-primary">{w.label}</span>
                  {w.expires_on && (
                    <span className={st === 'expired' ? ' text-warning-500' : ' text-success-500'}>
                      {' '}
                      — {st === 'expired' ? 'expired' : 'covered through'} {formatDateLong(w.expires_on)}
                    </span>
                  )}
                  {w.note && <span className="block">{w.note}</span>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {data.maintenance_tips.length > 0 && (
        <Section icon={Lightbulb} title="Keeping it running well">
          <ul className="list-disc space-y-1 pl-5">
            {data.maintenance_tips.map((t, idx) => (
              <li key={idx}>{t}</li>
            ))}
          </ul>
        </Section>
      )}

      {data.next_service_date && (
        <Section icon={CalendarClock} title="Next service">
          <p>
            <span className="font-semibold text-text-primary">{formatDateLong(data.next_service_date)}</span>
            {data.next_service_note ? ` — ${data.next_service_note}` : ''}
          </p>
          {data.business_phone && (
            <p className="mt-2">
              To book, call{' '}
              <a href={`tel:${data.business_phone}`} className="font-medium text-accent underline">
                {data.business_phone}
              </a>
              .
            </p>
          )}
        </Section>
      )}
    </article>
  );
}
