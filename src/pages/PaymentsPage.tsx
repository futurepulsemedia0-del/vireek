import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CreditCard, Send, Loader as Loader2, ExternalLink, CircleCheck, TriangleAlert as AlertTriangle, Copy } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { supabase, Job } from '@/lib/supabase';
import {
  fetchPaymentRequests,
  fetchConnectStatus,
  startStripeConnectOnboarding,
  createPaymentRequest,
  PAYMENT_STATUS_META,
  type PaymentRequest,
  type StripeConnectStatus,
} from '@/lib/payments';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

function formatMoney(amount: number) {
  return `$${amount.toFixed(2)}`;
}

function StatusBadge({ status }: { status: PaymentRequest['status'] }) {
  const meta = PAYMENT_STATUS_META[status];
  const toneClass = {
    neutral: 'bg-bg-tertiary text-text-secondary border-border',
    accent: 'bg-accent/10 text-accent border-accent/25',
    success: 'bg-success/10 text-success border-success/25',
    danger: 'bg-danger/10 text-danger border-danger/25',
  }[meta.tone];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClass}`}>{meta.label}</span>;
}

export function PaymentsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [connect, setConnect] = useState<StripeConnectStatus | null>(null);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const [job, setJob] = useState<Job | null>(null);
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [connectStatus, paymentRequests] = await Promise.all([fetchConnectStatus(), fetchPaymentRequests()]);
        setConnect(connectStatus);
        setRequests(paymentRequests);
      } catch {
        toast('Could not load payment data — try refreshing', 'error');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stripeParam = searchParams.get('stripe');
    if (stripeParam === 'connected') toast('Stripe account connected', 'success');
    const jobId = searchParams.get('job');
    if (!jobId) return;
    supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setJob(data as Job);
          setCustomerPhone((data as Job).customer_phone ?? '');
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const collected = requests.filter((r) => r.status === 'paid').reduce((sum, r) => sum + Number(r.amount), 0);
    const outstanding = requests.filter((r) => r.status === 'sent' || r.status === 'overdue').reduce((sum, r) => sum + Number(r.amount), 0);
    const overdue = requests.filter((r) => r.status === 'overdue').length;
    return { collected, outstanding, overdue };
  }, [requests]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const url = await startStripeConnectOnboarding();
      window.location.href = url;
    } catch {
      toast('Could not start Stripe onboarding — try again', 'error');
      setConnecting(false);
    }
  }

  async function handleCreateRequest() {
    if (!job) return;
    if (!customerEmail.trim() && !customerPhone.trim()) {
      toast('Add an email or phone number for the customer', 'error');
      return;
    }
    setCreating(true);
    try {
      const result = await createPaymentRequest({
        job_id: job.id,
        customer_email: customerEmail.trim() || undefined,
        customer_phone: customerPhone.trim() || undefined,
      });
      toast('Payment request sent', 'success');
      setJob(null);
      searchParams.delete('job');
      setSearchParams(searchParams, { replace: true });
      const refreshed = await fetchPaymentRequests();
      setRequests(refreshed);
      void result;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the payment request', 'error');
    } finally {
      setCreating(false);
    }
  }

  function copyLink(url: string) {
    navigator.clipboard.writeText(url).then(() => toast('Payment link copied', 'success'));
  }

  const connected = !!connect?.charges_enabled;

  return (
    <DashboardLayout activeLabel="Payments">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Smart Payment Collection</h1>
          <p className="mt-1 text-sm text-text-secondary">Send secure payment links for completed jobs and get paid faster.</p>
        </div>

        {/* Connect status */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${connected ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-secondary'}`}>
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-text-primary">{connected ? 'Stripe connected' : 'Connect Stripe to get paid'}</p>
                <p className="text-sm text-text-secondary">
                  {connected
                    ? 'Payments go straight to your bank account.'
                    : 'Payment requests are disabled until your account is connected and verified.'}
                </p>
              </div>
            </div>
            {!connected && (
              <Button variant="primary" size="sm" onClick={handleConnect} disabled={connecting}>
                {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {connecting ? 'Redirecting…' : connect?.stripe_account_id ? 'Finish Verification' : 'Connect Stripe'}
              </Button>
            )}
          </div>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card><p className="text-sm text-text-secondary">Total Collected</p><p className="mt-1 text-2xl font-bold text-text-primary">{formatMoney(stats.collected)}</p></Card>
          <Card><p className="text-sm text-text-secondary">Outstanding</p><p className="mt-1 text-2xl font-bold text-text-primary">{formatMoney(stats.outstanding)}</p></Card>
          <Card><p className="text-sm text-text-secondary">Overdue</p><p className="mt-1 text-2xl font-bold text-danger">{stats.overdue}</p></Card>
        </div>

        {/* New request panel (opened via ?job=<id> from Jobs) */}
        {job && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <Card>
              <h2 className="mb-1 font-semibold text-text-primary">Send payment request</h2>
              <p className="mb-4 text-sm text-text-secondary">
                {job.customer_name} — {formatMoney(Number(job.invoice_amount ?? 0))}
              </p>
              {!connected ? (
                <p className="flex items-center gap-2 rounded-lg border border-warning-500/25 bg-warning-500/10 px-3 py-2 text-sm text-warning-500">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> Connect Stripe above before sending payment requests.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <input className={inputClass} placeholder="Customer phone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
                  <input className={inputClass} placeholder="Customer email (optional)" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
                </div>
              )}
              <div className="mt-4 flex gap-2">
                <Button variant="primary" size="sm" onClick={handleCreateRequest} disabled={creating || !connected}>
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {creating ? 'Sending…' : 'Send Payment Request'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setJob(null)}>Cancel</Button>
              </div>
            </Card>
          </motion.div>
        )}

        {/* List */}
        <Card className="!p-0 overflow-hidden">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
          ) : requests.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-text-secondary">
              No payment requests yet — open a completed job and click &ldquo;Send Payment Request&rdquo;.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                  <div>
                    <p className="font-medium text-text-primary">{r.customer_name}</p>
                    <p className="text-sm text-text-secondary">{formatMoney(Number(r.amount))} · {new Date(r.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    {r.status === 'paid' && <CircleCheck className="h-4 w-4 text-success" />}
                    {r.payment_link_url && r.status !== 'paid' && (
                      <>
                        <button onClick={() => copyLink(r.payment_link_url!)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" title="Copy link">
                          <Copy className="h-4 w-4" />
                        </button>
                        <a href={r.payment_link_url} target="_blank" rel="noreferrer" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary" title="Open link">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}
