import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { NOT_LIVE_VERIFIED_LABEL, getConnection, timeAgo, useCanManageIntacct, useIntacctOwnerId, type IaConnection } from '@/lib/sageIntacct';

/** Status + shortcut for the Sage Intacct sync, shown inside a Sage Intacct card on Integrations (optional). */
export function SageIntacctPanel() {
  const canManage = useCanManageIntacct();
  const ownerId = useIntacctOwnerId();
  const [conn, setConn] = useState<IaConnection | null>(null);
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
        {loading ? <Loader2 size={14} className="inline animate-spin" /> : !connected ? `Not connected. Two-way sync of customers, invoices, payments and GL accounts. ${NOT_LIVE_VERIFIED_LABEL}.` : conn.status === 'error' ? 'Needs to be reconnected.' : `${conn.company_name ?? conn.company_id} · last synced ${timeAgo(conn.last_synced_at)}`}
      </p>
      <Link to="/dashboard/sage-intacct" className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
        {connected ? 'Open Sage Intacct sync' : 'Set up Sage Intacct sync'} <ArrowRight size={14} />
      </Link>
    </div>
  );
}
