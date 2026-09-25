import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, MousePointerClick, Users, TrendingUp, Wallet, GraduationCap, Clock3 } from 'lucide-react';
import { PartnerPortalLayout } from '@/components/partner-portal/PartnerPortalLayout';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import { buildReferralLink, formatCents, PARTNER_STATUS_LABELS, type PartnerDashboardStats } from '@/lib/partnerPortal';

function SEO() {
  useSEO({
    title: 'Partner Dashboard — Vireek',
    description: 'Your Vireek partner referral link, click and conversion stats, and commission owed.',
    canonical: 'https://vireek.com/partner-portal',
  });
  return null;
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <Card className="flex items-center gap-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
        <Icon size={20} />
      </span>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
        <p className="mt-0.5 text-xl font-bold text-text-primary">{value}</p>
      </div>
    </Card>
  );
}

export function PartnerPortalDashboardPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<PartnerDashboardStats | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase.rpc('get_partner_dashboard_stats').then(({ data, error }) => {
      if (!error) setStats(data as PartnerDashboardStats);
    });
  }, [user]);

  if (!stats) {
    return (
      <PartnerPortalLayout>
        <SEO />
        <div className="flex justify-center py-24">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      </PartnerPortalLayout>
    );
  }

  const partner = stats.partner;
  const link = partner ? buildReferralLink(partner.referral_code) : '';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast('Referral link copied', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy — copy it manually', 'error');
    }
  };

  return (
    <PartnerPortalLayout>
      <SEO />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Overview</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {partner?.company_name} · {partner ? PARTNER_STATUS_LABELS[partner.status] : ''}
          </p>
        </div>
      </div>

      {partner?.status === 'pending' && (
        <Card className="mt-6 flex items-start gap-3 border-accent/30 bg-accent/5">
          <Clock3 size={18} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-text-secondary">
            Your application is still under review — your referral link isn't live yet, but you can already work
            through <Link to="/partner-portal/certification" className="font-semibold text-accent">certification</Link> and
            browse <Link to="/partner-portal/resources" className="font-semibold text-accent">sales resources</Link>.
          </p>
        </Card>
      )}

      {partner?.status === 'approved' && (
        <Card className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Your referral link</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={link}
              onClick={(e) => e.currentTarget.select()}
              className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
            />
            <button
              type="button"
              onClick={copyLink}
              className="focus-ring flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            {partner.commission_rate}% commission on every business that signs up and stays active — credited automatically, no self-reporting needed.
          </p>
        </Card>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={MousePointerClick} label="Link clicks" value={String(stats.total_clicks ?? 0)} />
        <StatCard icon={Users} label="Referrals" value={String(stats.total_referrals ?? 0)} />
        <StatCard icon={TrendingUp} label="Converted" value={String(stats.converted_referrals ?? 0)} />
        <StatCard icon={Wallet} label="Pending commission" value={formatCents(stats.pending_commission_cents ?? 0)} />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">Commission paid to date</p>
            <p className="mt-1 text-2xl font-bold text-text-primary">{formatCents(stats.paid_commission_cents ?? 0)}</p>
          </div>
          <Link to="/partner-portal/referrals" className="focus-ring shrink-0 text-sm font-semibold text-accent hover:text-accent/80">
            View referrals →
          </Link>
        </Card>
        <Card className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
              <GraduationCap size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">Certification</p>
              <p className="text-sm text-text-secondary">{stats.is_certified ? 'Certified' : 'Not yet certified'}</p>
            </div>
          </div>
          <Link
            to={stats.is_certified ? '/partner-portal/certificate' : '/partner-portal/certification'}
            className="focus-ring shrink-0 text-sm font-semibold text-accent hover:text-accent/80"
          >
            {stats.is_certified ? 'View certificate →' : 'Get certified →'}
          </Link>
        </Card>
      </div>
    </PartnerPortalLayout>
  );
}
