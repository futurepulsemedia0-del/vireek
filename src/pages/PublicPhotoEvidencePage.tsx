/**
 * Public verification of shareable photo evidence — /verify/photo/:token
 *
 * No login. Reads only integrity facts through verify_evidence_photo_share(): fingerprints, server/device times,
 * capture-source flags, location ACCURACY class (never coordinates), derived-copy fingerprints. No customer, address,
 * technician or image data. A visitor can also check a file locally: its SHA-256 is computed in the browser and never uploaded.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { HonestLimits } from '@/components/photoProvenance/HonestLimits';
import { PhotoStatusBadge } from '@/components/photoProvenance/PhotoStatusBadge';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import { fetchPublicShare, type PublicShare } from '@/lib/photoProvenanceApi';
import { matchFileHash, sha256Hex, trustNotes } from '@/lib/photoProvenance';

type CheckResult = { kind: 'working' } | { kind: 'original'; id: string } | { kind: 'copy'; id: string; copy: string } | { kind: 'none' } | null;

export function PublicPhotoEvidencePage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t, language } = usePhotoProvenanceT();
  const [result, setResult] = useState<PublicShare | null>(null);
  const [failed, setFailed] = useState(false);
  const [check, setCheck] = useState<CheckResult>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fmt = (iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'medium' });

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setFailed(false);
    fetchPublicShare(token)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [token]);

  async function onFile(file: File) {
    if (!result || !result.found || result.state !== 'active') return;
    setCheck({ kind: 'working' });
    const match = matchFileHash(await sha256Hex(file), result.captures);
    if (!match) setCheck({ kind: 'none' });
    else if (match.as === 'original') setCheck({ kind: 'original', id: match.shortId });
    else setCheck({ kind: 'copy', id: match.shortId, copy: t(`panel.derivative.${match.as}`) });
  }

  const problem =
    failed ? { title: t('public.notFound'), body: t('public.error') }
    : result && !result.found ? { title: t('public.notFound'), body: t('public.notFoundBody') }
    : result && result.found && result.state === 'expired' ? { title: t('public.expired'), body: t('public.expiredBody') }
    : result && result.found && result.state === 'revoked' ? { title: t('public.revoked'), body: t('public.revokedBody') }
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-8">
        <h1 className="text-2xl font-bold text-text-primary">{t('public.title')}</h1>
        <p className="text-sm text-text-secondary">{t('public.intro')}</p>

        {!result && !failed && <p role="status" className="text-sm text-text-secondary">{t('public.loading')}</p>}

        {problem && (
          <Card interactive={false} role="alert" className="p-4">
            <p className="flex items-center gap-2 font-semibold text-text-primary"><AlertCircle size={18} className="text-danger" aria-hidden="true" />{problem.title}</p>
            <p className="mt-1 text-sm text-text-secondary">{problem.body}</p>
          </Card>
        )}

        {result && result.found && result.state === 'active' && (
          <>
            <Card interactive={false} className="p-4">
              <p className={`flex items-center gap-2 text-sm font-semibold ${result.chain_valid ? 'text-success-500' : 'text-danger'}`} role={result.chain_valid ? 'status' : 'alert'}>
                {result.chain_valid ? <ShieldCheck size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
                {result.chain_valid ? t('public.chainOk') : t('public.chainBroken')}
              </p>
              <p className="mt-1 text-xs text-text-secondary">{t('public.issued', { date: fmt(result.issued_at) })} · {t('public.validUntil', { date: fmt(result.expires_at) })}</p>
            </Card>

            <ul className="space-y-3">
              {result.captures.map((c) => (
                <li key={c.id}>
                  <Card interactive={false} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-text-primary">{t('public.photo', { id: c.short_id })}</h2>
                      <PhotoStatusBadge status={c.status} />
                    </div>
                    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                      <div><dt className="text-text-secondary">{t('public.received')}</dt><dd className="text-text-primary">{fmt(c.server_received_at)}</dd></div>
                      <div><dt className="text-text-secondary">{t('public.device')} {t('panel.deviceTimeNote')}</dt><dd className="text-text-primary">{c.device_captured_at ? fmt(c.device_captured_at) : '—'}</dd></div>
                      <div><dt className="text-text-secondary">{t('public.source')}</dt><dd className="text-text-primary">{t(`panel.source.${c.capture_source}`)}</dd></div>
                      <div>
                        <dt className="text-text-secondary">{t('public.location')}</dt>
                        <dd className="text-text-primary">
                          {c.location.status === 'recorded' && c.location.accuracy_m !== null
                            ? t('public.locationRecorded', { meters: c.location.accuracy_m, class: t(`public.accuracyClass.${c.location.accuracy_class}`) })
                            : t('public.locationNone')}
                        </dd>
                      </div>
                      <div className="sm:col-span-2"><dt className="text-text-secondary">{t('public.original')}</dt><dd className="break-all font-mono text-text-primary">{c.original_sha256}</dd></div>
                    </dl>
                    {c.derivatives.length > 0 && (
                      <div className="mt-2 text-xs">
                        <p className="text-text-secondary">{t('public.copies')}</p>
                        <ul className="mt-1 space-y-1">
                          {c.derivatives.map((d) => (
                            <li key={d.id} className="break-all text-text-primary">
                              {t(`panel.derivative.${d.kind}`)}{d.modified ? ` (${t('public.modifiedCopy')})` : ''}: <span className="font-mono">{d.sha256}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <ul className="mt-2 list-disc space-y-0.5 ps-5 text-xs text-text-secondary">
                      {trustNotes(c).map((n) => <li key={n}>{t(n)}</li>)}
                    </ul>
                  </Card>
                </li>
              ))}
            </ul>

            <Card interactive={false} className="p-4">
              <h2 className="text-sm font-semibold text-text-primary">{t('public.checkTitle')}</h2>
              <p className="mt-1 text-xs text-text-secondary">{t('public.checkHelp')}</p>
              <input ref={fileInput} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }} />
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => fileInput.current?.click()}>{t('public.checkButton')}</Button>
              <p className="mt-2 text-sm text-text-primary" role="status" aria-live="polite">
                {check?.kind === 'working' && t('public.checkWorking')}
                {check?.kind === 'original' && t('public.checkMatchOriginal', { id: check.id })}
                {check?.kind === 'copy' && t('public.checkMatchCopy', { kind: check.copy, id: check.id })}
                {check?.kind === 'none' && t('public.checkNoMatch')}
              </p>
            </Card>

            <HonestLimits />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
