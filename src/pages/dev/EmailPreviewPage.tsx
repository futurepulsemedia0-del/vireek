// Developer-only gallery for every branded email (dev tool: English strings by design, not shipped UI).
// Enabled in `vite dev`, or in a build with VITE_ENABLE_EMAIL_PREVIEW=true. Otherwise the route renders nothing.

import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { PREVIEW_SAMPLES } from '../../../supabase/functions/_shared/email-kit/previewSamples';

const ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_EMAIL_PREVIEW === 'true';
const LOCALES = ['en', 'fa', 'de'] as const;
const selectClass = 'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export function EmailPreviewPage() {
  const { toast } = useToast();
  const [id, setId] = useState(PREVIEW_SAMPLES[0].id);
  const [locale, setLocale] = useState<(typeof LOCALES)[number]>('en');
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const [sending, setSending] = useState(false);

  const sample = PREVIEW_SAMPLES.find((s) => s.id === id) ?? PREVIEW_SAMPLES[0];
  const mail = useMemo(() => sample.render(locale, window.location.origin), [sample, locale]);
  // Force the iframe's colour scheme so the dark palette can be reviewed without changing the OS theme.
  const srcDoc = useMemo(
    () => mail.html.replace('<head>', `<head><style>:root{color-scheme:${scheme}}</style>`).replace(/@media \(prefers-color-scheme:dark\)/g, scheme === 'dark' ? '@media all' : '@media not all'),
    [mail, scheme],
  );

  if (!ENABLED) return <Navigate to="/" replace />;

  const sendToSelf = async () => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('email-preview-send', { body: { sampleId: id, locale } });
      if (error) throw error;
      toast(data?.sent ? 'Sent to your own address.' : 'Nothing was sent.', data?.sent ? 'success' : 'error');
    } catch {
      toast('Could not send. Is ENABLE_EMAIL_PREVIEW_SEND=true on the function?', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold text-text-primary">Email previews</h1>
      <p className="mt-1 text-sm text-text-secondary">Rendered by the same code the edge functions use. Subject: <strong>{mail.subject}</strong></p>
      <div className="my-4 flex flex-wrap items-end gap-3">
        <label className="text-sm text-text-secondary">Template
          <select className={`${selectClass} mt-1 block`} value={id} onChange={(e) => setId(e.target.value)}>
            {PREVIEW_SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-text-secondary">Locale
          <select className={`${selectClass} mt-1 block`} value={locale} onChange={(e) => setLocale(e.target.value as (typeof LOCALES)[number])}>
            {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="text-sm text-text-secondary">Scheme
          <select className={`${selectClass} mt-1 block`} value={scheme} onChange={(e) => setScheme(e.target.value as 'light' | 'dark')}>
            <option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={() => setTab(tab === 'html' ? 'text' : 'html')}>{tab === 'html' ? 'Show plain text' : 'Show HTML'}</Button>
        <Button size="sm" onClick={() => void sendToSelf()} disabled={sending}>{sending ? 'Sending…' : 'Send to myself'}</Button>
      </div>
      {tab === 'html' ? (
        <iframe title="Email preview" sandbox="" srcDoc={srcDoc} className="h-[720px] w-full rounded-2xl border border-border bg-bg-secondary" />
      ) : (
        <pre className="whitespace-pre-wrap rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-primary">{mail.text}</pre>
      )}
    </main>
  );
}

export default EmailPreviewPage;
