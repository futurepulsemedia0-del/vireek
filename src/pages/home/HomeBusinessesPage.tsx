import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useHomeowner } from '@/contexts/HomeownerAuthContext';
import { linkByPortalLink, revokeLink, setSharing } from '@/lib/homeowner/api';
import { SCOPE_META, scopeSummary } from '@/lib/homeowner/format';
import { SCOPE_KEYS, type OverviewBusiness, type ShareScopes } from '@/lib/homeowner/types';
import { Badge, Card, ErrorNote, PrimaryButton, SecondaryButton } from './ui';

const NONE: ShareScopes = { jobs: false, invoices: false, equipment: false, documents: false, health: false };

function SharingEditor({
  business,
  onDone,
  onCancel,
}: {
  business: OverviewBusiness;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [scopes, setScopes] = useState<ShareScopes>(business.status === 'active' ? business.scopes : NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setSharing(business.link_id, scopes);
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <p className="text-xs text-text-secondary">
        Choose what <strong>{business.business_name}</strong> data appears in your app. You can change or revoke this any time.
      </p>
      {SCOPE_KEYS.map((key) => (
        <label key={key} className="flex min-h-[44px] items-start gap-3">
          <input
            type="checkbox"
            checked={scopes[key]}
            onChange={(e) => setScopes((s) => ({ ...s, [key]: e.target.checked }))}
            className="focus-ring mt-1 h-5 w-5 accent-[rgb(var(--accent-primary))]"
          />
          <span>
            <span className="block text-sm font-medium text-text-primary">{SCOPE_META[key].label}</span>
            <span className="block text-xs text-text-secondary">{SCOPE_META[key].description}</span>
          </span>
        </label>
      ))}
      {error && <ErrorNote message={error} />}
      <div className="flex gap-2">
        <PrimaryButton busy={busy} onClick={() => void save()} className="flex-1">
          {business.status === 'active' ? 'Save' : 'Connect'}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
      </div>
    </div>
  );
}

export function HomeBusinessesPage() {
  const { overview, refresh } = useHomeowner();
  const businesses = overview?.businesses ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = {
    pending: businesses.filter((b) => b.status === 'pending'),
    active: businesses.filter((b) => b.status === 'active'),
    revoked: businesses.filter((b) => b.status === 'revoked'),
  };

  const done = async () => {
    setEditing(null);
    await refresh();
  };

  const revoke = async (id: string) => {
    if (confirmRevoke !== id) {
      setConfirmRevoke(id);
      return;
    }
    setError(null);
    try {
      await revokeLink(id);
      setConfirmRevoke(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke access.');
    }
  };

  const addByLink = async () => {
    setLinkBusy(true);
    setLinkMsg(null);
    try {
      const id = await linkByPortalLink(linkInput);
      if (id) {
        setLinkMsg({ ok: true, text: 'Found it. Review it below to choose what to share.' });
        setLinkInput('');
        await refresh();
        setEditing(id);
      } else {
        setLinkMsg({ ok: false, text: 'That link isn’t valid, or the business hasn’t enabled the customer portal.' });
      }
    } catch (err) {
      setLinkMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not add that link.' });
    } finally {
      setLinkBusy(false);
    }
  };

  const renderCard = (b: OverviewBusiness) => (
    <li key={b.link_id}>
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold text-text-primary">{b.business_name}</p>
            {b.status === 'active' && <p className="text-xs text-text-secondary">{scopeSummary(b.scopes)}</p>}
            {b.status === 'active' && !b.live && <p className="text-xs text-warning-500">This provider has paused its customer portal.</p>}
          </div>
          <Badge tone={b.status === 'active' ? 'good' : b.status === 'pending' ? 'accent' : 'neutral'}>
            {b.status === 'active' ? 'Connected' : b.status === 'pending' ? 'Waiting for you' : 'Revoked'}
          </Badge>
        </div>

        {editing === b.link_id ? (
          <SharingEditor business={b} onDone={done} onCancel={() => setEditing(null)} />
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {b.status === 'pending' && <PrimaryButton onClick={() => setEditing(b.link_id)}>Review & connect</PrimaryButton>}
            {b.status === 'active' && (
              <>
                <SecondaryButton onClick={() => setEditing(b.link_id)}>Manage sharing</SecondaryButton>
                <SecondaryButton onClick={() => void revoke(b.link_id)} className="text-danger">
                  {confirmRevoke === b.link_id ? 'Tap again to revoke' : 'Revoke access'}
                </SecondaryButton>
              </>
            )}
            {b.status === 'revoked' && <SecondaryButton onClick={() => setEditing(b.link_id)}>Reconnect</SecondaryButton>}
            {b.status === 'pending' && (
              <SecondaryButton onClick={() => void revoke(b.link_id)}>
                {confirmRevoke === b.link_id ? 'Tap again to decline' : 'Not me / decline'}
              </SecondaryButton>
            )}
          </div>
        )}
      </Card>
    </li>
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">Providers</h1>
        <p className="text-sm text-text-secondary">
          You decide what each provider’s data shows in this app. See your full history in{' '}
          <Link to="/home/privacy" className="font-medium text-accent underline">Privacy</Link>.
        </p>
      </header>

      {error && <ErrorNote message={error} />}

      {groups.pending.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Waiting for your approval</h2>
          <ul className="space-y-3">{groups.pending.map(renderCard)}</ul>
        </div>
      )}
      {groups.active.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Connected</h2>
          <ul className="space-y-3">{groups.active.map(renderCard)}</ul>
        </div>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-text-primary">Add a provider with a link</h2>
        <p className="mt-1 text-xs text-text-secondary">Paste the customer-portal link a business sent you.</p>
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Portal link"
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            placeholder="https://…/portal/…"
            className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
          />
          <PrimaryButton busy={linkBusy} disabled={!linkInput.trim()} onClick={() => void addByLink()}>Add</PrimaryButton>
        </div>
        {linkMsg && (linkMsg.ok ? <p className="mt-2 text-xs text-success">{linkMsg.text}</p> : <div className="mt-2"><ErrorNote message={linkMsg.text} /></div>)}
      </Card>

      {groups.revoked.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Revoked</h2>
          <ul className="space-y-3">{groups.revoked.map(renderCard)}</ul>
        </div>
      )}

      {businesses.length === 0 && (
        <p className="text-center text-sm text-text-secondary">
          No provider has your number on file yet. Ask your provider to enable the customer portal, then paste their link above.
        </p>
      )}
    </div>
  );
}
