import { useState } from 'react';
import QRCode from 'qrcode';
import { CreditCard, ExternalLink, Loader2, MessageSquare } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { createPaymentRequest } from '@/lib/payments';

interface Props {
  jobId: string;
  invoiceAmount: number | null;
  customerPhone: string | null;
}

export function CollectPaymentPanel({ jobId, invoiceAmount, customerPhone }: Props) {
  const { toast } = useToast();
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!invoiceAmount || invoiceAmount <= 0) {
    return (
      <section className="rounded-lg border border-border bg-bg-secondary p-3">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Collect payment</h2>
        <p className="text-sm text-text-secondary">Set an invoice amount on this job to collect payment.</p>
      </section>
    );
  }

  async function prepare() {
    setBusy(true);
    try {
      const result = await createPaymentRequest({ job_id: jobId, collected_via: 'technician' });
      setLink(result.payment_link_url);
      setQr(await QRCode.toDataURL(result.payment_link_url, { width: 240, margin: 1 }));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not prepare the payment', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function textLink() {
    if (!customerPhone) return toast('No customer phone number on this job', 'error');
    setBusy(true);
    try {
      await createPaymentRequest({ job_id: jobId, collected_via: 'technician', send_link: true, customer_phone: customerPhone });
      toast('Payment link texted to the customer', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the link', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-accent/30 bg-accent/5 p-3">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><CreditCard className="h-4 w-4" /> Collect payment · ${invoiceAmount.toFixed(2)}</h2>
      <p className="mb-3 text-xs text-text-secondary">The customer can add a tip when they pay. Tips go to you through payroll.</p>
      {!link ? (
        <button type="button" onClick={prepare} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Get payment link
        </button>
      ) : (
        <div className="space-y-3">
          {qr && <img src={qr} alt="Scan to pay" width={240} height={240} className="mx-auto rounded-lg bg-white p-2" />}
          <a href={link} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-white">
            <ExternalLink className="h-4 w-4" /> Hand device to customer
          </a>
          <button type="button" onClick={textLink} disabled={busy || !customerPhone} className="flex w-full items-center justify-center gap-2 rounded-lg border border-border py-2.5 text-sm font-medium text-text-primary disabled:opacity-50">
            <MessageSquare className="h-4 w-4" /> Text link to customer
          </button>
        </div>
      )}
    </section>
  );
}
