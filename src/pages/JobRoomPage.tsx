import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  FileText,
  MapPin,
  ShieldCheck,
  Stethoscope,
  User,
  Wrench,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { minutesRemaining } from '@/lib/liveTracking';
import { formatWarrantyStatus, formatPortalDate } from '@/lib/customerPortal';
import {
  fetchJobRoom,
  jobRoomPhotoUrl,
  buildJobRoomTimeline,
  quoteTotalCents,
  type JobRoom,
} from '@/lib/jobRoom';

const POLL_MS = 20000;

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatAmount(amount: number | null): string {
  if (amount === null) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function TimelineIcon({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') return <CheckCircle2 size={18} className="text-success-500 shrink-0" />;
  if (state === 'active') return <span className="relative shrink-0 flex h-[18px] w-[18px] items-center justify-center"><span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-accent/60" /><span className="relative h-2.5 w-2.5 rounded-full bg-accent" /></span>;
  return <Circle size={18} className="text-text-secondary/40 shrink-0" />;
}

export function JobRoomPage() {
  const { token } = useParams<{ token: string }>();
  const [room, setRoom] = useState<JobRoom | null | undefined>(undefined);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = async () => {
      const data = await fetchJobRoom(token);
      if (!cancelled) setRoom(data);
    };
    load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [token]);

  useEffect(() => {
    if (!room) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(minutesRemaining(room.eta_minutes, room.eta_set_at));
    tick();
    const interval = setInterval(tick, 30000);
    return () => clearInterval(interval);
  }, [room]);

  const hasLocation = room && room.technician_lat !== null && room.technician_lng !== null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-2xl">
          {room === undefined && <p className="py-20 text-center text-sm text-text-secondary">Loading…</p>}

          {room === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Service room not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This link isn't valid, or the service room isn't turned on for this business yet.
                Please call the business directly for an update.
              </p>
            </div>
          )}

          {room && (
            <div className="space-y-5">
              {/* Header card */}
              <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium text-text-secondary">{room.business_name ?? 'Your service'}</p>
                <h1 className="mt-1 text-xl font-bold text-text-primary">Your Service Room</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  {room.service_type ?? 'Service visit'} for {room.customer_name}
                </p>
              </div>

              {/* Timeline */}
              <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <ol className="space-y-3">
                  {buildJobRoomTimeline(room).map((s) => (
                    <li key={s.label} className="flex items-center gap-3">
                      <TimelineIcon state={s.state} />
                      <span className={s.state === 'pending' ? 'text-sm text-text-secondary/70' : 'text-sm font-medium text-text-primary'}>
                        {s.label}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              {/* ETA */}
              {room.job_status === 'en_route' && remaining !== null && (
                <div className="flex items-center gap-4 rounded-2xl border border-accent/30 bg-accent/5 p-5">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
                    <Clock size={22} />
                  </span>
                  <div>
                    <p className="text-2xl font-bold text-text-primary">{remaining > 0 ? `${remaining} min` : 'Arriving now'}</p>
                    <p className="text-xs text-text-secondary">Estimated time of arrival</p>
                  </div>
                </div>
              )}

              {hasLocation && (
                <div className="overflow-hidden rounded-2xl border border-border">
                  <iframe
                    title="Technician location"
                    className="h-56 w-full"
                    loading="lazy"
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${room.technician_lng! - 0.02}%2C${room.technician_lat! - 0.02}%2C${room.technician_lng! + 0.02}%2C${room.technician_lat! + 0.02}&layer=mapnik&marker=${room.technician_lat}%2C${room.technician_lng}`}
                  />
                  <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-text-secondary">
                    <MapPin size={11} /> Updates automatically
                  </p>
                </div>
              )}

              {/* Technician */}
              {room.technician_name && (
                <div className="flex items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                    <User size={18} />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{room.technician_name}</p>
                    <p className="text-xs text-text-secondary">{room.technician_role ?? 'Technician'}</p>
                  </div>
                </div>
              )}

              {/* Diagnosis */}
              {room.diagnosis_notes && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary"><Stethoscope size={13} /> Diagnosis</p>
                  <p className="text-sm leading-relaxed text-text-primary whitespace-pre-line">{room.diagnosis_notes}</p>
                </div>
              )}

              {/* Quote / approval */}
              {room.quote && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-semibold text-text-secondary">Quote</p>
                    <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium capitalize text-text-primary">{room.quote.status}</span>
                  </div>
                  <ul className="mb-3 space-y-1.5">
                    {room.quote.line_items.map((li, i) => (
                      <li key={i} className="flex justify-between text-sm text-text-primary">
                        <span>{li.description} {li.quantity > 1 ? `× ${li.quantity}` : ''}</span>
                        <span>{formatCents(li.unit_price_cents * li.quantity)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-between border-t border-border pt-3">
                    <span className="text-sm font-semibold text-text-primary">Total</span>
                    <span className="text-sm font-bold text-text-primary">{formatCents(quoteTotalCents(room.quote))}</span>
                  </div>
                  {room.quote.status === 'sent' && (
                    
                      href={`${window.location.origin}/quote/${room.quote.quote_token}`}
                      className="focus-ring mt-4 block rounded-lg bg-accent py-2.5 text-center text-sm font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      Review &amp; approve
                    </a>
                  )}
                </div>
              )}

              {/* Photos */}
              {(room.before_photos.length > 0 || room.after_photos.length > 0) && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <p className="mb-3 text-xs font-semibold text-text-secondary">Before &amp; after</p>
                  <div className="grid grid-cols-2 gap-3">
                    {room.before_photos.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[11px] text-text-secondary">Before</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {room.before_photos.map((p) => (
                            <img key={p} src={jobRoomPhotoUrl(p)} alt="Before" className="aspect-square w-full rounded-lg object-cover" />
                          ))}
                        </div>
                      </div>
                    )}
                    {room.after_photos.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[11px] text-text-secondary">After</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {room.after_photos.map((p) => (
                            <img key={p} src={jobRoomPhotoUrl(p)} alt="After" className="aspect-square w-full rounded-lg object-cover" />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Work performed */}
              {room.work_performed_notes && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary"><Wrench size={13} /> Work performed</p>
                  <p className="text-sm leading-relaxed text-text-primary whitespace-pre-line">{room.work_performed_notes}</p>
                </div>
              )}

              {/* Invoice */}
              <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary"><FileText size={13} /> Invoice</p>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-primary capitalize">{room.invoice_status.replace('_', ' ')}</span>
                  <span className="text-sm font-bold text-text-primary">{formatAmount(room.invoice_amount)}</span>
                </div>
                {room.invoice_status === 'sent' && room.payment_link_url && (
                  
                    href={room.payment_link_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-ring mt-4 block rounded-lg bg-accent py-2.5 text-center text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    Pay now
                  </a>
                )}
              </div>

              {/* Warranty */}
              {room.warranty && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary"><ShieldCheck size={13} /> Warranty</p>
                  <p className="text-sm text-text-primary">
                    {room.warranty.make ? `${room.warranty.make} ` : ''}{room.warranty.model ?? room.warranty.equipment_type}
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">{formatWarrantyStatus(room.warranty.warranty_expires_at).label}</p>
                </div>
              )}

              {/* Next maintenance */}
              {room.next_maintenance_date && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <p className="text-xs font-semibold text-text-secondary">Next recommended maintenance</p>
                  <p className="mt-1 text-sm font-medium text-text-primary">{formatPortalDate(room.next_maintenance_date)}</p>
                </div>
              )}

              {/* Documents */}
              {room.documents.length > 0 && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                  <p className="mb-2 text-xs font-semibold text-text-secondary">Documents</p>
                  <ul className="space-y-1.5">
                    {room.documents.map((d) => (
                      <li key={d.url}>
                        <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent hover:underline">
                          {d.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
