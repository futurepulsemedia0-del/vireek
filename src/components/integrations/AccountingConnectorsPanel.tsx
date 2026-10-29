import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { PROVIDER_META, PROVIDER_SLUG, getConnection, timeAgo, useAcctOwnerId, useCanManageAccounting, type AcctConnection, type AcctProvider } from '@/lib/accounting';

/** Status + shortcut for one accounting connector (Xero, Zoho Books, NetSuite), shown inside its card on Integrations. */
export function AccountingConnectorsPanel({ provider }: { provider: AcctProvider }) {
  const canManage = useCanManageAccounting();
  const ownerId = useAcctOwnerId();
  const [conn, setConn] = useState<AcctConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const label = PROVIDER_META[provider].label;

  useEffect(() => {
    if (!canManage || !ownerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    getConnection(ownerId, provider)
      .then((c) => !cancelled && setConn(c))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [canManage, ownerId, provider]);

  if (!canManage) return null;
  const connected = !!conn && conn.status !== 'disconnected';
  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-sm text-text-secondary">
        {loading ? <Loader2 size={14} className="inline animate-spin" /> : !connected ? `Not connected. Two-way sync of customers, invoices, payments, items and accounts with ${label}.` : conn.status === 'error' ? 'Needs to be reconnected.' : `${conn.company_name ?? 'Connected'} · last synced ${timeAgo(conn.last_synced_at)}`}
      </p>
      <Link to={`/dashboard/accounting/${PROVIDER_SLUG[provider]}`} className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
        {connected ? `Open ${label} sync` : `Set up ${label} sync`} <ArrowRight size={14} />
      </Link>
    </div>
  );
}
