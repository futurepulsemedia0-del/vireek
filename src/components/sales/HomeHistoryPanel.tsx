import { useState } from 'react';
import { Camera, History, Wrench, X } from 'lucide-react';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { PHOTO_KIND_LABELS, type EstimatePhoto } from '@/lib/estimates';
import { equipmentAgeYears, money, type PresentationEquipment, type PresentationHistoryItem, type PresentationJobPhoto } from '@/lib/inHomeSales';

interface Props {
  equipment: PresentationEquipment[];
  history: PresentationHistoryItem[];
  estimatePhotos: EstimatePhoto[];
  jobPhotos: PresentationJobPhoto[];
  /** storage_path -> signed URL (private bucket). Missing = still loading / unavailable. */
  signedUrls: Map<string, string>;
}

interface Shot {
  key: string;
  url: string;
  caption: string;
  label: string;
}

function dateLabel(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

function Lightbox({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={shot.caption || 'Photo'}>
      <div ref={ref} className="relative max-h-full w-full max-w-4xl">
        <button type="button" onClick={onClose} aria-label="Close photo" className="focus-ring absolute right-2 top-2 rounded-full bg-black/60 p-2 text-white">
          <X size={20} />
        </button>
        <img src={shot.url} alt={shot.caption || shot.label} className="max-h-[85vh] w-full rounded-xl object-contain" />
        {(shot.caption || shot.label) && <p className="mt-2 text-center text-sm text-white">{shot.caption || shot.label}</p>}
      </div>
    </div>
  );
}

/** What is in the home today: equipment age vs lifespan, past visits, and photos (estimate + customer gallery). */
export function HomeHistoryPanel({ equipment, history, estimatePhotos, jobPhotos, signedUrls }: Props) {
  const [open, setOpen] = useState<Shot | null>(null);

  const shots: Shot[] = [
    ...estimatePhotos.map((p) => ({ key: `e-${p.id}`, url: p.url, caption: p.caption, label: PHOTO_KIND_LABELS[p.kind] })),
    ...jobPhotos.flatMap((p) => {
      const url = signedUrls.get(p.storage_path);
      return url ? [{ key: `j-${p.id}`, url, caption: p.caption ?? '', label: 'Previous visit' }] : [];
    }),
  ];

  return (
    <div className="space-y-6">
      <section aria-label="Equipment" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Wrench size={16} aria-hidden="true" /> Equipment in this home</h3>
        {equipment.length === 0 ? (
          <p className="text-sm text-text-secondary">No equipment on file for this customer yet.</p>
        ) : (
          <ul className="space-y-4">
            {equipment.map((e) => {
              const age = equipmentAgeYears(e.install_date);
              const pct = age === null ? null : Math.min(100, Math.round((age / Math.max(1, e.expected_lifespan_years)) * 100));
              return (
                <li key={e.id}>
                  <p className="font-medium text-text-primary">{[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}</p>
                  <p className="text-sm text-text-secondary">
                    {e.equipment_type}
                    {e.serial_number ? ` · S/N ${e.serial_number}` : ''}
                    {e.warranty_expires_at ? ` · Warranty until ${dateLabel(e.warranty_expires_at)}` : ''}
                  </p>
                  {pct !== null && age !== null && (
                    <div className="mt-2">
                      <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${age} of ${e.expected_lifespan_years} expected years used`}>
                        <div className={`h-full rounded-full ${pct >= 85 ? 'bg-danger' : pct >= 60 ? 'bg-warning-500' : 'bg-success-500'}`} style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">{age} yrs old of ~{e.expected_lifespan_years} expected{e.last_service_date ? ` · last serviced ${dateLabel(e.last_service_date)}` : ''}</p>
                    </div>
                  )}
                  {e.notes && <p className="mt-1 text-xs italic text-text-secondary">{e.notes}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Service history" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><History size={16} aria-hidden="true" /> Service history</h3>
        {history.length === 0 ? (
          <p className="text-sm text-text-secondary">No previous visits on file.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-text-primary">{h.service_type || 'Service visit'}<span className="text-text-secondary"> · {dateLabel(h.date)}</span></span>
                {h.invoice_amount ? <span className="text-text-secondary">{money(Math.round(h.invoice_amount * 100))}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Photos" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Camera size={16} aria-hidden="true" /> Photos</h3>
        {shots.length === 0 ? (
          <p className="text-sm text-text-secondary">No photos yet for this home.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shots.map((s) => (
              <li key={s.key}>
                <button type="button" onClick={() => setOpen(s)} className="focus-ring group block w-full overflow-hidden rounded-xl border border-border text-left">
                  <img src={s.url} alt={s.caption || s.label} loading="lazy" className="aspect-[4/3] w-full object-cover transition-transform group-hover:scale-105" />
                  <span className="block truncate px-2 py-1.5 text-xs text-text-secondary">{s.caption || s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {open && <Lightbox shot={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
