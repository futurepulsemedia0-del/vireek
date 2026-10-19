import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { getConnection, timeAgo, useCanManageQuickBooks, useQboOwnerId, type QboConnection } from '@/lib/quickbooks';

/** Status + shortcut for the QuickBooks sync, shown inside the QuickBooks card on Integrations. */
export function QuickBooksPanel() {
  const canManage = useCanManageQuickBooks();
  const ownerId = useQboOwnerId();
  const [conn, setConn] = useState<QboConnection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canManage || !ownerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    getConnection(ownerId)
      .then((c) => !cancelled && setConn(c))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [canManage, ownerId]);

  if (!canManage) return null;
  const connected = !!conn && conn.status !== 'disconnected';
  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-sm text-text-secondary">
        {loading ? <Loader2 size={14} className="inline animate-spin" /> : !connected ? 'Not connected. Two-way sync of customers, invoices, payments, items and accounts.' : conn.status === 'error' ? 'Needs to be reconnected.' : `${conn.company_name ?? 'Connected'} · last synced ${timeAgo(conn.last_synced_at)}`}
      </p>
      <Link to="/dashboard/quickbooks" className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
        {connected ? 'Open QuickBooks sync' : 'Set up QuickBooks sync'} <ArrowRight size={14} />
      </Link>
    </div>
  );
}
