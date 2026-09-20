import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import QRCode from 'qrcode';
import { CalendarClock, Copy, Check, ExternalLink } from 'lucide-react';

interface BookingLinkCardProps {
  slug: string;
  enabled: boolean;
  onSlugChange: (slug: string) => void;
  onEnabledChange: (enabled: boolean) => void;
}

export function BookingLinkCard({ slug, enabled, onSlugChange, onEnabledChange }: BookingLinkCardProps) {
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const bookingUrl = slug ? `${window.location.origin}/book/${slug}` : '';
  const embedSnippet = slug ? `<iframe src="${bookingUrl}?embed=1&src=website" width="420" height="640" style="border:none;" title="Book an appointment"></iframe>` : '';

  useEffect(() => {
    if (!bookingUrl) { setQrDataUrl(''); return; }
    QRCode.toDataURL(bookingUrl, { width: 220, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(''));
  }, [bookingUrl]);

  const handleCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable */ }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><CalendarClock size={18} /></span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Online Booking</h3>
          <p className="text-xs text-text-secondary">One link customers use to book themselves — website, Google Business Profile, Instagram/WhatsApp bio, a text message, or a printed QR code.</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-text-primary">Enable online booking</p>
        <button type="button" role="switch" aria-checked={enabled} onClick={() => onEnabledChange(!enabled)} className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-medium text-text-secondary">Your booking link</label>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2.5">
          <span className="text-xs text-text-secondary">{window.location.origin}/book/</span>
          <input value={slug} onChange={(e) => onSlugChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="your-business-name" className="flex-1 bg-transparent text-sm text-text-primary focus:outline-none" />
        </div>
      </div>

      {slug && (
        <>
          <div className="mt-4 flex items-center gap-2">
            <button type="button" onClick={() => handleCopy(bookingUrl)} className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
              {copied ? <Check size={14} /> : <Copy size={14} />} Copy link
            </button>
            <a href={bookingUrl} target="_blank" rel="noreferrer" className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
              <ExternalLink size={14} /> Preview
            </a>
          </div>
          {qrDataUrl && (
            <div className="mt-4 flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-primary p-4">
              <img src={qrDataUrl} alt="Booking QR code" width={160} height={160} />
              <p className="text-xs text-text-secondary">Scan to book — print this on invoices, trucks, or flyers.</p>
            </div>
          )}
          <div className="mt-4">
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">Embed on your website</label>
            <textarea readOnly value={embedSnippet} rows={2} onClick={(e) => (e.target as HTMLTextAreaElement).select()} className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-primary px-3 py-2.5 font-mono text-xs text-text-secondary" />
          </div>
          <p className="mt-3 text-xs text-text-secondary/70">For Google Business Profile: paste this link into your listing's "Booking link" field. For Instagram/WhatsApp: put it in your bio or send it directly.</p>
        </>
      )}
    </motion.div>
  );
}
