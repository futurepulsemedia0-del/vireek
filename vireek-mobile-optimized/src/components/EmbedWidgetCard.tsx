import { useState } from 'react';
import { motion } from 'framer-motion';
import { Code2, Copy, Check, ExternalLink } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export function EmbedWidgetCard() {
  const { profile } = useAuth();
  const [copied, setCopied] = useState(false);

  const companyParam = profile?.company_name ? `&business=${encodeURIComponent(profile.company_name)}` : '';
  const badgeUrl = `https://vireek.com/badge?ref=${profile?.external_id ?? profile?.id ?? ''}${companyParam}`;

  const snippet = `<iframe src="${badgeUrl}" width="240" height="44" style="border:none;overflow:hidden;" title="Always Answered by Vireek AI" loading="lazy"></iframe>`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — the textarea below still lets them select-all manually
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Code2 size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Trust Badge</h3>
          <p className="text-xs text-text-secondary">
            Put a live "Always Answered" badge on your own website — free marketing for you, and it links back to Vireek.
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center rounded-xl border border-border bg-bg-primary p-6">
        <iframe
          src={badgeUrl}
          width={240}
          height={44}
          style={{ border: 'none', overflow: 'hidden' }}
          title="Badge preview"
          loading="lazy"
        />
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-medium text-text-secondary">
          Paste this into your website's footer or homepage
        </label>
        <div className="relative">
          <textarea
            readOnly
            value={snippet}
            rows={2}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-primary px-3 py-2.5 pr-11 font-mono text-xs text-text-secondary"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="focus-ring absolute right-2 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Copy embed code"
          >
            {copied ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      <a
        href={badgeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
      >
        Open badge in new tab <ExternalLink size={12} />
      </a>
    </motion.div>
  );
}
