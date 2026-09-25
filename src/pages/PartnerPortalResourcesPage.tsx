import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { PartnerPortalLayout } from '@/components/partner-portal/PartnerPortalLayout';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({
    title: 'Sales Resources — Vireek Partner Portal',
    description: 'Pitch copy, objection handling and email templates for Vireek partners.',
    canonical: 'https://vireek.com/partner-portal/resources',
  });
  return null;
}

const ONE_PAGER = `Vireek is an AI phone agent for home-service businesses (HVAC, plumbing, electrical, roofing, restoration and similar trades) that answers every call — day or night — in the business's own voice, qualifies the caller, quotes from their real price book, and books the job straight onto the dispatch board. Built for owner-operators and small teams who already get steady call volume but lose jobs to voicemail, not businesses that need leads generated for them.`;

const OBJECTIONS: { objection: string; response: string }[] = [
  {
    objection: '"I already have an answering service."',
    response: 'Most answering services take a message — Sarah books the job, quotes a price when possible, and puts it on the dispatch board immediately, with no callback delay.',
  },
  {
    objection: '"My customers won\'t want to talk to an AI."',
    response: "Most callers don't realize it's not a person until told, and the alternative most businesses are comparing against is voicemail — which converts at close to zero.",
  },
  {
    objection: '"It sounds expensive."',
    response: 'Frame it against the cost of ONE missed emergency call, not against doing nothing — check current plan pricing at vireek.com/pricing before quoting a number.',
  },
  {
    objection: '"I don\'t have time to set it up."',
    response: 'Most businesses are live the same day — forwarding an existing number takes a few minutes and doesn\'t require a new number or hardware.',
  },
];

const EMAIL_TEMPLATES: { title: string; body: string }[] = [
  {
    title: 'Cold intro',
    body: `Subject: Missing calls while you're on jobs?\n\nHi {{first_name}},\n\nQuick question — when you're mid-job and the phone rings, what happens to that call right now?\n\nI work with Vireek, an AI phone agent built for trades businesses like yours. It answers every call in your own voice, qualifies the caller, and books the job straight onto a dispatch board — so you stop losing jobs to voicemail.\n\nWorth a quick look? Happy to send a link.\n\n{{your_name}}`,
  },
  {
    title: 'Warm follow-up (existing contact)',
    body: `Subject: The tool I mentioned — Vireek\n\nHey {{first_name}},\n\nFollowing up on what I mentioned — here's my link to check out Vireek: {{referral_link}}\n\nIt's the AI phone agent I've been telling contractors about — answers calls you'd otherwise miss and books the job automatically. Setup is same-day.\n\nLet me know what you think.\n\n{{your_name}}`,
  },
];

function CopyBlock({ text, small }: { text: string; small?: boolean }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast('Copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy — select and copy manually', 'error');
    }
  };
  return (
    <div className="relative">
      <pre className={`whitespace-pre-wrap rounded-xl border border-border bg-bg-primary p-4 font-sans text-text-secondary ${small ? 'text-xs' : 'text-sm'}`}>
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="focus-ring absolute right-2.5 top-2.5 flex items-center gap-1 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function PartnerPortalResourcesPage() {
  return (
    <PartnerPortalLayout>
      <SEO />
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Sales & Marketing Resources</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Approved messaging to use when you pitch Vireek. Always check /pricing for current numbers before quoting a price.
      </p>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-text-primary">One-pager pitch</h2>
        <div className="mt-3">
          <CopyBlock text={ONE_PAGER} />
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-text-primary">Objection handling</h2>
        <div className="mt-4 space-y-4">
          {OBJECTIONS.map((o) => (
            <div key={o.objection} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
              <p className="text-sm font-medium text-text-primary">{o.objection}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{o.response}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-text-primary">Email templates</h2>
        <div className="mt-4 space-y-5">
          {EMAIL_TEMPLATES.map((t) => (
            <div key={t.title}>
              <p className="mb-2 text-sm font-medium text-text-primary">{t.title}</p>
              <CopyBlock text={t.body} small />
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-text-secondary">
          Replace {'{{referral_link}}'} with your link from the Overview tab before sending.
        </p>
      </Card>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-text-primary">Brand assets</h2>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          Logo files and brand guidelines: see the{' '}
          <a href="/brand" className="font-semibold text-accent hover:text-accent/80">Brand Guidelines page</a>. Use
          the Vireek name and logo as shown there — do not modify the logo or imply an exclusive/official partnership
          beyond what your agreement covers.
        </p>
      </Card>
    </PartnerPortalLayout>
  );
}
