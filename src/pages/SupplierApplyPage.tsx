import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { applyAsSupplier, errorMessage } from '@/lib/procurementNetworkApi';

const fieldClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
const list = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean);

/** /supplier-portal/apply - any signed-in user can apply; Vireek staff approve before programs can open. */
export function SupplierApplyPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', legalName: '', contactName: '', contactEmail: '', phone: '', website: '', description: '', regions: '', categories: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await applyAsSupplier({ ...f, regions: list(f.regions), categories: list(f.categories) });
      toast('Application submitted. We will review it shortly.', 'success');
      navigate('/supplier-portal', { replace: true });
    } catch (err) {
      toast(errorMessage(err, 'Could not submit the application'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-primary px-4 py-10">
      <form onSubmit={(e) => void submit(e)} className="mx-auto max-w-2xl space-y-4 rounded-2xl border border-border bg-bg-secondary p-6">
        <h1 className="text-2xl font-bold text-text-primary">Become a Procurement Network supplier</h1>
        <p className="text-sm text-text-secondary">
          Reach pooled buying power from home-service businesses. After approval (business details, W-9 and insurance verification) you can publish your catalog and group programs.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-text-secondary">Company name *<input required minLength={2} maxLength={120} className={`${fieldClass} mt-1`} value={f.name} onChange={set('name')} /></label>
          <label className="text-sm text-text-secondary">Legal entity name<input maxLength={160} className={`${fieldClass} mt-1`} value={f.legalName} onChange={set('legalName')} /></label>
          <label className="text-sm text-text-secondary">Contact name<input maxLength={120} className={`${fieldClass} mt-1`} value={f.contactName} onChange={set('contactName')} /></label>
          <label className="text-sm text-text-secondary">Contact email *<input required type="email" className={`${fieldClass} mt-1`} value={f.contactEmail} onChange={set('contactEmail')} /></label>
          <label className="text-sm text-text-secondary">Phone<input maxLength={40} className={`${fieldClass} mt-1`} value={f.phone} onChange={set('phone')} /></label>
          <label className="text-sm text-text-secondary">Website<input maxLength={200} className={`${fieldClass} mt-1`} value={f.website} onChange={set('website')} /></label>
          <label className="text-sm text-text-secondary">Regions served (comma separated)<input className={`${fieldClass} mt-1`} value={f.regions} onChange={set('regions')} placeholder="TX, OK, LA" /></label>
          <label className="text-sm text-text-secondary">Categories (comma separated)<input className={`${fieldClass} mt-1`} value={f.categories} onChange={set('categories')} placeholder="HVAC parts, filters" /></label>
        </div>
        <label className="block text-sm text-text-secondary">About your company<textarea rows={4} maxLength={2000} className={`${fieldClass} mt-1`} value={f.description} onChange={set('description')} /></label>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />} Submit application
          </Button>
        </div>
      </form>
    </div>
  );
}
