import { useCallback, useEffect, useState } from 'react';
import { Download, LogOut, Trash2 } from 'lucide-react';
import { useHomeowner } from '@/contexts/HomeownerAuthContext';
import { deleteAccount, exportMyData, fetchConsentHistory, revokeLink, updateSettings } from '@/lib/homeowner/api';
import { formatDateTime, scopeSummary } from '@/lib/homeowner/format';
import type { ConsentEvent } from '@/lib/homeowner/types';
import { getPublicOrigin } from '@/lib/appOrigin';
import { Badge, Card, ErrorNote, PrimaryButton, SecondaryButton } from './ui';

const EVENT_LABELS: Record<string, string> = {
  discovered: 'Providers found for your number',
  linked: 'Provider added by link',
  scopes_updated: 'Sharing choices saved',
  revoked: 'Access revoked',
  settings_updated: 'Settings changed',
  export: 'Data export downloaded',
  service_request: 'Service request sent',
};

async function saveJson(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2);
  const file = new File([json], filename, { type: 'application/json' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Vireek Home data' });
      return;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HomePrivacyPage() {
  const { overview, refresh, signOut } = useHomeowner();
  const profile = overview?.profile;
  const [name, setName] = useState(profile?.full_name ?? '');
  const [history, setHistory] = useState<ConsentEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const origin = getPublicOrigin();

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await fetchConsentHistory());
    } catch {
      /* the history list is non-critical */
    }
  }, []);
  useEffect(() => void loadHistory(), [loadHistory]);
  useEffect(() => setName(profile?.full_name ?? ''), [profile?.full_name]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const active = (overview?.businesses ?? []).filter((b) => b.status === 'active');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">Privacy & data</h1>
        <p className="text-sm text-text-secondary">You control what each provider’s data shows in this app.</p>
      </header>
      {error && <ErrorNote message={error} />}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Your details</h2>
        <p className="text-xs text-text-secondary">Signed in as {profile?.phone}</p>
        <label htmlFor="priv-name" className="block text-xs font-medium text-text-secondary">Name</label>
        <div className="flex gap-2">
          <input
            id="priv-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
          />
          <SecondaryButton
            busy={busy === 'name'}
            disabled={name.trim() === (profile?.full_name ?? '')}
            onClick={() => void run('name', async () => { await updateSettings({ fullName: name }); await refresh(); setNotice('Saved.'); })}
          >
            Save
          </SecondaryButton>
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">AI home assistant</h2>
            <p className="text-xs text-text-secondary">Lets the assistant read what you’ve shared to answer questions. Nothing is stored.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={profile?.ai_enabled ?? false}
            aria-label="AI home assistant"
            disabled={busy === 'ai'}
            onClick={() => void run('ai', async () => { await updateSettings({ aiEnabled: !(profile?.ai_enabled ?? false) }); await refresh(); await loadHistory(); })}
            className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition ${profile?.ai_enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}
          >
            <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${profile?.ai_enabled ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Who can see what</h2>
        {active.length === 0 && <p className="text-xs text-text-secondary">You aren’t sharing anything with any provider.</p>}
        <ul className="divide-y divide-border">
          {active.map((b) => (
            <li key={b.link_id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{b.business_name}</p>
                <p className="text-xs text-text-secondary">{scopeSummary(b.scopes)}</p>
              </div>
              <SecondaryButton
                busy={busy === b.link_id}
                className="min-h-[36px] px-3 py-1.5 text-xs text-danger"
                onClick={() => void run(b.link_id, async () => { await revokeLink(b.link_id); await refresh(); await loadHistory(); setNotice(`Access revoked for ${b.business_name}.`); })}
              >
                Revoke
              </SecondaryButton>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Activity</h2>
        {history.length === 0 ? (
          <p className="text-xs text-text-secondary">Nothing yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text-primary">{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                <span className="shrink-0 text-text-secondary">{formatDateTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Your data</h2>
        <p className="text-xs text-text-secondary">
          Download a copy of your account, sharing choices, activity, requests and what providers currently share with you.
        </p>
        <SecondaryButton
          busy={busy === 'export'}
          onClick={() => void run('export', async () => {
            await saveJson(`vireek-home-data-${new Date().toISOString().slice(0, 10)}.json`, await exportMyData());
            await loadHistory();
          })}
        >
          <Download size={16} aria-hidden /> Download my data
        </SecondaryButton>
        <p className="text-xs text-text-secondary">
          Providers keep their own customer records. To ask a provider’s platform to access, correct or delete those, use the{' '}
          <a className="underline" href={`${origin}/data-request`} target="_blank" rel="noreferrer">data request page</a>.
        </p>
      </Card>

      <Card className="space-y-3">
        <SecondaryButton onClick={() => void signOut()}><LogOut size={16} aria-hidden /> Sign out</SecondaryButton>
        {!showDelete ? (
          <SecondaryButton className="text-danger" onClick={() => setShowDelete(true)}><Trash2 size={16} aria-hidden /> Delete my account</SecondaryButton>
        ) : (
          <div className="space-y-2 rounded-xl border border-danger/30 bg-danger/10 p-3">
            <p className="text-sm text-text-primary">
              This permanently deletes your Vireek Home account, sharing choices and uploaded photos. It can’t be undone.
              Type <Badge tone="bad">DELETE</Badge> to confirm.
            </p>
            <input
              aria-label="Type DELETE to confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
            />
            <div className="flex gap-2">
              <PrimaryButton
                className="bg-danger hover:bg-danger"
                busy={busy === 'delete'}
                disabled={confirmText !== 'DELETE'}
                onClick={() => void run('delete', deleteAccount)}
              >
                Delete account
              </PrimaryButton>
              <SecondaryButton onClick={() => { setShowDelete(false); setConfirmText(''); }}>Cancel</SecondaryButton>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
