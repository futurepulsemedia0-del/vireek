import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Link2, Eraser, MapPinOff, ScanFace } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Switch } from '@/components/ui/Switch';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { HonestLimits } from '@/components/photoProvenance/HonestLimits';
import { PhotoStatusBadge } from '@/components/photoProvenance/PhotoStatusBadge';
import { PhotoCaptureButton } from '@/components/photoProvenance/PhotoCaptureButton';
import { RedactionDialog } from '@/components/photoProvenance/RedactionDialog';
import { summaryText, trustNotes, type PhotoCaptureView, type PhotoSettings, type PhotoSummary } from '@/lib/photoProvenance';
import {
  createShare, eraseCapture, fetchPhotoSummary, getPhotoSettings, listShares, purgeLocation, revokeShare, savePhotoSettings,
  type ShareRow,
} from '@/lib/photoProvenanceApi';

const fmt = (iso: string, language: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

function CaptureCard({
  c, language, selected, onSelect, onRedact, onPurge, onErase,
}: {
  c: PhotoCaptureView; language: string; selected: boolean; onSelect: (v: boolean) => void;
  onRedact: () => void; onPurge: () => void; onErase: () => void;
}) {
  const { t } = usePhotoProvenanceT();
  const notes = trustNotes(c);
  return (
    <li className="rounded-lg border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Checkbox label={t('panel.select')} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        <PhotoStatusBadge status={c.status} />
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div><dt className="text-text-secondary">{t('panel.received')}</dt><dd className="text-text-primary">{fmt(c.server_received_at, language)}</dd></div>
        <div>
          <dt className="text-text-secondary">{t('panel.deviceTime')} {t('panel.deviceTimeNote')}</dt>
          <dd className="text-text-primary">{c.device_captured_at ? fmt(c.device_captured_at, language) : '—'}</dd>
        </div>
        <div><dt className="text-text-secondary">{t('public.source')}</dt><dd className="text-text-primary">{t(`panel.source.${c.capture_source}`)}</dd></div>
        <div><dt className="text-text-secondary">{t('panel.fingerprint')}</dt><dd className="break-all font-mono text-text-primary">{c.original_sha256.slice(0, 16)}…</dd></div>
        {c.location.coordinates && (
          <div className="sm:col-span-2"><dt className="text-text-secondary">{t('panel.coordinates')}</dt><dd className="text-text-primary">{c.location.coordinates.latitude}, {c.location.coordinates.longitude}</dd></div>
        )}
      </dl>
      <ul className="mt-2 list-disc space-y-0.5 ps-5 text-xs text-text-secondary">
        {notes.map((n) => <li key={n}>{t(n)}</li>)}
      </ul>
      {c.derivatives.length > 0 && (
        <p className="mt-2 text-xs text-text-secondary">
          {t('panel.derivatives')}:{' '}
          {c.derivatives.map((d) => `${t(`panel.derivative.${d.kind}`)} (${d.verified ? t('panel.verified') : t('panel.notVerified')})`).join(' · ')}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!c.files_erased && !c.erasure_requested && (
          <Button size="xs" variant="secondary" onClick={onRedact}><ScanFace size={14} aria-hidden="true" />{t('panel.redact')}</Button>
        )}
        {c.location.status === 'recorded' && (
          <Button size="xs" variant="secondary" onClick={onPurge}><MapPinOff size={14} aria-hidden="true" />{t('panel.purgeLocation')}</Button>
        )}
        {!c.files_erased && (
          <Button size="xs" variant="danger" onClick={onErase}><Eraser size={14} aria-hidden="true" />{t('panel.erase')}</Button>
        )}
        {c.files_erased && <span className="text-xs text-text-secondary">{t('panel.erased')}</span>}
      </div>
    </li>
  );
}

export function PhotoProvenancePanel({ jobId, originalPathFor }: { jobId: string; originalPathFor?: (sha: string, mime: string, ownerId: string) => string }) {
  const { t, language } = usePhotoProvenanceT();
  const { toast } = useToast();
  const [summary, setSummary] = useState<PhotoSummary | null>(null);
  const [settings, setSettings] = useState<PhotoSettings | null>(null);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [redactFor, setRedactFor] = useState<PhotoCaptureView | null>(null);
  const [eraseFor, setEraseFor] = useState<PhotoCaptureView | null>(null);
  const [ttl, setTtl] = useState(30);
  const [label, setLabel] = useState('');
  const [newLink, setNewLink] = useState<string | null>(null);
  const [form, setForm] = useState({ capture_location: false, location_retention_days: 90, photo_retention_days: 1095 });
  const [ownerId, setOwnerId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(false);
      const [s, st] = await Promise.all([fetchPhotoSummary(jobId), getPhotoSettings()]);
      setSummary(s);
      setSettings(st);
      if (st) setForm({ capture_location: st.capture_location, location_retention_days: st.location_retention_days, photo_retention_days: st.photo_retention_days });
      if (st?.can_manage) setShares(await listShares(jobId));
    } catch {
      setError(true);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void import('@/lib/photoProvenanceApi').then((m) => m.getOwnerId()).then(setOwnerId).catch(() => setOwnerId(null)); }, []);

  const captures = summary?.captures ?? [];
  const canManage = settings?.can_manage === true;
  const pathOf = useMemo(() => (c: PhotoCaptureView): string | null => {
    if (!ownerId) return null;
    return originalPathFor ? originalPathFor(c.original_sha256, c.original_mime, ownerId) : `${ownerId}/${jobId}/photo/${c.original_sha256}.${({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' } as Record<string, string>)[c.original_mime] ?? 'jpg'}`;
  }, [ownerId, jobId, originalPathFor]);

  async function copy(text: string, okMessage: string) {
    try { await navigator.clipboard.writeText(text); toast(okMessage, 'success'); } catch { toast(text, 'info', { sticky: true }); }
  }

  async function makeLink() {
    if (!selected.size) { toast(t('share.chooseOne'), 'warning'); return; }
    try {
      const r = await createShare({ jobId, captureIds: [...selected], ttlDays: ttl, label: label || undefined });
      setNewLink(r.url);
      setLabel('');
      setShares(await listShares(jobId));
    } catch { toast(t('panel.error'), 'error'); }
  }

  return (
    <section aria-labelledby="pp-title" className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pp-title" className="text-sm font-semibold text-text-primary">{t('panel.title')}</h3>
        <PhotoCaptureButton jobId={jobId} onSaved={() => void load()} />
      </div>

      {!summary && !error && <p className="text-xs text-text-secondary" role="status">{t('panel.loading')}</p>}
      {error && <p className="text-xs text-danger" role="alert">{t('panel.error')}</p>}
      {summary && captures.length === 0 && <p className="text-xs text-text-secondary">{t('panel.empty')}</p>}

      {captures.length > 0 && (
        <>
          <p className="text-xs text-text-secondary">
            {summaryText(captures, t as unknown as (k: string, o?: Record<string, unknown>) => string, (i) => fmt(i, language)).split('\n')[1]}
          </p>
          <ul className="space-y-2">
            {captures.map((c) => (
              <CaptureCard
                key={c.id} c={c} language={language} selected={selected.has(c.id)}
                onSelect={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(c.id); else n.delete(c.id); return n; })}
                onRedact={() => setRedactFor(c)}
                onPurge={() => { void purgeLocation(c.id).then(() => load()).catch(() => toast(t('panel.error'), 'error')); }}
                onErase={() => setEraseFor(c)}
              />
            ))}
          </ul>
          <Button size="xs" variant="secondary" onClick={() => void copy(summaryText(captures, t as unknown as (k: string, o?: Record<string, unknown>) => string, (i) => fmt(i, language)), t('summary.copied'))}>
            <Copy size={14} aria-hidden="true" />{t('summary.copy')}
          </Button>
        </>
      )}

      <HonestLimits />

      {canManage && captures.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3">
          <h4 className="text-sm font-semibold text-text-primary">{t('share.title')}</h4>
          <p className="text-xs text-text-secondary">{t('share.help')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-text-secondary">
              {t('share.days')}
              <input type="number" min={1} max={365} value={ttl} onChange={(e) => setTtl(Math.min(365, Math.max(1, Number(e.target.value) || 30)))}
                className="focus-ring ms-2 w-20 rounded-md border border-border bg-bg-primary px-2 py-1 text-text-primary" />
            </label>
            <label className="text-xs text-text-secondary">
              {t('share.label')}
              <input type="text" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)}
                className="focus-ring ms-2 w-48 rounded-md border border-border bg-bg-primary px-2 py-1 text-text-primary" />
            </label>
            <Button size="xs" onClick={() => void makeLink()}><Link2 size={14} aria-hidden="true" />{t('share.create')}</Button>
          </div>
          {newLink && (
            <div role="status" className="rounded-md border border-success-500/30 bg-success-500/5 p-2 text-xs text-text-primary">
              <p>{t('share.created')}</p>
              <p className="mt-1 break-all font-mono">{newLink}</p>
              <Button size="xs" variant="secondary" className="mt-1" onClick={() => void copy(newLink, t('share.copied'))}><Copy size={14} aria-hidden="true" />{t('share.copy')}</Button>
            </div>
          )}
          {shares.length === 0 ? <p className="text-xs text-text-secondary">{t('share.none')}</p> : (
            <ul className="space-y-1">
              {shares.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
                  <span>{s.label ?? s.id.slice(0, 8)} · {t('share.expires', { date: fmt(s.expires_at, language) })} · {t('share.views', { count: s.view_count })}</span>
                  {s.revoked_at ? <span>{t('share.revoked')}</span> : (
                    <Button size="xs" variant="ghost" onClick={() => void revokeShare(s.id).then(() => listShares(jobId).then(setShares)).catch(() => toast(t('panel.error'), 'error'))}>{t('share.revoke')}</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage && (
        <div className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3">
          <h4 className="text-sm font-semibold text-text-primary">{t('settings.title')}</h4>
          <Switch
            checked={form.capture_location}
            onChange={(v) => setForm((f) => ({ ...f, capture_location: v }))}
            label={t('settings.location')}
            hint={t('settings.locationHelp')}
            disabled={!settings?.consent_required_configured}
            disabledReason={t('settings.consentMissing')}
          />
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-text-secondary">{t('settings.locationDays')}
              <input type="number" min={1} max={365} value={form.location_retention_days}
                onChange={(e) => setForm((f) => ({ ...f, location_retention_days: Math.min(365, Math.max(1, Number(e.target.value) || 90)) }))}
                className="focus-ring ms-2 w-20 rounded-md border border-border bg-bg-primary px-2 py-1 text-text-primary" />
            </label>
            <label className="text-xs text-text-secondary">{t('settings.photoDays')}
              <input type="number" min={30} max={3650} value={form.photo_retention_days}
                onChange={(e) => setForm((f) => ({ ...f, photo_retention_days: Math.min(3650, Math.max(30, Number(e.target.value) || 1095)) }))}
                className="focus-ring ms-2 w-24 rounded-md border border-border bg-bg-primary px-2 py-1 text-text-primary" />
            </label>
          </div>
          <p className="text-xs text-warning-500">{t('settings.counsel')}</p>
          <Button size="xs" onClick={() => void savePhotoSettings(form).then((s) => { setSettings(s); toast(t('settings.saved'), 'success'); }).catch(() => toast(t('panel.error'), 'error'))}>{t('settings.save')}</Button>
        </div>
      )}

      {redactFor && pathOf(redactFor) && (
        <RedactionDialog
          open jobId={jobId} captureId={redactFor.id} originalSha256={redactFor.original_sha256} originalPath={pathOf(redactFor)!}
          onClose={() => setRedactFor(null)} onSaved={() => void load()}
        />
      )}
      <ConfirmDialog
        open={!!eraseFor}
        title={t('panel.erase')}
        description={t('panel.eraseConfirm')}
        confirmLabel={t('panel.erase')}
        recoverable={false}
        onCancel={() => setEraseFor(null)}
        onConfirm={async () => {
          if (!eraseFor) return;
          try { await eraseCapture(eraseFor.id); await load(); } catch { toast(t('panel.error'), 'error'); }
          setEraseFor(null);
        }}
      />
    </section>
  );
}
